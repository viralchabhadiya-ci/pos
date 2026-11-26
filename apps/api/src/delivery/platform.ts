import { randomUUID, timingSafeEqual } from "node:crypto";
import { priceOrder, type TaxRate } from "@pos/core";
import { z } from "zod";
import { withTx, type Db, type Tx } from "../db.js";
import { HttpError } from "../errors.js";
import { storeProducts, taxMap } from "../routes/shop.js";
import { deliverOptionsFromEnv, postWebhook, signPayload } from "../webhooks/deliver.js";

export const PROVIDERS = { talabat: "Talabat", deliveroo: "Deliveroo", careem: "Careem", noon: "Noon Food", other: "Other" } as const;
export type Provider = keyof typeof PROVIDERS;

/** How long a platform gives to accept an order when its message doesn't say. */
const DEFAULT_ACCEPT_MINUTES = 5;

export interface Channel {
  id: string;
  tenant_id: string;
  store_id: string;
  provider: Provider;
  name: string;
  external_store_id: string;
  secret: string;
  callback_url: string | null;
  active: boolean;
  auto_accept: boolean;
  prep_minutes: number;
  commission_bp: number;
  markup_bp: number;
  paused_until: Date | null;
}

const Money = z.number().int().min(0).max(100_000_000);

/**
 * What a platform (or the integration partner in between) sends. Amounts are in fils with VAT,
 * as the customer paid them. Items are matched by `posId` (our item id, which the menu we send
 * carries) or else by SKU.
 */
export const InboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("order.created"),
    order: z.object({
      id: z.string().trim().min(1).max(100),
      /** What the rider says at the counter. */
      code: z.string().trim().min(1).max(40),
      acceptBy: z.string().datetime({ offset: true }).optional(),
      customerName: z.string().trim().max(80).optional(),
      note: z.string().trim().max(500).optional(),
      items: z
        .array(
          z.object({
            posId: z.string().max(100).nullish(),
            sku: z.string().max(100).nullish(),
            name: z.string().trim().min(1).max(200),
            qty: z.number().int().positive().max(200),
            /** One item, without its extras. */
            price: Money,
            modifiers: z.array(z.object({ name: z.string().trim().min(1).max(100), price: Money.default(0) })).max(30).default([]),
            note: z.string().trim().max(300).optional(),
          }),
        )
        .min(1)
        .max(100),
      /** The food total the customer paid, before the platform's delivery fee. */
      total: Money,
    }),
  }),
  z.object({ type: z.literal("order.cancelled"), orderId: z.string().min(1).max(100), reason: z.string().trim().max(300).optional() }),
  z.object({
    type: z.literal("order.rider"),
    orderId: z.string().min(1).max(100),
    riderName: z.string().trim().max(80).optional(),
    arrivesAt: z.string().datetime({ offset: true }).optional(),
  }),
]);
export type Inbound = z.infer<typeof InboundSchema>;

export async function loadChannel(db: Db | Tx, id: string): Promise<Channel | null> {
  const { rows } = await db.query<Channel>("SELECT * FROM delivery_channels WHERE id = $1", [id]);
  return rows[0] ?? null;
}

/** The payment method a delivery sale is paid with; made the first time a store connects a platform. */
export async function ensureDeliveryMethod(db: Db | Tx, tenantId: string) {
  const { rows } = await db.query("SELECT id FROM payment_methods WHERE tenant_id = $1 AND kind = 'delivery'", [tenantId]);
  if (rows[0]) {
    await db.query("UPDATE payment_methods SET active = true, updated_at = now() WHERE id = $1 AND NOT active", [rows[0].id]);
    return rows[0].id as string;
  }
  const id = randomUUID();
  await db.query("INSERT INTO payment_methods (id, tenant_id, name, kind) VALUES ($1, $2, 'Delivery platform', 'delivery')", [id, tenantId]);
  return id;
}

