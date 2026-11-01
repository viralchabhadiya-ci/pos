import { createHash } from "node:crypto";
import cors from "@fastify/cors";
import { CashMoveSchema, DisplayRelay, DisplayStateSchema, OrderBatchSchema, SessionCloseSchema, SessionOpenSchema, type OrderSync } from "@pos/core";
import { encodeDrawerKick, encodeReceipt, type ReceiptDoc } from "@pos/escpos";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { Cloud, CloudOffline, type CloudResponse } from "./cloud.js";
import type { HubConfig } from "./config.js";
import { sendToPrinter } from "./printer.js";
import { HubStore, type DeviceRow, type DeviceSetup, type LocalOrder, type OutboxKind } from "./store.js";

/**
 * The store hub runs on one PC in the shop. Tills talk to it instead of the cloud: while
 * the internet is up it forwards everything, and while it is down it accepts the tills'
 * work into its own queue, answers lookups across tills from what it has seen, and
 * forwards the queue in order once the cloud is back. It also drives the LAN printer
 * and cash drawer.
 */

class HubError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const CATALOG_OVERLAP_MS = 5_000;
/** A queued item the cloud keeps failing on with a 5xx is set aside after this many tries. */
const MAX_SERVER_ERRORS = 10;

const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional(),
  trn: z.string().max(20).optional(),
});

const BlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    align: z.enum(["left", "center", "right"]).optional(),
    bold: z.boolean().optional(),
    double: z.boolean().optional(),
  }),
  z.object({ type: z.literal("row"), left: z.string(), right: z.string(), bold: z.boolean().optional() }),
  z.object({ type: z.literal("rule") }),
  z.object({ type: z.literal("feed"), lines: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal("barcode"), data: z.string().min(1).max(60) }),
  z.object({ type: z.literal("qr"), data: z.string().min(1).max(500) }),
]);

const PrintSchema = z.object({
  doc: z.object({ blocks: z.array(BlockSchema).max(500), cut: z.boolean().optional(), openDrawer: z.boolean().optional() }),
  copies: z.number().int().min(1).max(3).optional(),
});

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface Hub {
  app: FastifyInstance;
  store: HubStore;
  cloud: Cloud;
  /** Sends queued work to the cloud, oldest first. Returns how many items left the queue. */
  flush(): Promise<number>;
  /** Pulls catalog changes for every store tenant the hub knows. */
  refreshCatalogs(): Promise<void>;
  start(): void;
  close(): Promise<void>;
}

