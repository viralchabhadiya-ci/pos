import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTx } from "../db.js";
import { HttpError, notFound } from "../errors.js";
import { CustomerSchema, saveCustomer } from "../routes/admin/business.js";
import { ProductSchema, saveProduct, uniqueToBarcode, type ProductInput } from "../routes/admin/catalog.js";
import { AdjustSchema, adjustStock } from "../routes/admin/inventory/stock.js";
import { authApi, type ApiContext, type Scope } from "./auth.js";
import { docsHtml, openApiSpec } from "./openapi.js";
import { CUSTOMER_SQL, loadCustomer, loadOrder, loadOrders, loadProduct, PRODUCT_SQL } from "./serialize.js";

const bad = (message: string) => new HttpError(400, "bad_request", message);

/** Lists page with an opaque cursor: the sort value and id of the last row returned. */
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && z.string().uuid().safeParse(v[1]).success) return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw bad("The cursor is not valid. Pass the nextCursor from the previous page as it is.");
}

const encodeCursor = (sort: Date | string, id: string) =>
  Buffer.from(JSON.stringify([sort instanceof Date ? sort.toISOString() : sort, id])).toString("base64url");

/** Fetches limit + 1 rows to know whether another page follows. */
function page<T extends { id: string }>(rows: T[], limit: number, sortOf: (r: T) => Date | string) {
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return { data, nextCursor: more && last ? encodeCursor(sortOf(last), last.id) : null };
}

const Uuid = z.string().uuid();
const parseId = (id: string, what: string) => {
  const r = Uuid.safeParse(id);
  if (!r.success) throw notFound(what);
  return r.data;
};

const DateTime = z.string().datetime({ offset: true });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-26");

/**
 * Safe retries for POST: the first answer to an Idempotency-Key is stored for 24 hours and
 * returned again for the same request. The same key with a different body is refused.
 */
async function idempotent(
  app: FastifyInstance,
  ctx: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<{ status: number; body: unknown }>,
) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key) {
    const r = await run();
    return reply.status(r.status).send(r.body);
  }
  if (key.length > 200) throw bad("The Idempotency-Key is at most 200 characters");
  const hash = createHash("sha256").update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`).digest("hex");
  const claimed = await app.db.query(
    `INSERT INTO api_idempotency (key_id, idem_key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [ctx.apiKey.id, key, hash],
  );
  if (!claimed.rowCount) {
    const { rows } = await app.db.query("SELECT request_hash, status, body FROM api_idempotency WHERE key_id = $1 AND idem_key = $2", [
      ctx.apiKey.id,
      key,
    ]);
    const prev = rows[0];
    if (prev && prev.request_hash !== hash) {
      throw new HttpError(422, "idempotency_mismatch", "This Idempotency-Key was already used for a different request");
    }
    if (!prev || prev.status === null) throw new HttpError(409, "in_progress", "A request with this Idempotency-Key is still running");
    reply.header("idempotent-replayed", "true");
    return reply.status(prev.status).send(prev.body);
  }
  try {
    const r = await run();
    await app.db.query("UPDATE api_idempotency SET status = $3, body = $4 WHERE key_id = $1 AND idem_key = $2", [
      ctx.apiKey.id,
      key,
      r.status,
      JSON.stringify(r.body),
    ]);
    return reply.status(r.status).send(r.body);
  } catch (err) {
    // A failed request can be tried again with the same key.
    await app.db.query("DELETE FROM api_idempotency WHERE key_id = $1 AND idem_key = $2", [ctx.apiKey.id, key]);
    throw err;
  }
}

const ProductPatch = ProductSchema.partial().strict();
const CustomerPatch = CustomerSchema.partial().strict();

/** Adjustments in the API name products, not variants, like the rest of the API. */
const ApiAdjustSchema = z.object({
  storeId: z.string().uuid(),
  reason: z.enum(["adjust", "waste"]),
  note: z.string().trim().max(300).nullish(),
  lines: z
    .array(z.object({ productId: z.string().uuid(), qty: z.number().finite().refine((n) => n !== 0, "Quantity cannot be zero") }))
    .min(1)
    .max(200),
});