export async function logEvent(
  db: Db | Tx,
  ch: Pick<Channel, "id" | "tenant_id">,
  direction: "in" | "out",
  kind: string,
  outcome: string,
  detail: string | null,
  webOrderId: string | null = null,
) {
  await db.query(
    `INSERT INTO delivery_events (tenant_id, channel_id, direction, kind, outcome, web_order_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ch.tenant_id, ch.id, direction, kind, outcome, webOrderId, detail?.slice(0, 2000) ?? null],
  );
}

export type SendOutcome = "sent" | "simulated" | "failed";

/**
 * Tells the platform something: accepted, rejected, ready, the menu, sold-out items, busy.
 * Without a callback address the call is only written to the activity log (simulated), so a
 * store can try everything before the platform switches the link on.
 */
export async function tellPlatform(db: Db, ch: Channel, type: string, data: Record<string, unknown>, webOrderId: string | null = null): Promise<SendOutcome> {
  const body = JSON.stringify({ type, provider: ch.provider, storeId: ch.external_store_id, sentAt: new Date().toISOString(), data });
  if (!ch.callback_url) {
    await logEvent(db, ch, "out", type, "simulated", summarize(type, data), webOrderId);
    return "simulated";
  }
  const r = await postWebhook(ch.callback_url, body, { "content-type": "application/json", "pos-signature": signPayload(ch.secret, body) }, deliverOptionsFromEnv());
  const ok = !r.error && r.status !== null && r.status >= 200 && r.status < 300;
  await logEvent(db, ch, "out", type, ok ? "sent" : "failed", ok ? summarize(type, data) : `${r.error ?? `HTTP ${r.status}`} ${r.body ?? ""}`.trim(), webOrderId);
  return ok ? "sent" : "failed";
}

const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
/** A time for the activity log, in the UAE's time (where the platforms here run). */
const hhmm = (iso: unknown) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }).format(new Date(String(iso)));

function summarize(type: string, data: Record<string, unknown>): string {
  if (type === "menu.updated") return items((data.items as unknown[]).length);
  if (type === "items.availability") return `${items((data.items as unknown[]).length)} ${data.available ? "back on" : "sold out"}`;
  if (type === "store.status") return data.open ? "Taking orders" : `Busy until ${hhmm(data.until)}`;
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

/** The price without VAT when the store's prices are kept without it, from the price the customer paid. */
const fromGross = (gross: number, tax: TaxRate | undefined) => (!tax || tax.priceIncluded ? gross : Math.round((gross * 10_000) / (10_000 + tax.rateBp)));

/**
 * A new order from the platform becomes a web order for the store's tills. Items keep the
 * price the customer paid; ones we can't match keep their name so the cashier sees them.
 * Sending the same order twice gives the one order.
 */
export async function receiveOrder(db: Db, ch: Channel, msg: Extract<Inbound, { type: "order.created" }>): Promise<{ id: string; duplicate: boolean; autoAccept: boolean }> {
  const o = msg.order;
  const seen = await db.query("SELECT id FROM web_orders WHERE delivery_channel_id = $1 AND external_id = $2", [ch.id, o.id]);
  if (seen.rows[0]) return { id: seen.rows[0].id, duplicate: true, autoAccept: false };

  const taxes = await taxMap(db, ch.tenant_id);
  const ids = o.items.map((i) => i.posId).filter((x): x is string => !!x && z.string().uuid().safeParse(x).success);
  const skus = o.items.map((i) => i.sku).filter((x): x is string => !!x);
  const { rows: found } = await db.query(
    `SELECT v.id, v.sku, p.name, p.tax_id AS "taxId" FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.tenant_id = $1 AND v.active AND (v.id = ANY($2::uuid[]) OR v.sku = ANY($3::text[]))`,
    [ch.tenant_id, ids, skus],
  );
  const byId = new Map(found.map((v) => [v.id as string, v]));
  const bySku = new Map(found.filter((v) => v.sku).map((v) => [v.sku as string, v]));
  const lines = o.items.map((i) => {
    const v = (i.posId && byId.get(i.posId)) || (i.sku && bySku.get(i.sku)) || null;
    const gross = i.price + i.modifiers.reduce((s, m) => s + m.price, 0);
    const taxId = (v?.taxId as string | null) ?? null;
    return {
      variantId: (v?.id as string) ?? null,
      name: (v?.name as string) ?? i.name,
      qty: i.qty,
      unitPrice: fromGross(gross, taxId ? taxes[taxId] : undefined),
      taxId,
      modifiers: i.modifiers.map((m) => ({ name: m.name, price: fromGross(m.price, taxId ? taxes[taxId] : undefined) })),
      ...(i.note ? { note: i.note } : {}),
    };
  });
  const totals = priceOrder(
    lines.map((l, n) => ({ id: String(n), variantId: l.variantId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, taxId: l.taxId })),
    { taxes },
  );
  const unmatched = lines.filter((l) => !l.variantId).map((l) => l.name);
  const id = randomUUID();
  const acceptBy = o.acceptBy ? new Date(o.acceptBy) : new Date(Date.now() + DEFAULT_ACCEPT_MINUTES * 60_000);
  const inserted = await withTx(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('web_orders:' || $1))", [ch.tenant_id]);
    // Checked again under the lock: platforms resend when they don't hear back quickly.
    const again = await tx.query("SELECT id FROM web_orders WHERE delivery_channel_id = $1 AND external_id = $2", [ch.id, o.id]);
    if (again.rows[0]) return again.rows[0].id as string;
    const seq = (await tx.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM web_orders WHERE tenant_id = $1", [ch.tenant_id])).rows[0].n as number;
    await tx.query(
      `INSERT INTO web_orders (id, tenant_id, store_id, seq, number, name, note, lines, subtotal_net, tax_total, total, token, pickup_code,
                               channel, delivery_channel_id, external_id, external_code, accept_by, commission)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'delivery', $14, $15, $16, $17, $18)`,
      [
        id, ch.tenant_id, ch.store_id, seq, `W-${String(seq).padStart(5, "0")}`, o.customerName || null, o.note || null, JSON.stringify(lines),
        totals.subtotalNet, totals.taxTotal, totals.total, randomUUID().replace(/-/g, ""), o.code, ch.id, o.id, o.code, acceptBy,
        Math.round((totals.total * ch.commission_bp) / 10_000),
      ],
    );
    await tx.query("UPDATE delivery_channels SET last_order_at = now() WHERE id = $1", [ch.id]);
    const notes = [
      `${o.code}: ${items(lines.length)}, AED ${(totals.total / 100).toFixed(2)}`,
      totals.total !== o.total ? `the platform says AED ${(o.total / 100).toFixed(2)}` : null,
      unmatched.length ? `not on the menu here: ${unmatched.join(", ")}` : null,
    ];
    await logEvent(tx, ch, "in", "order.created", "received", notes.filter(Boolean).join("; "), id);
    return id;
  });
  if (inserted !== id) return { id: inserted, duplicate: true, autoAccept: false };
  return { id, duplicate: false, autoAccept: ch.auto_accept && !unmatched.length };
}

interface WebOrderRow {
  id: string;
  tenant_id: string;
  store_id: string;
  status: string;
  number: string;
  external_id: string;
  external_code: string;
  lines: { variantId: string | null; name: string; qty: number; modifiers?: { name: string }[]; note?: string }[];
  delivery_channel_id: string;
}

async function lockDelivery(tx: Tx, tenantId: string, storeIds: string[] | null, id: string): Promise<WebOrderRow> {
  const { rows } = await tx.query<WebOrderRow>(
    `SELECT id, tenant_id, store_id, status, number, external_id, external_code, lines, delivery_channel_id FROM web_orders
      WHERE id = $1 AND tenant_id = $2 AND channel = 'delivery' AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[])) FOR UPDATE`,
    [id, tenantId, storeIds],
  );
  if (!rows[0]) throw new HttpError(404, "not_found", "Delivery order not found");
  return rows[0];
}

/** Accepts an order: the platform is told how long it takes, and the kitchen gets the ticket. */
export async function acceptOrder(db: Db, who: { tenantId: string; storeIds: string[] | null; userId: string | null }, id: string, prepMinutes?: number) {
  const res = await withTx(db, async (tx) => {
    const w = await lockDelivery(tx, who.tenantId, who.storeIds, id);
    if (w.status !== "new") return { w, changed: false, ch: null as Channel | null, prep: 0 };
    const ch = (await loadChannel(tx, w.delivery_channel_id))!;
    const prep = prepMinutes ?? ch.prep_minutes;
    await tx.query("UPDATE web_orders SET status = 'accepted', accepted_at = now(), prep_minutes = $2 WHERE id = $1", [id, prep]);
    await tx.query(
      `INSERT INTO kitchen_tickets (id, tenant_id, store_id, label, lines, created_by, created_at, web_order_id) VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`,
      [
        randomUUID(), w.tenant_id, w.store_id, `${ch.name} ${w.external_code}`,
        JSON.stringify(w.lines.map((l, i) => ({ lineId: `d${i + 1}`, name: l.name, qty: l.qty, modifiers: (l.modifiers ?? []).map((m) => m.name), note: l.note ?? null }))),
        who.userId, id,
      ],
    );
    await tx.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1, $2, 'delivery.accept', 'web_order', $3, $4)`,
      [w.tenant_id, who.userId, id, JSON.stringify({ number: w.number, code: w.external_code, prepMinutes: prep })],
    );
    return { w, changed: true, ch, prep };
  });
  if (!res.changed) {
    if (res.w.status === "accepted" || res.w.status === "ready") return { status: res.w.status, platform: null };
    throw new HttpError(409, "wrong_state", `This order is ${res.w.status}`);
  }
  const platform = await tellPlatform(db, res.ch!, "order.accepted", { orderId: res.w.external_id, prepMinutes: res.prep }, id);
  return { status: "accepted", platform };
}

