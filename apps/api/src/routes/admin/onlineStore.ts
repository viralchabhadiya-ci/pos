import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx, type Db, type Tx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { notifyWebOrder, orderLink, type WebOrderNotice } from "../../shop/notify.js";
import { storeParam } from "../../stores.js";
import { adminAudit, forbidden, isUniqueViolation } from "./common.js";

const SettingsSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{2,39}$/, "Use 3 to 40 lowercase letters, numbers and dashes, e.g. al-noor"),
  enabled: z.boolean(),
  pickupStoreIds: z.array(z.string().uuid()).max(100),
  notice: z.string().trim().max(300).nullish(),
  minOrder: z.number().int().min(0).max(100_000_000),
  readyMinutes: z.number().int().min(5).max(1440),
  checkStock: z.boolean(),
});

const WEB_ORDER_SELECT = `SELECT w.id, w.number, w.status, w.name, w.phone, w.email, w.note, w.lines, w.subtotal_net AS "subtotalNet",
       w.tax_total AS "taxTotal", w.total, w.pickup_code AS "pickupCode", w.store_id AS "storeId", s.name AS "storeName",
       w.customer_id AS "customerId", w.order_id AS "orderId", o.number AS "orderNumber", w.cancel_reason AS "cancelReason",
       w.created_at AS "createdAt", w.accepted_at AS "acceptedAt", w.ready_at AS "readyAt", w.collected_at AS "collectedAt",
       w.cancelled_at AS "cancelledAt"
  FROM web_orders w JOIN stores s ON s.id = w.store_id LEFT JOIN orders o ON o.id = w.order_id`;

/** Where each step may come from. Collected only happens through a till sale. */
const NEXT: Record<"accept" | "ready" | "cancel", { from: string[]; to: string; at: string }> = {
  accept: { from: ["new"], to: "accepted", at: "accepted_at" },
  ready: { from: ["new", "accepted"], to: "ready", at: "ready_at" },
  cancel: { from: ["new", "accepted", "ready"], to: "cancelled", at: "cancelled_at" },
};

/**
 * Moves an online order on, for the back office and the till alike. Customers are told when
 * it is ready or cancelled.
 */