export async function buildHub(config: HubConfig, opts: { logger?: boolean; store?: HubStore } = {}): Promise<Hub> {
  const store = opts.store ?? new HubStore(config.dataDir);
  const cloud = new Cloud(config.cloudUrl);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // Work that talks to the queue runs one at a time, so a till's items reach the cloud
  // in the order the till sent them, whether they went direct or through the queue.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  function bearer(req: FastifyRequest): string | null {
    const header = req.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /** The device behind a request. A device the hub has never seen is checked with the cloud once. */
  async function device(req: FastifyRequest): Promise<DeviceRow> {
    const token = bearer(req);
    if (!token) throw new HubError(401, "unauthorized", "Missing device token");
    const tokenHash = hashToken(token);
    const known = store.getDevice(tokenHash);
    if (known) return known;
    if (!cloud.shouldTry()) throw unknownDevice();
    let res: CloudResponse;
    try {
      res = await cloud.call("GET", "/device/setup", { token });
    } catch (err) {
      if (err instanceof CloudOffline) throw unknownDevice();
      throw err;
    }
    if (res.status !== 200) throw new HubError(res.status, res.data.error ?? "unauthorized", res.data.message ?? "Unknown device");
    store.putDevice(tokenHash, token, res.data as DeviceSetup);
    return store.getDevice(tokenHash)!;
  }

  function unknownDevice() {
    return new HubError(401, "unknown_device", "The hub has not seen this till yet. Connect it once while the internet is up.");
  }

  /** Tries the cloud. Returns null when it is unreachable; a 401 also forgets the device. */
  async function tryCloud(method: string, path: string, dev: DeviceRow | null, body?: unknown): Promise<CloudResponse | null> {
    if (!cloud.shouldTry()) return null;
    try {
      const res = await cloud.call(method, path, { token: dev?.token, body });
      if (res.status === 401 && dev) store.removeDevice(dev.tokenHash);
      return res;
    } catch (err) {
      if (err instanceof CloudOffline) return null;
      throw err;
    }
  }

  function applySessionOpen(dev: DeviceRow, s: z.infer<typeof SessionOpenSchema>) {
    store.updateRegisterSetups(dev.registerId, (setup) => ({
      ...setup,
      lastSessionSeq: Math.max(setup.lastSessionSeq, s.seq),
      openSession: { id: s.id, seq: s.seq, openedBy: s.openedBy, openedAt: s.openedAt, openingCash: s.openingCash },
    }));
  }

  function applySessionClose(dev: DeviceRow, sessionId: string) {
    store.updateRegisterSetups(dev.registerId, (setup) =>
      setup.openSession?.id === sessionId ? { ...setup, openSession: null } : setup,
    );
  }

  /**
   * Accepts a write from a till. If nothing of this till's is waiting in the queue and the
   * cloud answers, the cloud's answer goes straight back. Otherwise the write joins the
   * queue and the till gets the queued answer; the hub now owns delivering it.
   */
  async function accept(
    dev: DeviceRow,
    kind: OutboxKind,
    path: string,
    body: unknown,
    effects: { onAccepted: (res: CloudResponse | null) => void; queued: () => unknown },
    reply: FastifyReply,
  ) {
    return serial(async () => {
      if (store.pendingCount(dev.tokenHash) === 0) {
        const res = await tryCloud("POST", path, dev, body);
        if (res && res.status < 500) {
          if (res.status < 300) effects.onAccepted(res);
          return reply.status(res.status).send(res.data);
        }
      }
      store.tx(() => {
        store.enqueue(dev.tokenHash, kind, path, body);
        effects.onAccepted(null);
      });
      return reply.status(200).send(effects.queued());
    });
  }

  function recordOrderResults(orders: OrderSync[], res: CloudResponse, path: string) {
    const results = (res.data?.results ?? []) as { id: string; status: string; error?: string; message?: string }[];
    for (const r of results) {
      if (r.status !== "rejected") continue;
      const order = orders.find((o) => o.id === r.id);
      store.reject("orders", r.id, path, order ?? {}, r.error ?? "rejected", r.message);
    }
  }

  // Health and hub status

  app.get("/health", async () => ({ ok: true, hub: true }));

  /** Unauthenticated so a till can find out whether its server is a hub. Holds no business data. */
  app.get("/hub/info", async () => ({
    hub: true,
    version: "0.1.0",
    cloudOnline: cloud.online,
    pending: store.pendingCount(),
    rejected: store.rejectedCount(),
    printer: config.printer ? { width: config.printer.width } : null,
  }));

  app.get("/hub/rejections", async (req) => {
    await device(req);
    return { rejections: store.rejections() };
  });

  // Printing and the cash drawer

  app.post("/hub/print", async (req, reply) => {
    await device(req);
    const { doc, copies } = PrintSchema.parse(req.body);
    if (!config.printer) throw new HubError(503, "no_printer", "No receipt printer is set up on the hub");
    const bytes = encodeReceipt(doc as ReceiptDoc, { width: config.printer.width });
    try {
      for (let i = 0; i < (copies ?? 1); i += 1) {
        // Only the first copy opens the drawer.
        await sendToPrinter(config.printer, i === 0 ? bytes : encodeReceipt({ ...(doc as ReceiptDoc), openDrawer: false }, { width: config.printer.width }));
      }
    } catch (err) {
      throw new HubError(502, "printer_error", (err as Error).message);
    }
    return reply.send({ ok: true });
  });

  /** The till asks for a manager PIN before calling this outside a cash sale. */
  app.post("/hub/drawer", async (req) => {
    const dev = await device(req);
    if (!config.printer) throw new HubError(503, "no_printer", "No printer (and so no drawer) is set up on the hub");
    try {
      await sendToPrinter(config.printer, encodeDrawerKick());
    } catch (err) {
      throw new HubError(502, "printer_error", (err as Error).message);
    }
    app.log.info({ device: dev.registerId }, "cash drawer opened");
    return { ok: true };
  });

  // Customer display: the till and its display both talk to the hub, so it works offline.

  const relay = new DisplayRelay();
  app.addHook("onClose", async () => relay.close());

  app.put("/display/state", async (req) => {
    const dev = await device(req);
    if (dev.setup.device?.role === "display") throw new HubError(403, "forbidden", "Only a till can update the customer display");
    const state = DisplayStateSchema.parse((req.body as { state?: unknown })?.state);
    return { version: relay.put(dev.registerId, state) };
  });

  app.get<{ Querystring: { after?: string; wait?: string } }>("/display/state", async (req) => {
    const dev = await device(req);
    const after = Math.max(0, Number(req.query.after) || 0);
    const wait = Math.min(25_000, Math.max(0, Number(req.query.wait ?? 20_000) || 0));
    return relay.get(dev.registerId, after, wait);
  });

  // Pairing goes to the cloud; the hub remembers the device it hands back.

  app.post("/pairing/claim", async (req, reply) => {
    const res = await tryCloud("POST", "/pairing/claim", null, req.body);
    if (!res) throw new HubError(503, "cloud_offline", "Pairing needs the internet. Try again when the store is online.");
    if (res.status === 200 && typeof res.data.token === "string") {
      const { token, ...setup } = res.data;
      store.putDevice(hashToken(token), token, setup as DeviceSetup);
    }
    return reply.status(res.status).send(res.data);
  });

  app.get("/device/setup", async (req, reply) => {
    const dev = await device(req);
    if (store.pendingCount(dev.tokenHash) === 0) {
      const res = await tryCloud("GET", "/device/setup", dev);
      if (res) {
        if (res.status === 200) store.putDevice(dev.tokenHash, dev.token, res.data);
        return reply.status(res.status).send(res.data);
      }
    }
    // The cached copy already reflects shifts opened or closed through the queue.
    return dev.setup;
  });

  app.get<{ Querystring: { since?: string } }>("/sync/catalog", async (req, reply) => {
    const dev = await device(req);
    const since = req.query.since;
    const res = await tryCloud("GET", `/sync/catalog${since ? `?since=${encodeURIComponent(since)}` : ""}`, dev);
    if (res) {
      if (res.status === 200) store.mergeCatalog(dev.tenantId, res.data);
      return reply.status(res.status).send(res.data);
    }
    if (!store.hasCatalog(dev.tenantId)) throw new HubError(503, "cloud_offline", "The hub has no copy of the catalog yet");
    return store.readCatalog(dev.tenantId, since);
  });

  // Writes from the tills

  app.post("/orders/batch", async (req, reply) => {
    const dev = await device(req);
    const { orders } = OrderBatchSchema.parse(req.body);
    const path = "/orders/batch";
    const fresh = orders.filter((o) => !store.hasOrder(o.id));
    if (fresh.length === 0 && (store.pendingCount(dev.tokenHash) > 0 || !cloud.shouldTry())) {
      // A retry of orders the hub already holds: nothing new to queue.
      return { results: orders.map((o) => ({ id: o.id, status: "duplicate", queued: true })) };
    }
    return accept(
      dev,
      "orders",
      path,
      { orders: fresh.length ? fresh : orders },
      {
        onAccepted: (res) => {
          for (const o of orders) store.putOrder(dev.tenantId, o);
          // The till saw the cloud's answer itself; the hub only hides refused orders from lookups.
          for (const r of (res?.data.results ?? []) as { id: string; status: string }[]) {
            if (r.status === "rejected") store.markOrderRejected(r.id);
          }
        },
        queued: () => ({
          results: orders.map((o) => ({ id: o.id, status: fresh.includes(o) ? "created" : "duplicate", queued: true })),
        }),
      },
      reply,
    );
  });

  app.post("/sessions/open", async (req, reply) => {
    const dev = await device(req);
    const body = SessionOpenSchema.parse(req.body);
    if (body.registerId !== dev.registerId) throw new HubError(400, "bad_request", "Session belongs to another register");
    return accept(
      dev,
      "session.open",
      "/sessions/open",
      body,
      {
        onAccepted: () => applySessionOpen(dev, body),
        queued: () => ({ sessionId: body.id, seq: body.seq, state: "open", openingCash: body.openingCash, queued: true }),
      },
      reply,
    );
  });

  app.post("/cash-moves", async (req, reply) => {
    const dev = await device(req);
    const body = CashMoveSchema.parse(req.body);
    return accept(dev, "cash.move", "/cash-moves", body, { onAccepted: () => {}, queued: () => ({ ok: true, queued: true }) }, reply);
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/close", async (req, reply) => {
    const dev = await device(req);
    const body = SessionCloseSchema.parse(req.body);
    const sessionId = z.string().uuid().parse(req.params.id);
    return accept(
      dev,
      "session.close",
      `/sessions/${sessionId}/close`,
      body,
      {
        onAccepted: () => applySessionClose(dev, sessionId),
        queued: () => ({ sessionId, state: "closed", closingCashCounted: body.closingCashCounted, queued: true }),
      },
      reply,
    );
  });

  app.post("/customers", async (req, reply) => {
    const dev = await device(req);
    const body = CustomerSchema.parse(req.body);
    return accept(
      dev,
      "customer",
      "/customers",
      body,
      { onAccepted: () => store.putCustomer(dev.tenantId, body), queued: () => ({ id: body.id, queued: true }) },
      reply,
    );
  });

  // Lookups across tills: the cloud's answer plus whatever is still waiting at the hub.

  app.get<{ Querystring: { number?: string } }>("/orders", async (req, reply) => {
    const dev = await device(req);
    const number = String(req.query.number ?? "").trim();
    if (!number) return { orders: [] };
    const local = store.findOrders(dev.tenantId, number).map((o) => ({
      id: o.id,
      number: o.number,
      total: o.total,
      created_at: o.createdAt,
    }));
    const res = await tryCloud("GET", `/orders?number=${encodeURIComponent(number)}`, dev);
    if (res && res.status !== 200) return reply.status(res.status).send(res.data);
    const remote = (res?.data.orders ?? []) as { id: string }[];
    return { orders: [...remote, ...local.filter((l) => !remote.some((r) => r.id === l.id))] };
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const dev = await device(req);
    const res = await tryCloud("GET", `/orders/${encodeURIComponent(req.params.id)}`, dev);
    if (res && res.status !== 404) return reply.status(res.status).send(res.data);
    const local = store.getOrder(dev.tenantId, req.params.id);
    if (!local) throw new HubError(404, "not_found", "Order not found");
    return localOrderView(local);
  });

  app.get<{ Querystring: { q?: string } }>("/customers", async (req, reply) => {
    const dev = await device(req);
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return { customers: [] };
    const local = store.searchCustomers(dev.tenantId, q) as { id: string }[];
    const res = await tryCloud("GET", `/customers?q=${encodeURIComponent(q)}`, dev);
    if (res && res.status !== 200) return reply.status(res.status).send(res.data);
    const remote = (res?.data.customers ?? []) as { id: string }[];
    return { customers: [...remote, ...local.filter((l) => !remote.some((r) => r.id === l.id))] };
  });

  // Anything else (reports, summaries) only makes sense with the cloud.

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    handler: async (req, reply) => {
      const token = bearer(req);
      if (!cloud.shouldTry()) throw new HubError(503, "cloud_offline", "This needs the internet; the store is offline right now");
      let res: CloudResponse;
      try {
        res = await cloud.call(req.method, req.url, { token: token ?? undefined, body: req.method === "GET" ? undefined : req.body });
      } catch (err) {
        if (err instanceof CloudOffline) throw new HubError(503, "cloud_offline", "This needs the internet; the store is offline right now");
        throw err;
      }
      return reply.status(res.status).send(res.data);
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HubError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong at the hub" });
  });

  async function flush(): Promise<number> {
    return serial(async () => {
      let sent = 0;
      for (;;) {
        const head = store.outboxHead();
        if (head.length === 0) return sent;
        for (const row of head) {
          const dev = store.getDevice(row.tokenHash);
          if (!dev) {
            store.tx(() => {
              store.reject(row.kind, refId(row.kind, row.body), row.path, row.body, "unknown_device", "The till was unpaired before this was sent");
              store.removeOutbox(row.seq);
            });
            continue;
          }
          let res: CloudResponse;
          try {
            res = await cloud.call("POST", row.path, { token: dev.token, body: row.body });
          } catch (err) {
            if (!(err instanceof CloudOffline)) throw err;
            store.noteAttempt(row.seq, err.message);
            return sent;
          }
          if (res.status >= 500 && row.attempts + 1 < MAX_SERVER_ERRORS) {
            store.noteAttempt(row.seq, `HTTP ${res.status}`);
            return sent;
          }
          store.tx(() => {
            if (res.status < 300) {
              if (row.kind === "orders") recordOrderResults((row.body as { orders: OrderSync[] }).orders, res, row.path);
            } else {
              if (res.status === 401) store.removeDevice(dev.tokenHash);
              const error = res.data.error ?? `http_${res.status}`;
              if (row.kind === "orders") {
                for (const o of (row.body as { orders: OrderSync[] }).orders) store.reject("orders", o.id, row.path, o, error, res.data.message);
              } else {
                store.reject(row.kind, refId(row.kind, row.body), row.path, row.body, error, res.data.message);
              }
            }
            store.removeOutbox(row.seq);
          });
          sent += 1;
        }
      }
    });
  }

  async function refreshCatalogs() {
    for (const t of store.tenantDevices()) {
      const last = store.catalogCloudTime(t.tenantId);
      const since = last ? new Date(Date.parse(last) - CATALOG_OVERLAP_MS).toISOString() : undefined;
      const dev = store.getDevice(t.tokenHash);
      const res = await tryCloud("GET", `/sync/catalog${since ? `?since=${encodeURIComponent(since)}` : ""}`, dev ?? null);
      if (res?.status === 200) store.mergeCatalog(t.tenantId, res.data, res.data.serverTime);
    }
  }

  const timers: NodeJS.Timeout[] = [];
  function start() {
    const safely = (fn: () => Promise<unknown>) => () => void fn().catch((err) => app.log.error(err));
    safely(refreshCatalogs)();
    timers.push(setInterval(safely(flush), config.flushIntervalMs));
    timers.push(setInterval(safely(refreshCatalogs), config.catalogIntervalMs));
  }

  async function close() {
    timers.forEach(clearInterval);
    await app.close();
    await chain;
    store.close();
  }

  return { app, store, cloud, flush, refreshCatalogs, start, close };
}

function refId(kind: OutboxKind, body: unknown): string | null {
  if (kind === "orders") return null;
  const b = body as { id?: string; sessionId?: string };
  return b.id ?? b.sessionId ?? null;
}

/** The cloud's /orders/:id shape (snake_case rows), built from what the till sent. */
function localOrderView(o: LocalOrder) {
  return {
    id: o.id,
    number: o.number,
    total: o.total,
    created_at: o.createdAt,
    refund_of_order_id: o.refundOfOrderId,
    pending_at_hub: true,
    lines: o.body.lines.map((l, i) => ({
      id: l.id,
      line_no: i + 1,
      variant_id: l.variantId,
      name: l.name,
      qty: l.qty,
      unit_price: l.unitPrice,
      discount_bp: l.discountBp,
      tax_id: l.taxId,
    })),
    payments: o.body.payments.map((p) => ({ id: p.id, method_id: p.methodId, kind: p.kind, amount: p.amount })),
  };
}