/** Turns an order down; the platform tells the customer and refunds them. */
export async function rejectOrder(db: Db, who: { tenantId: string; storeIds: string[] | null; userId: string | null }, id: string, reason: string) {
  const { w, ch } = await withTx(db, async (tx) => {
    const w = await lockDelivery(tx, who.tenantId, who.storeIds, id);
    if (w.status !== "new") throw new HttpError(409, "wrong_state", "Only a new order can be turned down. Call the platform to cancel it.");
    await tx.query("UPDATE web_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1", [id, reason]);
    await tx.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1, $2, 'delivery.reject', 'web_order', $3, $4)`,
      [w.tenant_id, who.userId, id, JSON.stringify({ number: w.number, code: w.external_code, reason })],
    );
    return { w, ch: (await loadChannel(tx, w.delivery_channel_id))! };
  });
  const platform = await tellPlatform(db, ch, "order.rejected", { orderId: w.external_id, reason }, id);
  return { status: "cancelled", platform };
}

/** The food is packed and waiting for the rider. */
export async function readyOrder(db: Db, who: { tenantId: string; storeIds: string[] | null; userId: string | null }, id: string) {
  const res = await withTx(db, async (tx) => {
    const w = await lockDelivery(tx, who.tenantId, who.storeIds, id);
    if (w.status === "ready") return { w, changed: false, ch: null as Channel | null };
    if (w.status !== "accepted") throw new HttpError(409, "wrong_state", w.status === "new" ? "Accept the order first" : `This order is ${w.status}`);
    await tx.query("UPDATE web_orders SET status = 'ready', ready_at = now() WHERE id = $1", [id]);
    return { w, changed: true, ch: (await loadChannel(tx, w.delivery_channel_id))! };
  });
  if (!res.changed) return { status: "ready", platform: null };
  const platform = await tellPlatform(db, res.ch!, "order.ready", { orderId: res.w.external_id }, id);
  return { status: "ready", platform };
}

/** The platform cancelled: the order leaves the tills and the kitchen sees it is off. */
export async function cancelFromPlatform(db: Db, ch: Channel, externalId: string, reason: string | undefined) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE web_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3
        WHERE delivery_channel_id = $1 AND external_id = $2 AND status IN ('new', 'accepted', 'ready') RETURNING id, external_code`,
      [ch.id, externalId, reason ? `Cancelled by ${PROVIDERS[ch.provider]}: ${reason}` : `Cancelled by ${PROVIDERS[ch.provider]}`],
    );
    const w = rows[0];
    if (w) await tx.query("UPDATE kitchen_tickets SET cancelled_at = now(), updated_at = now() WHERE web_order_id = $1 AND status <> 'done'", [w.id]);
    await logEvent(tx, ch, "in", "order.cancelled", "received", `${w?.external_code ?? externalId}${reason ? `: ${reason}` : ""}${w ? "" : " (already done or unknown)"}`, w?.id ?? null);
    return { changed: !!w };
  });
}