/** The public REST API, under /v1, for a business's own integrations. Authenticated with API keys. */
export async function publicRoutes(app: FastifyInstance) {
  const auth = (req: FastifyRequest, reply: FastifyReply, scope: Scope | null) => authApi(app.db, req, reply, scope);

  // Machine-readable spec and a readable page; no key needed.
  app.get("/v1/openapi.json", async () => openApiSpec());
  app.get("/docs", async (_req, reply) => reply.type("text/html; charset=utf-8").send(docsHtml()));

  async function checkRefs(tenantId: string, body: { categoryId?: string | null; taxId?: string | null }) {
    if (body.categoryId) {
      const c = await app.db.query("SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2", [body.categoryId, tenantId]);
      if (!c.rowCount) throw bad("That category does not exist");
    }
    if (body.taxId) {
      const t = await app.db.query("SELECT 1 FROM taxes WHERE id = $1 AND tenant_id = $2", [body.taxId, tenantId]);
      if (!t.rowCount) throw bad("That tax does not exist");
    }
  }

  app.get("/v1/me", async (req, reply) => {
    const ctx = await auth(req, reply, null);
    const { rows } = await app.db.query("SELECT id, name, country, currency FROM tenants WHERE id = $1", [ctx.tenantId]);
    return { business: rows[0], key: { id: ctx.apiKey.id, name: ctx.apiKey.name, scopes: ctx.apiKey.scopes } };
  });

  // Stores

  app.get("/v1/stores", async (req, reply) => {
    const ctx = await auth(req, reply, "stores:read");
    const { rows: stores } = await app.db.query(
      `SELECT id, code, name, name_ar AS "nameAr", address, phone, trn, timezone FROM stores WHERE tenant_id = $1 ORDER BY code`,
      [ctx.tenantId],
    );
    const { rows: regs } = await app.db.query(
      `SELECT r.id, r.store_id, r.code, r.name FROM registers r JOIN stores s ON s.id = r.store_id WHERE s.tenant_id = $1 ORDER BY r.code`,
      [ctx.tenantId],
    );
    return {
      data: stores.map((s) => ({
        ...s,
        registers: regs.filter((r) => r.store_id === s.id).map((r) => ({ id: r.id, code: r.code, name: r.name })),
      })),
    };
  });

  // Products

  const ProductList = Page.extend({
    updatedSince: DateTime.optional(),
    q: z.string().trim().max(100).optional(),
    barcode: z.string().trim().max(64).optional(),
    active: z.enum(["true", "false"]).optional(),
  });

  app.get("/v1/products", async (req, reply) => {
    const ctx = await auth(req, reply, "products:read");
    const f = ProductList.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["p.tenant_id = $1"];
    const add = (sql: string, ...v: unknown[]) => {
      params.push(...v);
      where.push(sql.replace(/\$(\d)/g, (_, n) => `$${params.length - v.length + Number(n)}`));
    };
    if (f.updatedSince) add("p.updated_at >= $1", f.updatedSince);
    if (f.q) add("(p.name ILIKE $1 OR p.name_ar ILIKE $1 OR v.sku = $2)", `%${f.q}%`, f.q);
    if (f.barcode) add("(v.barcode = $1 OR $1 = ANY(v.extra_barcodes))", f.barcode);
    if (f.active) add("p.active = $1", f.active === "true");
    const c = decodeCursor(f.cursor);
    if (c) add("(date_trunc('milliseconds', p.updated_at), p.id) > ($1::timestamptz, $2::uuid)", c[0], c[1]);
    const { rows } = await app.db.query(`${PRODUCT_SQL} WHERE ${where.join(" AND ")} ORDER BY date_trunc('milliseconds', p.updated_at), p.id LIMIT ${f.limit + 1}`, params);
    return page(rows, f.limit, (r) => r.updatedAt);
  });

  app.get<{ Params: { id: string } }>("/v1/products/:id", async (req, reply) => {
    const ctx = await auth(req, reply, "products:read");
    const p = await loadProduct(app.db, ctx.tenantId, parseId(req.params.id, "Product"));
    if (!p) throw notFound("Product");
    return p;
  });

  app.post("/v1/products", async (req, reply) => {
    const ctx = await auth(req, reply, "products:write");
    return idempotent(app, ctx, req, reply, async () => {
      const body = ProductSchema.parse(req.body);
      await checkRefs(ctx.tenantId, body);
      const id = await withTx(app.db, (tx) => saveProduct(tx, ctx, null, body, "api")).catch(uniqueToBarcode);
      return { status: 201, body: await loadProduct(app.db, ctx.tenantId, id) };
    });
  });

  /** Changes only the fields sent; the rest stay as they are. */
  app.patch<{ Params: { id: string } }>("/v1/products/:id", async (req, reply) => {
    const ctx = await auth(req, reply, "products:write");
    const id = parseId(req.params.id, "Product");
    const patch = ProductPatch.parse(req.body);
    const cur = await loadProduct(app.db, ctx.tenantId, id);
    if (!cur) throw notFound("Product");
    const current: ProductInput = {
      name: cur.name,
      nameAr: cur.nameAr,
      categoryId: cur.categoryId,
      uom: cur.uom,
      taxId: cur.taxId,
      price: cur.price,
      cost: cur.cost,
      barcode: cur.barcode,
      extraBarcodes: cur.extraBarcodes,
      sku: cur.sku,
      plu: cur.plu,
      reorderLevel: cur.reorderLevel,
      active: cur.active,
    };
    const body = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k in (req.body as object))) } as ProductInput;
    await checkRefs(ctx.tenantId, body);
    await withTx(app.db, (tx) => saveProduct(tx, ctx, id, body, "api")).catch(uniqueToBarcode);
    return loadProduct(app.db, ctx.tenantId, id);
  });

  // Customers

  const CustomerList = Page.extend({
    updatedSince: DateTime.optional(),
    q: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().max(200).optional(),
  });

  app.get("/v1/customers", async (req, reply) => {
    const ctx = await auth(req, reply, "customers:read");
    const f = CustomerList.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["c.tenant_id = $1"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("$?", `$${params.length}`));
    };
    if (f.updatedSince) add("c.updated_at >= $?", f.updatedSince);
    if (f.q) add("c.name ILIKE $?", `%${f.q}%`);
    if (f.phone) add("c.phone = $?", f.phone);
    if (f.email) add("lower(c.email) = lower($?)", f.email);
    const c = decodeCursor(f.cursor);
    if (c) {
      params.push(c[0], c[1]);
      where.push(`(date_trunc('milliseconds', c.updated_at), c.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    const { rows } = await app.db.query(`${CUSTOMER_SQL} WHERE ${where.join(" AND ")} ORDER BY date_trunc('milliseconds', c.updated_at), c.id LIMIT ${f.limit + 1}`, params);
    return page(rows, f.limit, (r) => r.updatedAt);
  });

  app.get<{ Params: { id: string } }>("/v1/customers/:id", async (req, reply) => {
    const ctx = await auth(req, reply, "customers:read");
    const c = await loadCustomer(app.db, ctx.tenantId, parseId(req.params.id, "Customer"));
    if (!c) throw notFound("Customer");
    return c;
  });

  app.post("/v1/customers", async (req, reply) => {
    const ctx = await auth(req, reply, "customers:write");
    return idempotent(app, ctx, req, reply, async () => {
      const body = CustomerSchema.parse(req.body);
      const id = await saveCustomer(app.db, ctx, null, body);
      return { status: 201, body: await loadCustomer(app.db, ctx.tenantId, id) };
    });
  });

  app.patch<{ Params: { id: string } }>("/v1/customers/:id", async (req, reply) => {
    const ctx = await auth(req, reply, "customers:write");
    const id = parseId(req.params.id, "Customer");
    const patch = CustomerPatch.parse(req.body);
    const cur = await loadCustomer(app.db, ctx.tenantId, id);
    if (!cur) throw notFound("Customer");
    const sent = Object.fromEntries(Object.entries(patch).filter(([k]) => k in (req.body as object)));
    const body = CustomerSchema.parse({ name: cur.name, phone: cur.phone, email: cur.email, trn: cur.trn, priceListId: cur.priceListId, ...sent });
    await saveCustomer(app.db, ctx, id, body);
    return loadCustomer(app.db, ctx.tenantId, id);
  });

  // Orders

  const OrderList = Page.extend({
    /** Orders reach the server late when a till was offline, so integrations sync by syncedAt. */
    syncedSince: DateTime.optional(),
    from: DateTime.optional(),
    to: DateTime.optional(),
    storeId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    type: z.enum(["sale", "refund"]).optional(),
  });

  app.get("/v1/orders", async (req, reply) => {
    const ctx = await auth(req, reply, "orders:read");
    const f = OrderList.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["o.tenant_id = $1"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("$?", `$${params.length}`));
    };
    if (f.syncedSince) add("o.synced_at >= $?", f.syncedSince);
    if (f.from) add("o.created_at >= $?", f.from);
    if (f.to) add("o.created_at < $?", f.to);
    if (f.storeId) add("o.store_id = $?", f.storeId);
    if (f.customerId) add("o.customer_id = $?", f.customerId);
    if (f.type) where.push(f.type === "refund" ? "o.refund_of_order_id IS NOT NULL" : "o.refund_of_order_id IS NULL");
    const c = decodeCursor(f.cursor);
    if (c) {
      params.push(c[0], c[1]);
      where.push(`(date_trunc('milliseconds', o.synced_at), o.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    const { rows } = await app.db.query(
      `SELECT o.id, o.synced_at FROM orders o WHERE ${where.join(" AND ")} ORDER BY date_trunc('milliseconds', o.synced_at), o.id LIMIT ${f.limit + 1}`,
      params,
    );
    const p = page(rows as { id: string; synced_at: Date }[], f.limit, (r) => r.synced_at);
    return { data: await loadOrders(app.db, ctx.tenantId, p.data.map((r) => r.id)), nextCursor: p.nextCursor };
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id", async (req, reply) => {
    const ctx = await auth(req, reply, "orders:read");
    const o = await loadOrder(app.db, ctx.tenantId, parseId(req.params.id, "Order"));
    if (!o) throw notFound("Order");
    return o;
  });

  // Inventory

  const StockList = Page.extend({ storeId: z.string().uuid().optional(), productId: z.string().uuid().optional() });

  /** On hand for every product in every store (or one store or product). */
  app.get("/v1/inventory", async (req, reply) => {
    const ctx = await auth(req, reply, "inventory:read");
    const f = StockList.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["p.tenant_id = $1"];
    if (f.storeId) {
      params.push(f.storeId);
      where.push(`s.id = $${params.length}`);
    }
    if (f.productId) {
      params.push(f.productId);
      where.push(`p.id = $${params.length}`);
    }
    // Sorted by product then store; the cursor holds the last product and store.
    const c = decodeCursor(f.cursor);
    if (c) {
      if (!Uuid.safeParse(c[0]).success) throw bad("The cursor is not valid. Pass the nextCursor from the previous page as it is.");
      params.push(c[0], c[1]);
      where.push(`(p.id, s.id) > ($${params.length - 1}::uuid, $${params.length}::uuid)`);
    }
    const { rows } = await app.db.query(
      `SELECT p.id AS "productId", v.id AS "variantId", p.name, v.sku, v.barcode, p.uom, s.id AS "storeId", s.code AS "storeCode",
              COALESCE(m.qty, 0) AS "onHand", v.reorder_level AS "reorderLevel"
         FROM products p
         JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
         JOIN stores s ON s.tenant_id = p.tenant_id
         LEFT JOIN LATERAL (SELECT SUM(qty) AS qty FROM stock_moves WHERE variant_id = v.id AND store_id = s.id) m ON true
        WHERE ${where.join(" AND ")}
        ORDER BY p.id, s.id LIMIT ${f.limit + 1}`,
      params,
    );
    const more = rows.length > f.limit;
    const data = more ? rows.slice(0, f.limit) : rows;
    const last = data.at(-1);
    return { data, nextCursor: more && last ? encodeCursor(last.productId, last.storeId) : null };
  });

  app.post("/v1/inventory/adjustments", async (req, reply) => {
    const ctx = await auth(req, reply, "inventory:write");
    return idempotent(app, ctx, req, reply, async () => {
      const b = ApiAdjustSchema.parse(req.body);
      const { rows } = await app.db.query(
        `SELECT DISTINCT ON (p.id) p.id, v.id AS variant_id FROM products p JOIN variants v ON v.product_id = p.id
          WHERE p.tenant_id = $1 AND p.id = ANY($2) ORDER BY p.id, v.id`,
        [ctx.tenantId, b.lines.map((l) => l.productId)],
      );
      const variantOf = new Map(rows.map((r) => [r.id as string, r.variant_id as string]));
      const missing = b.lines.find((l) => !variantOf.has(l.productId));
      if (missing) throw bad(`Product ${missing.productId} does not exist`);
      const input = AdjustSchema.parse({
        storeId: b.storeId,
        reason: b.reason,
        note: b.note,
        lines: b.lines.map((l) => ({ variantId: variantOf.get(l.productId), qty: l.qty })),
      });
      const result = await withTx(app.db, (tx) => adjustStock(tx, ctx, input));
      return { status: 201, body: result };
    });
  });

  // Reports

  const DailySchema = z.object({ from: Day, to: Day, storeId: z.string().uuid().optional() });

  /** Totals per store per day, in each store's own time zone. Refunds are negative amounts. */
  app.get("/v1/reports/daily-sales", async (req, reply) => {
    const ctx = await auth(req, reply, "reports:read");
    const f = DailySchema.parse(req.query);
    if (f.to < f.from) throw bad("to must be on or after from");
    const days = (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000;
    if (days > 366) throw bad("Ask for at most 366 days at a time");
    const { rows } = await app.db.query(
      `SELECT s.id AS "storeId", s.code AS "storeCode", to_char((o.created_at AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD') AS date,
              COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS "salesCount",
              COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS "refundCount",
              COALESCE(SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NULL), 0)::int AS "grossSales",
              COALESCE(SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS refunds,
              COALESCE(SUM(o.discount_total), 0)::int AS discounts,
              COALESCE(SUM(o.subtotal_net), 0)::int AS "netSales",
              COALESCE(SUM(o.tax_total), 0)::int AS vat,
              COALESCE(SUM(o.total), 0)::int AS total
         FROM orders o JOIN stores s ON s.id = o.store_id
        WHERE o.tenant_id = $1 AND ($4::uuid IS NULL OR s.id = $4)
          AND (o.created_at AT TIME ZONE s.timezone)::date BETWEEN $2::date AND $3::date
        GROUP BY s.id, s.code, 3 ORDER BY 3, s.code`,
      [ctx.tenantId, f.from, f.to, f.storeId ?? null],
    );
    return { data: rows };
  });
}
