import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { money, toCsv } from "../../csv.js";
import {
  buildMenu,
  ensureDeliveryMethod,
  loadChannel,
  PROVIDERS,
  receiveOrder,
  acceptOrder,
  setBusy,
  setSoldOut,
  tellPlatform,
  type Channel,
} from "../../delivery/platform.js";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { assertStore, storeParam } from "../../stores.js";
import { checkWebhookUrl, deliverOptionsFromEnv, newWebhookSecret } from "../../webhooks/deliver.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");

const ChannelSchema = z.object({
  storeId: z.string().uuid(),
  provider: z.enum(Object.keys(PROVIDERS) as [keyof typeof PROVIDERS, ...(keyof typeof PROVIDERS)[]]),
  name: z.string().trim().min(1, "Give it a name staff will know").max(40),
  externalStoreId: z.string().trim().min(1, "Enter the platform's id for this branch").max(100),
  callbackUrl: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => v || null),
  autoAccept: z.boolean().default(false),
  prepMinutes: z.number().int().min(5).max(120).default(20),
  commissionBp: z.number().int().min(0).max(10_000).default(0),
  markupBp: z.number().int().min(0).max(10_000).default(0),
  active: z.boolean().default(true),
});

const webhookBase = () => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/delivery-api` : null);

const view = (c: Channel & { store_name?: string; menu_synced_at?: Date | null; last_order_at?: Date | null }) => ({
  id: c.id,
  storeId: c.store_id,
  storeName: c.store_name ?? null,
  provider: c.provider,
  name: c.name,
  externalStoreId: c.external_store_id,
  callbackUrl: c.callback_url,
  active: c.active,
  autoAccept: c.auto_accept,
  prepMinutes: c.prep_minutes,
  commissionBp: c.commission_bp,
  markupBp: c.markup_bp,
  pausedUntil: c.paused_until && c.paused_until > new Date() ? c.paused_until : null,
  menuSyncedAt: c.menu_synced_at ?? null,
  lastOrderAt: c.last_order_at ?? null,
  // Where the platform sends orders, and the secret it signs them with.
  webhookUrl: webhookBase() ? `${webhookBase()}/${c.id}` : `/delivery-api/${c.id}`,
  secret: c.secret,
});

/** Back office Delivery: the platforms each store is on, menus, sold-out items, activity and payouts. */
export async function deliveryAdminRoutes(app: FastifyInstance) {
  async function channelFor(ctx: { tenantId: string; storeIds: string[] | null }, id: string) {
    const ch = z.string().uuid().safeParse(id).success ? await loadChannel(app.db, id) : null;
    if (!ch || ch.tenant_id !== ctx.tenantId || (ctx.storeIds && !ctx.storeIds.includes(ch.store_id))) throw notFound("Delivery channel");
    return ch;
  }
  const checkUrl = (url: string | null) => {
    const bad = url ? checkWebhookUrl(url, deliverOptionsFromEnv()) : null;
    if (bad) throw new HttpError(400, "bad_url", bad);
  };
  const taken = (err: unknown) =>
    isUniqueViolation(err) ? new HttpError(409, "taken", "That platform branch id is already connected") : err;

  app.get<{ Querystring: { storeId?: string } }>("/delivery", async (req) => {
    const ctx = await app.authAdmin(req);
    const stores = storeParam(ctx, req.query.storeId);
    const channels = await app.db.query(
      `SELECT c.*, s.name AS store_name FROM delivery_channels c JOIN stores s ON s.id = c.store_id
        WHERE c.tenant_id = $1 AND ($2::uuid[] IS NULL OR c.store_id = ANY($2::uuid[])) ORDER BY s.code, c.name`,
      [ctx.tenantId, stores],
    );
    const soldOut = await app.db.query(
      `SELECT d.store_id AS "storeId", d.variant_id AS "variantId", p.name, d.until FROM delivery_sold_out d
         JOIN variants v ON v.id = d.variant_id JOIN products p ON p.id = v.product_id
        WHERE d.tenant_id = $1 AND ($2::uuid[] IS NULL OR d.store_id = ANY($2::uuid[])) AND (d.until IS NULL OR d.until > now()) ORDER BY p.name`,
      [ctx.tenantId, stores],
    );
    const events = await app.db.query(
      `SELECT e.id, e.channel_id AS "channelId", c.name AS "channelName", e.direction, e.kind, e.outcome, e.detail, e.created_at AS "createdAt"
         FROM delivery_events e JOIN delivery_channels c ON c.id = e.channel_id
        WHERE e.tenant_id = $1 AND ($2::uuid[] IS NULL OR c.store_id = ANY($2::uuid[])) ORDER BY e.id DESC LIMIT 100`,
      [ctx.tenantId, stores],
    );
    const menu = await app.db.query(
      `SELECT v.id AS "variantId", p.name FROM products p JOIN LATERAL (SELECT id FROM variants v WHERE v.product_id = p.id AND v.active ORDER BY v.id LIMIT 1) v ON true
        WHERE p.tenant_id = $1 AND p.online AND p.active ORDER BY p.name LIMIT 2000`,
      [ctx.tenantId],
    );
    return {
      channels: channels.rows.map(view),
      soldOut: soldOut.rows,
      events: events.rows,
      menuItems: menu.rows,
      providers: Object.entries(PROVIDERS).map(([id, name]) => ({ id, name })),
      publicUrl: !!process.env.PUBLIC_URL,
    };
  });

  app.post("/delivery-channels", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const b = ChannelSchema.parse(req.body);
    assertStore(ctx, b.storeId);
    checkUrl(b.callbackUrl);
    const id = randomUUID();
    await withTx(app.db, async (tx) => {
      const store = await tx.query("SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2", [b.storeId, ctx.tenantId]);
      if (!store.rowCount) throw notFound("Store");
      await tx
        .query(
          `INSERT INTO delivery_channels (id, tenant_id, store_id, provider, name, external_store_id, secret, callback_url, active, auto_accept, prep_minutes, commission_bp, markup_bp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [id, ctx.tenantId, b.storeId, b.provider, b.name, b.externalStoreId, newWebhookSecret(), b.callbackUrl, b.active, b.autoAccept, b.prepMinutes, b.commissionBp, b.markupBp],
        )
        .catch((err) => {
          throw taken(err);
        });
      await ensureDeliveryMethod(tx, ctx.tenantId);
      await adminAudit(tx, ctx, "delivery_channel.create", "delivery_channel", id, { provider: b.provider, name: b.name });
    });
    reply.status(201);
    return view((await loadChannel(app.db, id))!);
  });

  app.put<{ Params: { id: string } }>("/delivery-channels/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const ch = await channelFor(ctx, req.params.id);
    const b = ChannelSchema.parse(req.body);
    assertStore(ctx, b.storeId);
    checkUrl(b.callbackUrl);
    await app.db
      .query(
        `UPDATE delivery_channels SET store_id = $2, provider = $3, name = $4, external_store_id = $5, callback_url = $6, active = $7, auto_accept = $8,
                prep_minutes = $9, commission_bp = $10, markup_bp = $11 WHERE id = $1`,
        [ch.id, b.storeId, b.provider, b.name, b.externalStoreId, b.callbackUrl, b.active, b.autoAccept, b.prepMinutes, b.commissionBp, b.markupBp],
      )
      .catch((err) => {
        throw taken(err);
      });
    await adminAudit(app.db, ctx, "delivery_channel.update", "delivery_channel", ch.id, { name: b.name, active: b.active, commissionBp: b.commissionBp });
    return view((await loadChannel(app.db, ch.id))!);
  });

  /** A new signing secret, when the old one may have leaked. The platform must be given it. */
  app.post<{ Params: { id: string } }>("/delivery-channels/:id/new-secret", async (req) => {
    const ctx = await app.authAdmin(req);
    const ch = await channelFor(ctx, req.params.id);
    await app.db.query("UPDATE delivery_channels SET secret = $2 WHERE id = $1", [ch.id, newWebhookSecret()]);
    await adminAudit(app.db, ctx, "delivery_channel.new_secret", "delivery_channel", ch.id, { name: ch.name });
    return view((await loadChannel(app.db, ch.id))!);
  });

  app.get<{ Params: { id: string } }>("/delivery-channels/:id/menu", async (req) => {
    const ctx = await app.authAdmin(req);
    return buildMenu(app.db, await channelFor(ctx, req.params.id));
  });

  /** Sends the menu, prices and sold-out items to the platform. */
  app.post<{ Params: { id: string } }>("/delivery-channels/:id/menu", async (req) => {
    const ctx = await app.authAdmin(req);
    const ch = await channelFor(ctx, req.params.id);
    const menu = await buildMenu(app.db, ch);
    if (!menu.items.length) throw new HttpError(409, "empty_menu", "No products are on the online menu. Tick Online on the products to sell.");
    const outcome = await tellPlatform(app.db, ch, "menu.updated", menu);
    if (outcome !== "failed") await app.db.query("UPDATE delivery_channels SET menu_synced_at = now() WHERE id = $1", [ch.id]);
    await adminAudit(app.db, ctx, "delivery_channel.menu", "delivery_channel", ch.id, { items: menu.items.length, outcome });
    return { items: menu.items.length, outcome };
  });

  /** A made-up order from this platform, to try the tills and the kitchen before going live. */
  app.post<{ Params: { id: string } }>("/delivery-channels/:id/test-order", async (req) => {
    const ctx = await app.authAdmin(req);
    const ch = await channelFor(ctx, req.params.id);
    const menu = await buildMenu(app.db, ch);
    const items = menu.items.filter((i) => i.available).slice(0, 2);
    if (!items.length) throw new HttpError(409, "empty_menu", "No products are on the online menu. Tick Online on the products to sell.");
    const code = `TEST-${Math.floor(1000 + Math.random() * 9000)}`;
    const lines = items.map((i, n) => ({ posId: i.posId, name: i.name, qty: n + 1, price: i.price, modifiers: [] }));
    const r = await receiveOrder(app.db, ch, {
      type: "order.created",
      order: { id: `test-${randomUUID()}`, code, customerName: "Test order", note: "Test order from the back office. Turn it down on the till.", items: lines, total: lines.reduce((s, l) => s + l.price * l.qty, 0) },
    });
    if (r.autoAccept) await acceptOrder(app.db, { tenantId: ch.tenant_id, storeIds: [ch.store_id], userId: ctx.userId }, r.id);
    await adminAudit(app.db, ctx, "delivery_channel.test_order", "delivery_channel", ch.id, { code });
    return { code, id: r.id };
  });

  app.post("/delivery/busy", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = z.object({ storeId: z.string().uuid(), minutes: z.number().int().min(5).max(24 * 60).nullable() }).parse(req.body);
    assertStore(ctx, b.storeId);
    const until = b.minutes ? new Date(Date.now() + b.minutes * 60_000) : null;
    const r = await setBusy(app.db, ctx.tenantId, b.storeId, until);
    await adminAudit(app.db, ctx, "delivery.busy", "store", b.storeId, { until });
    return { pausedUntil: until, ...r };
  });

  app.post("/delivery/sold-out", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = z
      .object({
        storeId: z.string().uuid(),
        variantIds: z.array(z.string().uuid()).min(1).max(200),
        soldOut: z.boolean(),
        minutes: z.number().int().min(5).max(7 * 24 * 60).nullish(),
      })
      .parse(req.body);
    assertStore(ctx, b.storeId);
    const r = await setSoldOut(app.db, ctx.tenantId, b.storeId, b.variantIds, b.soldOut, b.soldOut && b.minutes ? new Date(Date.now() + b.minutes * 60_000) : null);
    await adminAudit(app.db, ctx, b.soldOut ? "delivery.sold_out" : "delivery.back_on", "store", b.storeId, { items: b.variantIds.length });
    return r;
  });

  /**
   * Orders and payouts by platform for the days, by each store's calendar: what customers paid
   * for the food, what the platform keeps, and what it should pay out.
   */
  app.get<{ Querystring: { from?: string; to?: string; storeId?: string; format?: string } }>("/delivery/report", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = z.object({ from: Day, to: Day, storeId: z.string().uuid().optional(), format: z.enum(["json", "csv"]).default("json") }).parse(req.query);
    if (q.to < q.from) throw new HttpError(400, "bad_request", "The start date is after the end date");
    const stores = storeParam(ctx, q.storeId);
    const { rows } = await app.db.query(
      `SELECT c.id, c.name, c.provider, s.name AS "storeName", c.commission_bp AS "commissionBp",
              COUNT(w.id)::int AS orders,
              COUNT(w.id) FILTER (WHERE w.status = 'collected')::int AS delivered,
              COUNT(w.id) FILTER (WHERE w.status = 'cancelled')::int AS cancelled,
              COALESCE(SUM(w.total) FILTER (WHERE w.status = 'collected'), 0)::int AS sales,
              COALESCE(SUM(w.commission) FILTER (WHERE w.status = 'collected'), 0)::int AS commission,
              ROUND(AVG(EXTRACT(EPOCH FROM (w.accepted_at - w.created_at))) FILTER (WHERE w.accepted_at IS NOT NULL))::int AS "acceptSeconds"
         FROM delivery_channels c JOIN stores s ON s.id = c.store_id
         LEFT JOIN web_orders w ON w.delivery_channel_id = c.id AND (w.created_at AT TIME ZONE s.timezone)::date BETWEEN $3::date AND $4::date
        WHERE c.tenant_id = $1 AND ($2::uuid[] IS NULL OR c.store_id = ANY($2::uuid[]))
        GROUP BY c.id, s.name, s.code ORDER BY s.code, c.name`,
      [ctx.tenantId, stores, q.from, q.to],
    );
    const out = rows.map((r) => ({ ...r, payout: r.sales - r.commission }));
    const totals = out.reduce(
      (t, r) => ({ orders: t.orders + r.orders, delivered: t.delivered + r.delivered, cancelled: t.cancelled + r.cancelled, sales: t.sales + r.sales, commission: t.commission + r.commission, payout: t.payout + r.payout }),
      { orders: 0, delivered: 0, cancelled: 0, sales: 0, commission: 0, payout: 0 },
    );
    if (q.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="delivery-${q.from}-${q.to}.csv"`);
      return toCsv(
        ["Store", "Platform", "Orders", "Delivered", "Cancelled", "Sales", "Commission", "Payout"],
        out.map((r) => [r.storeName, r.name, r.orders, r.delivered, r.cancelled, money(r.sales), money(r.commission), money(r.payout)]),
      );
    }
    return { rows: out, totals };
  });
}