/** The rider's name and when they arrive, for the counter. */
export async function riderUpdate(db: Db, ch: Channel, msg: Extract<Inbound, { type: "order.rider" }>) {
  const { rows } = await db.query(
    `UPDATE web_orders SET rider_name = COALESCE($3, rider_name), rider_at = COALESCE($4, rider_at)
      WHERE delivery_channel_id = $1 AND external_id = $2 RETURNING id, external_code`,
    [ch.id, msg.orderId, msg.riderName ?? null, msg.arrivesAt ?? null],
  );
  await logEvent(db, ch, "in", "order.rider", "received", `${rows[0]?.external_code ?? msg.orderId}: ${msg.riderName ?? "rider"}${msg.arrivesAt ? ` arrives ${hhmm(msg.arrivesAt)}` : ""}`, rows[0]?.id ?? null);
}

/** Menu prices on the platform: the store's price plus the markup, rounded up to the next 50 fils. */
export const markedUp = (gross: number, markupBp: number) => (markupBp ? Math.ceil((gross * (10_000 + markupBp)) / 10_000 / 50) * 50 : gross);

/** The menu as the platform gets it: the store's online menu with choices, prices and what is sold out. */
export async function buildMenu(db: Db | Tx, ch: Channel) {
  const taxes = await taxMap(db, ch.tenant_id);
  const products = (await storeProducts(db, ch.tenant_id, ch.store_id)).filter((p) => p.uom !== "kg");
  const soldOut = new Set(
    (await db.query("SELECT variant_id FROM delivery_sold_out WHERE store_id = $1 AND (until IS NULL OR until > now())", [ch.store_id])).rows.map((r) => r.variant_id as string),
  );
  const groupIds = [...new Set(products.flatMap((p) => (p.modifierGroupIds as string[] | null) ?? []))];
  const groups = groupIds.length
    ? (
        await db.query(
          `SELECT id, name, name_ar AS "nameAr", min_choices AS "minChoices", max_choices AS "maxChoices", options FROM modifier_groups
            WHERE tenant_id = $1 AND active AND id = ANY($2) ORDER BY sort, name`,
          [ch.tenant_id, groupIds],
        )
      ).rows
    : [];
  const cats = (await db.query(`SELECT id, name, name_ar AS "nameAr" FROM categories WHERE tenant_id = $1 ORDER BY sort, name`, [ch.tenant_id])).rows;
  const gross = (price: number, taxId: string | null) =>
    priceOrder([{ id: "x", variantId: null, name: "", qty: 1, unitPrice: price, taxId }], { taxes }).total;
  const used = new Set(products.map((p) => p.categoryId));
  return {
    categories: cats.filter((c) => used.has(c.id)),
    items: products.map((p) => ({
      posId: p.variantId as string,
      name: p.name as string,
      nameAr: p.nameAr as string | null,
      description: p.description as string | null,
      categoryId: p.categoryId as string | null,
      price: markedUp(gross(p.price, p.taxId as string | null), ch.markup_bp),
      available: !soldOut.has(p.variantId as string),
      modifierGroupIds: ((p.modifierGroupIds as string[] | null) ?? []).filter((id) => groups.some((g) => g.id === id)),
    })),
    modifierGroups: groups.map((g) => ({
      ...g,
      options: (g.options as { id: string; name: string; nameAr: string | null; price: number }[]).map((o) => ({ ...o, price: markedUp(o.price, ch.markup_bp) })),
    })),
  };
}