export async function moveWebOrder(
  app: FastifyInstance,
  db: Db,
  who: { tenantId: string; storeIds: string[] | null; audit: (tx: Tx, data: Record<string, unknown>) => Promise<void> },
  id: string,
  step: keyof typeof NEXT,
  reason?: string | null,
) {
  const n = NEXT[step];
  const res = await withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, number, status, store_id FROM web_orders WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[])) FOR UPDATE`,
      [id, who.tenantId, who.storeIds],
    );
    const w = rows[0];
    if (!w) throw notFound("Online order");
    if (w.status === n.to) return { status: w.status, changed: false };
    if (!n.from.includes(w.status)) throw new HttpError(409, "wrong_state", `${w.number} is ${w.status}`);
    await tx.query(
      // Getting an order ready also counts as accepting it.
      `UPDATE web_orders SET status = $2, ${n.at} = now()${n.to === "ready" ? ", accepted_at = COALESCE(accepted_at, now())" : ""}${
        n.to === "cancelled" ? ", cancel_reason = $3" : ""
      } WHERE id = $1`,
      n.to === "cancelled" ? [id, n.to, reason ?? null] : [id, n.to],
    );
    await who.audit(tx, { number: w.number, status: n.to, ...(reason ? { reason } : {}) });
    return { status: n.to, changed: true };
  });
  const notice: WebOrderNotice | null = res.changed ? (n.to === "ready" ? "ready" : n.to === "cancelled" ? "cancelled" : null) : null;
  if (notice) void notifyWebOrder(app, id, notice).catch((err) => app.log.error(err, "web order notice failed"));
  return { status: res.status };
}

export async function onlineStoreRoutes(app: FastifyInstance) {
  app.get("/online-store", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT slug, enabled, pickup_store_ids AS "pickupStoreIds", notice, min_order AS "minOrder", ready_minutes AS "readyMinutes",
              check_stock AS "checkStock"
         FROM online_stores WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    const counts = await app.db.query(
      `SELECT COUNT(*) FILTER (WHERE online AND active)::int AS online, COUNT(*) FILTER (WHERE active)::int AS active FROM products WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    let settings = rows[0];
    if (!settings) {
      const t = (await app.db.query("SELECT name FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0];
      const stores = (await app.db.query("SELECT id FROM stores WHERE tenant_id = $1 ORDER BY code", [ctx.tenantId])).rows;
      const suggested = String(t.name)
        .toLowerCase()
        .replace(/\b(llc|l\.l\.c|fze|fzco|trading|est)\b/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      settings = { slug: suggested.length >= 3 ? suggested : "", enabled: false, pickupStoreIds: stores.map((s) => s.id), notice: null, minOrder: 0, readyMinutes: 30, checkStock: true, isNew: true };
    }
    return {
      settings,
      products: counts.rows[0],
      shopUrl: settings.slug && process.env.SHOP_URL ? `${process.env.SHOP_URL.replace(/\/$/, "")}/#/${settings.slug}` : null,
      shopAppConfigured: !!process.env.SHOP_URL,
    };
  });

  app.put("/online-store", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change the online store");
    const b = SettingsSchema.parse(req.body);
    if (b.enabled && !b.pickupStoreIds.length) throw new HttpError(400, "bad_request", "Pick at least one store customers can collect from");
    const known = await app.db.query("SELECT id FROM stores WHERE tenant_id = $1 AND id = ANY($2)", [ctx.tenantId, b.pickupStoreIds]);
    if (known.rowCount !== new Set(b.pickupStoreIds).size) throw new HttpError(400, "bad_request", "That store does not exist");
    try {
      await app.db.query(
        `INSERT INTO online_stores (tenant_id, slug, enabled, pickup_store_ids, notice, min_order, ready_minutes, check_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE SET slug = $2, enabled = $3, pickup_store_ids = $4, notice = $5, min_order = $6, ready_minutes = $7,
           check_stock = $8, updated_at = now()`,
        [ctx.tenantId, b.slug, b.enabled, [...new Set(b.pickupStoreIds)], b.notice || null, b.minOrder, b.readyMinutes, b.checkStock],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "slug_taken", "Another business already uses this shop address");
      throw err;
    }
    await adminAudit(app.db, ctx, "online_store.update", "online_store", ctx.tenantId, { slug: b.slug, enabled: b.enabled });
    return { ok: true };
  });

  /** Products with whether they are sold online and their shop description. */
  app.get<{ Querystring: { q?: string; filter?: string } }>("/online-store/products", async (req) => {
    const ctx = await app.authAdmin(req);
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    const filter = req.query.filter === "online" ? "AND p.online" : req.query.filter === "offline" ? "AND NOT p.online" : "";
    const { rows } = await app.db.query(
      `SELECT p.id, p.name, p.description, p.online, c.name AS "categoryName", v.price
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         JOIN LATERAL (SELECT price FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
        WHERE p.tenant_id = $1 AND p.active ${filter} AND ($2 = '' OR p.name ILIKE '%' || $2 || '%')
        ORDER BY c.name NULLS LAST, p.name LIMIT 500`,
      [ctx.tenantId, q],
    );
    return { products: rows };
  });

  /** Puts products on the shop or takes them off, many at once. */
  app.post("/online-store/products", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = z.object({ productIds: z.array(z.string().uuid()).min(1).max(1000), online: z.boolean() }).parse(req.body);
    const { rowCount } = await app.db.query("UPDATE products SET online = $3, updated_at = now() WHERE tenant_id = $1 AND id = ANY($2)", [
      ctx.tenantId,
      b.productIds,
      b.online,
    ]);
    await adminAudit(app.db, ctx, b.online ? "online_store.publish" : "online_store.unpublish", "product", b.productIds[0]!, { count: rowCount });
    return { changed: rowCount };
  });

  app.put<{ Params: { id: string } }>("/online-store/products/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ online: z.boolean(), description: z.string().trim().max(1000).nullish() }).parse(req.body);
    const r = await app.db.query("UPDATE products SET online = $3, description = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2", [
      id,
      ctx.tenantId,
      b.online,
      b.description || null,
    ]);
    if (!r.rowCount) throw notFound("Product");
    await adminAudit(app.db, ctx, "online_store.product", "product", id, { online: b.online });
    return { ok: true };
  });

  // Orders

  app.get<{ Querystring: { status?: string; storeId?: string } }>("/web-orders", async (req) => {
    const ctx = await app.authAdmin(req);
    const stores = storeParam(ctx, req.query.storeId);
    const status = z.enum(["open", "collected", "cancelled", "all"]).catch("open").parse(req.query.status);
    const where =
      status === "open" ? "w.status IN ('new', 'accepted', 'ready')" : status === "all" ? "true" : `w.status = '${status}'`;
    const { rows } = await app.db.query(
      `${WEB_ORDER_SELECT} WHERE w.tenant_id = $1 AND ($2::uuid[] IS NULL OR w.store_id = ANY($2::uuid[])) AND ${where}
        ORDER BY ${status === "open" ? "w.created_at" : "w.created_at DESC"} LIMIT 200`,
      [ctx.tenantId, stores],
    );
    const counts = await app.db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'new')::int AS new, COUNT(*) FILTER (WHERE status IN ('new', 'accepted', 'ready'))::int AS open
         FROM web_orders WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))`,
      [ctx.tenantId, stores],
    );
    return { orders: rows, counts: counts.rows[0] };
  });

  app.get<{ Params: { id: string } }>("/web-orders/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await app.db.query(
      `${WEB_ORDER_SELECT.replace("SELECT w.id,", "SELECT w.id, w.token, (SELECT slug FROM online_stores WHERE tenant_id = w.tenant_id) AS slug,")}
        WHERE w.id = $1 AND w.tenant_id = $2 AND ($3::uuid[] IS NULL OR w.store_id = ANY($3::uuid[]))`,
      [id, ctx.tenantId, ctx.storeIds],
    );
    if (!rows[0]) throw notFound("Online order");
    const { token, slug, ...o } = rows[0];
    return { ...o, customerLink: orderLink(slug, token) };
  });

  for (const step of ["accept", "ready", "cancel"] as const) {
    app.post<{ Params: { id: string } }>(`/web-orders/:id/${step}`, async (req) => {
      const ctx = await app.authAdmin(req);
      const id = z.string().uuid().parse(req.params.id);
      const reason = step === "cancel" ? z.object({ reason: z.string().trim().max(200).nullish() }).parse(req.body ?? {}).reason : null;
      return moveWebOrder(
        app,
        app.db,
        { tenantId: ctx.tenantId, storeIds: ctx.storeIds, audit: (tx, data) => adminAudit(tx, ctx, `web_order.${step}`, "web_order", id, data) },
        id,
        step,
        reason,
      );
    });
  }
}
