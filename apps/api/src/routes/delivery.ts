import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import {
  acceptOrder,
  cancelFromPlatform,
  InboundSchema,
  loadChannel,
  logEvent,
  readyOrder,
  receiveOrder,
  rejectOrder,
  riderUpdate,
  setBusy,
  setSoldOut,
  storeChannels,
  verifySignature,
} from "../delivery/platform.js";

/**
 * Calls from the delivery platforms (or the integration partner between us and them). Each
 * channel has its own address and secret; the body must be signed with that secret.
 */
export async function deliveryInboundRoutes(app: FastifyInstance) {
  // The signature covers the exact bytes sent, so the body is kept as text here.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 256 * 1024 }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "bad_json", "The body is not valid JSON"), undefined);
    }
  });

  app.post<{ Params: { channelId: string } }>("/delivery-api/:channelId", async (req) => {
    const id = z.string().uuid().safeParse(req.params.channelId);
    const ch = id.success ? await loadChannel(app.db, id.data) : null;
    if (!ch || !ch.active) throw new HttpError(404, "not_found", "Unknown channel");
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    if (!verifySignature(ch.secret, req.headers["pos-signature"] as string | undefined, raw)) {
      await logEvent(app.db, ch, "in", "signature", "refused", "The signature did not match, or is older than 5 minutes");
      throw new HttpError(401, "bad_signature", "Bad or old signature");
    }
    const parsed = InboundSchema.safeParse(req.body);
    if (!parsed.success) {
      const kind = typeof (req.body as { type?: unknown })?.type === "string" ? String((req.body as { type: string }).type).slice(0, 40) : "unknown";
      await logEvent(app.db, ch, "in", kind, "refused", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "Bad request");
    }
    const msg = parsed.data;
    if (msg.type === "order.created") {
      const r = await receiveOrder(app.db, ch, msg);
      if (r.autoAccept) await acceptOrder(app.db, { tenantId: ch.tenant_id, storeIds: [ch.store_id], userId: null }, r.id);
      return { ok: true, orderId: r.id, duplicate: r.duplicate, accepted: r.autoAccept };
    }
    if (msg.type === "order.cancelled") return { ok: true, ...(await cancelFromPlatform(app.db, ch, msg.orderId, msg.reason)) };
    await riderUpdate(app.db, ch, msg);
    return { ok: true };
  });
}

const UserBody = z.object({ userId: z.string().uuid() });

/** Delivery on the till: accepting and turning down orders, Ready, Busy, and sold-out items. */
export async function deliveryTillRoutes(app: FastifyInstance) {
  const till = async (req: FastifyRequest, userId: string) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can do this");
    const user = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND active", [userId, device.tenantId]);
    if (!user.rowCount) throw new HttpError(400, "bad_request", "Unknown cashier");
    return device;
  };

  app.get("/delivery", async (req) => {
    const device = await app.authenticate(req);
    const channels = (await storeChannels(app.db, device.storeId)).map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      pausedUntil: c.paused_until && c.paused_until > new Date() ? c.paused_until : null,
    }));
    const soldOut = await app.db.query(
      `SELECT d.variant_id AS "variantId", p.name, d.until FROM delivery_sold_out d JOIN variants v ON v.id = d.variant_id JOIN products p ON p.id = v.product_id
        WHERE d.store_id = $1 AND (d.until IS NULL OR d.until > now()) ORDER BY p.name`,
      [device.storeId],
    );
    return { channels, soldOut: soldOut.rows };
  });

  app.post<{ Params: { id: string } }>("/delivery-orders/:id/accept", async (req) => {
    const b = UserBody.extend({ prepMinutes: z.number().int().min(5).max(120).optional() }).parse(req.body);
    const device = await till(req, b.userId);
    return acceptOrder(app.db, { tenantId: device.tenantId, storeIds: [device.storeId], userId: b.userId }, z.string().uuid().parse(req.params.id), b.prepMinutes);
  });

  app.post<{ Params: { id: string } }>("/delivery-orders/:id/reject", async (req) => {
    const b = UserBody.extend({ reason: z.string().trim().min(1).max(200) }).parse(req.body);
    const device = await till(req, b.userId);
    return rejectOrder(app.db, { tenantId: device.tenantId, storeIds: [device.storeId], userId: b.userId }, z.string().uuid().parse(req.params.id), b.reason);
  });

  app.post<{ Params: { id: string } }>("/delivery-orders/:id/ready", async (req) => {
    const b = UserBody.parse(req.body);
    const device = await till(req, b.userId);
    return readyOrder(app.db, { tenantId: device.tenantId, storeIds: [device.storeId], userId: b.userId }, z.string().uuid().parse(req.params.id));
  });

  /** Busy for some minutes (null: taking orders again). */
  app.post("/delivery/busy", async (req) => {
    const b = UserBody.extend({ minutes: z.number().int().min(5).max(24 * 60).nullable() }).parse(req.body);
    const device = await till(req, b.userId);
    const until = b.minutes ? new Date(Date.now() + b.minutes * 60_000) : null;
    const r = await setBusy(app.db, device.tenantId, device.storeId, until);
    await app.db.query(
      `INSERT INTO audit_log (tenant_id, user_id, device_id, action, entity, entity_id, data) VALUES ($1, $2, $3, 'delivery.busy', 'store', $4, $5)`,
      [device.tenantId, b.userId, device.deviceId, device.storeId, JSON.stringify({ until })],
    );
    return { pausedUntil: until, ...r };
  });

  /** Sold out for delivery: until a number of minutes from now, or until turned back on (null). */
  app.post("/delivery/sold-out", async (req) => {
    const b = UserBody.extend({
      variantIds: z.array(z.string().uuid()).min(1).max(200),
      soldOut: z.boolean(),
      minutes: z.number().int().min(5).max(7 * 24 * 60).nullish(),
    }).parse(req.body);
    const device = await till(req, b.userId);
    return setSoldOut(app.db, device.tenantId, device.storeId, b.variantIds, b.soldOut, b.soldOut && b.minutes ? new Date(Date.now() + b.minutes * 60_000) : null);
  });
}