export async function storeChannels(db: Db | Tx, storeId: string): Promise<Channel[]> {
  return (await db.query<Channel>("SELECT * FROM delivery_channels WHERE store_id = $1 AND active ORDER BY name", [storeId])).rows;
}

/** Busy: the store's platforms stop sending orders until then (null: taking orders again). */
export async function setBusy(db: Db, tenantId: string, storeId: string, until: Date | null) {
  const channels = await storeChannels(db, storeId);
  await db.query("UPDATE delivery_channels SET paused_until = $3 WHERE store_id = $1 AND tenant_id = $2 AND active", [storeId, tenantId, until]);
  const results = await Promise.all(
    channels.map((ch) => tellPlatform(db, ch, "store.status", until ? { open: false, until: until.toISOString() } : { open: true })),
  );
  return { channels: channels.length, failed: results.filter((r) => r === "failed").length };
}

/** Marks items sold out (or back on) for delivery at a store and tells its platforms. */
export async function setSoldOut(db: Db, tenantId: string, storeId: string, variantIds: string[], soldOut: boolean, until: Date | null) {
  const known = (await db.query("SELECT id FROM variants WHERE tenant_id = $1 AND id = ANY($2)", [tenantId, variantIds])).rows.map((r) => r.id as string);
  if (known.length !== variantIds.length) throw new HttpError(400, "unknown_item", "Unknown item");
  if (soldOut) {
    await db.query(
      `INSERT INTO delivery_sold_out (store_id, variant_id, tenant_id, until) SELECT $1, v, $2, $4 FROM unnest($3::uuid[]) v
       ON CONFLICT (store_id, variant_id) DO UPDATE SET until = EXCLUDED.until, created_at = now()`,
      [storeId, tenantId, known, until],
    );
  } else {
    await db.query("DELETE FROM delivery_sold_out WHERE store_id = $1 AND variant_id = ANY($2)", [storeId, known]);
  }
  const channels = await storeChannels(db, storeId);
  const results = await Promise.all(
    channels.map((ch) => tellPlatform(db, ch, "items.availability", { items: known, available: !soldOut, until: until?.toISOString() ?? null })),
  );
  return { channels: channels.length, failed: results.filter((r) => r === "failed").length };
}

/** Items whose sold-out time has passed are back on, and the platforms are told. */
export async function expireSoldOut(db: Db) {
  const { rows } = await db.query("DELETE FROM delivery_sold_out WHERE until IS NOT NULL AND until <= now() RETURNING store_id, variant_id");
  const byStore = new Map<string, string[]>();
  for (const r of rows) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r.variant_id]);
  for (const [storeId, items] of byStore) {
    for (const ch of await storeChannels(db, storeId)) await tellPlatform(db, ch, "items.availability", { items, available: true, until: null });
  }
  return rows.length;
}

/** Puts sold-out items back on when their time is up. */
export function startSoldOutWorker(db: Db, log: { error: (obj: unknown, msg?: string) => void }, intervalMs = 60_000) {
  const timer = setInterval(() => void expireSoldOut(db).catch((err) => log.error(err, "sold-out expiry failed")), intervalMs);
  timer.unref();
  return async () => clearInterval(timer);
}

/** Checks a `POS-Signature: t=<unix seconds>,v1=<hex HMAC>` header made with the channel's secret. */
export function verifySignature(secret: string, header: string | undefined, body: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300 || !parts.v1) return false;
  const expected = signPayload(secret, body, t).split("v1=")[1]!;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
