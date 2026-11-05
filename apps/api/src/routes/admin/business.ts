import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, notFound } from "../../errors.js";
import { adminAudit, forbidden } from "./common.js";

const empty = (s: string | null | undefined) => (s ? s : null);

const CustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email("Enter a valid email").max(200).or(z.literal("")).nullish(),
  /** A business customer's VAT number, printed on their tax invoice. */
  trn: z
    .string()
    .trim()
    .regex(/^(\d{15})?$/, "A TRN has 15 digits")
    .nullish(),
});

const PageSchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const AuditSchema = PageSchema.extend({
  entity: z.string().trim().max(40).optional(),
  userId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

const StoreSchema = z.object({
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).nullish(),
  address: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(30).nullish(),
  trn: z
    .string()
    .trim()
    .regex(/^(\d{15})?$/, "A TRN has 15 digits")
    .nullish(),
  timezone: z.string().refine((t) => TIMEZONES.has(t), "Unknown timezone"),
  /** Cash totals round to this many fils; 0 turns rounding off. */
  cashRoundingStep: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(25), z.literal(50), z.literal(100)]),
  receiptFooter: z.string().trim().max(300).nullish(),
});

const STORE_SELECT = `SELECT id, code, name, name_ar AS "nameAr", address, phone, trn, timezone,
  cash_rounding_step AS "cashRoundingStep", receipt_footer AS "receiptFooter" FROM stores`;

export async function businessRoutes(app: FastifyInstance) {
  // Customers

  app.get("/customers", async (req) => {
    const ctx = await app.authAdmin(req);
    const { q, limit, offset } = PageSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    let where = "c.tenant_id = $1";
    if (q) {
      const digits = q.replace(/\D/g, "");
      params.push(`%${q}%`, digits ? `%${digits}%` : null);
      where += ` AND (c.name ILIKE $2 OR c.email ILIKE $2 OR ($3::text IS NOT NULL AND c.phone LIKE $3))`;
    }
    const count = await app.db.query(`SELECT COUNT(*)::int AS n FROM customers c WHERE ${where}`, params);
    const { rows } = await app.db.query(
      `SELECT c.id, c.name, c.phone, c.email, c.trn, st.orders, st.spent, st."lastVisit"
         FROM customers c
         JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS orders,
                              COALESCE(SUM(o.total), 0)::int AS spent, MAX(o.created_at) AS "lastVisit"
                         FROM orders o WHERE o.customer_id = c.id) st ON true
        WHERE ${where} ORDER BY st."lastVisit" DESC NULLS LAST, c.name LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { customers: rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      "SELECT id, name, phone, email, trn FROM customers WHERE id = $1 AND tenant_id = $2",
      [req.params.id, ctx.tenantId],
    );
    if (!rows[0]) throw notFound("Customer");
    const orders = await app.db.query(
      `SELECT id, number, created_at AS "createdAt", total, refund_of_order_id IS NOT NULL AS "isRefund"
         FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id],
    );
    return { ...rows[0], orders: orders.rows };
  });

  async function phoneTaken(tenantId: string, phone: string | null | undefined, exceptId: string | null) {
    if (!phone) return;
    const { rowCount } = await app.db.query(
      "SELECT 1 FROM customers WHERE tenant_id = $1 AND phone = $2 AND id IS DISTINCT FROM $3",
      [tenantId, phone, exceptId],
    );
    if (rowCount) throw new HttpError(409, "phone_taken", "Another customer has this phone number");
  }

  app.post("/customers", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = CustomerSchema.parse(req.body);
    await phoneTaken(ctx.tenantId, body.phone, null);
    const id = randomUUID();
    await app.db.query(
      "INSERT INTO customers (id, tenant_id, name, phone, email, trn) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, ctx.tenantId, body.name, empty(body.phone), empty(body.email), empty(body.trn)],
    );
    await adminAudit(app.db, ctx, "customer.create", "customer", id, { name: body.name });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = CustomerSchema.parse(req.body);
    await phoneTaken(ctx.tenantId, body.phone, req.params.id);
    const res = await app.db.query(
      `UPDATE customers SET name = $3, phone = $4, email = $5, trn = $6, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, ctx.tenantId, body.name, empty(body.phone), empty(body.email), empty(body.trn)],
    );
    if (!res.rowCount) throw notFound("Customer");
    await adminAudit(app.db, ctx, "customer.update", "customer", req.params.id, { name: body.name });
    return { id: req.params.id };
  });

  // Audit log

  app.get("/audit", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = AuditSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["a.tenant_id = $1"];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll("$?", `$${params.length}`));
    };
    if (f.entity) add("a.entity = $?", f.entity);
    if (f.userId) add("a.user_id = $?", f.userId);
    if (f.from) add("a.at >= ($?::date)::timestamp AT TIME ZONE 'Asia/Dubai'", f.from);
    if (f.to) add("a.at < ($?::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai'", f.to);
    if (f.q) add("(a.action ILIKE $? OR a.data::text ILIKE $?)", `%${f.q}%`);
    const sql = where.join(" AND ");
    const count = await app.db.query(`SELECT COUNT(*)::int AS n FROM audit_log a WHERE ${sql}`, params);
    const { rows } = await app.db.query(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id AS "entityId", a.data,
              u.name AS "userName", d.name AS "deviceName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN devices d ON d.id = a.device_id
        WHERE ${sql} ORDER BY a.at DESC, a.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      params,
    );
    return { entries: rows, count: count.rows[0].n };
  });

  // Stores and receipt settings

  app.get("/stores", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${STORE_SELECT} WHERE tenant_id = $1 ORDER BY code`, [ctx.tenantId]);
    return { stores: rows };
  });

  /** Receipt details reach the tills with their next catalog sync. */
  app.put<{ Params: { id: string } }>("/stores/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change store details");
    const body = StoreSchema.parse(req.body);
    const res = await app.db.query(
      `UPDATE stores SET name = $3, name_ar = $4, address = $5, phone = $6, trn = $7, timezone = $8,
              cash_rounding_step = $9, receipt_footer = $10, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, ctx.tenantId, body.name, empty(body.nameAr), empty(body.address), empty(body.phone), empty(body.trn),
        body.timezone, body.cashRoundingStep, empty(body.receiptFooter)],
    );
    if (!res.rowCount) throw notFound("Store");
    await adminAudit(app.db, ctx, "store.update", "store", req.params.id, body);
    return { id: req.params.id };
  });
}
