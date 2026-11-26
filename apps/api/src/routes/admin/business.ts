import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, notFound } from "../../errors.js";
import type { AdminContext } from "../../app.js";
import { withTx, type Db } from "../../db.js";
import { loadCustomer } from "../../public/serialize.js";
import { emitEvent } from "../../webhooks/events.js";
import { planUsage } from "../../tenants.js";
import { adminAudit, forbidden, isUniqueViolation } from "./common.js";

const empty = (s: string | null | undefined) => (s ? s : null);

export const CustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email("Enter a valid email").max(200).or(z.literal("")).nullish(),
  /** A business customer's VAT number, printed on their tax invoice. */
  trn: z
    .string()
    .trim()
    .regex(/^(\d{15})?$/, "A TRN has 15 digits")
    .nullish(),
  /** Their own prices (wholesale, staff); null for normal prices. */
  priceListId: z.string().uuid().nullish(),
  /** Leave out to keep what is recorded; null clears. */
  birthMonth: z.number().int().min(1).max(12).nullish(),
  birthDay: z.number().int().min(1).max(31).nullish(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
  /** Marketing consent per channel; leave out to keep what is recorded. */
  consent: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }).optional(),
});

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function checkBirthday(b: { birthMonth?: number | null; birthDay?: number | null }) {
  if (b.birthDay && !b.birthMonth) throw new HttpError(400, "bad_request", "Pick the month of the birthday");
  if (b.birthMonth && b.birthDay && b.birthDay > MONTH_DAYS[b.birthMonth - 1]!) throw new HttpError(400, "bad_request", "That month does not have that many days");
}

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
  /** Prices for this store; a customer's own list still wins. */
  priceListId: z.string().uuid().nullish(),
  /** A franchise store pays HQ a royalty and a marketing fee on its net sales. */
  ownership: z.enum(["owned", "franchise"]).default("owned"),
  franchisee: z.string().trim().max(200).nullish(),
  royaltyBp: z.number().int().min(0).max(10000).default(0),
  marketingFeeBp: z.number().int().min(0).max(10000).default(0),
});

/** Fees only apply to franchise stores. */
function fees(body: z.infer<typeof StoreSchema>) {
  const franchise = body.ownership === "franchise";
  return [body.ownership, franchise ? empty(body.franchisee) : null, franchise ? body.royaltyBp : 0, franchise ? body.marketingFeeBp : 0];
}

const STORE_SELECT = `SELECT id, code, name, name_ar AS "nameAr", address, phone, trn, timezone,
  cash_rounding_step AS "cashRoundingStep", receipt_footer AS "receiptFooter", price_list_id AS "priceListId",
  ownership, franchisee, royalty_bp AS "royaltyBp", marketing_fee_bp AS "marketingFeeBp" FROM stores`;

/** Adds a customer, or changes one when `id` is given. Used by the back office and the public API. */
export async function saveCustomer(db: Db, ctx: AdminContext, id: string | null, body: z.infer<typeof CustomerSchema>) {
  if (body.phone) {
    const { rowCount } = await db.query("SELECT 1 FROM customers WHERE tenant_id = $1 AND phone = $2 AND id IS DISTINCT FROM $3", [
      ctx.tenantId,
      body.phone,
      id,
    ]);
    if (rowCount) throw new HttpError(409, "phone_taken", "Another customer has this phone number");
  }
  checkBirthday(body);
  if (body.priceListId) {
    const { rowCount } = await db.query("SELECT 1 FROM price_lists WHERE id = $1 AND tenant_id = $2", [body.priceListId, ctx.tenantId]);
    if (!rowCount) throw new HttpError(400, "bad_request", "That price list does not exist");
  }
  return withTx(db, async (tx) => {
    const values = [empty(body.phone), empty(body.email), empty(body.trn), body.priceListId ?? null];
    const created = !id;
    if (!id) {
      id = randomUUID();
      await tx.query(
        `INSERT INTO customers (id, tenant_id, name, phone, email, trn, price_list_id, birth_month, birth_day, tags,
                               consent_email, consent_sms, consent_whatsapp, consent_at, consent_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $14 THEN now() END, CASE WHEN $14 THEN 'back_office' END)`,
        [id, ctx.tenantId, body.name, ...values, body.birthMonth ?? null, body.birthDay ?? null, body.tags ?? [], body.consent?.email ?? false,
          body.consent?.sms ?? false, body.consent?.whatsapp ?? false, !!body.consent],
      );
      await adminAudit(tx, ctx, "customer.create", "customer", id, { name: body.name });
    } else {
      const res = await tx.query(
        `UPDATE customers SET name = $3, phone = $4, email = $5, trn = $6, price_list_id = $7,
                birth_month = CASE WHEN $8 THEN $9 ELSE birth_month END, birth_day = CASE WHEN $8 THEN $10 ELSE birth_day END,
                tags = COALESCE($11, tags),
                consent_at = CASE WHEN $12::boolean IS NOT NULL AND (consent_email, consent_sms, consent_whatsapp) IS DISTINCT FROM ($12, $13, $14)
                                  THEN now() ELSE consent_at END,
                consent_source = CASE WHEN $12::boolean IS NOT NULL AND (consent_email, consent_sms, consent_whatsapp) IS DISTINCT FROM ($12, $13, $14)
                                      THEN 'back_office' ELSE consent_source END,
                consent_email = COALESCE($12, consent_email), consent_sms = COALESCE($13, consent_sms),
                consent_whatsapp = COALESCE($14, consent_whatsapp), updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [id, ctx.tenantId, body.name, ...values, body.birthMonth !== undefined || body.birthDay !== undefined, body.birthMonth ?? null,
          body.birthDay ?? null, body.tags ?? null, body.consent?.email ?? null, body.consent?.sms ?? null, body.consent?.whatsapp ?? null],
      );
      if (!res.rowCount) throw notFound("Customer");
      await adminAudit(tx, ctx, "customer.update", "customer", id, { name: body.name, ...(body.consent ? { consent: body.consent } : {}) });
    }
    const saved = id;
    await emitEvent(tx, ctx.tenantId, created ? "customer.created" : "customer.updated", async () => loadCustomer(tx, ctx.tenantId, saved));
    return saved;
  });
}

export async function businessRoutes(app: FastifyInstance) {
  async function checkPriceList(tenantId: string, id: string | null | undefined) {
    if (!id) return;
    const { rowCount } = await app.db.query("SELECT 1 FROM price_lists WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    if (!rowCount) throw new HttpError(400, "bad_request", "That price list does not exist");
  }

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
      `SELECT c.id, c.name, c.phone, c.email, c.trn, c.price_list_id AS "priceListId", pl.name AS "priceListName", c.points, st.orders, st.spent, st."lastVisit"
         FROM customers c
         JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS orders,
                              COALESCE(SUM(o.total), 0)::int AS spent, MAX(o.created_at) AS "lastVisit"
                         FROM orders o WHERE o.customer_id = c.id) st ON true
         LEFT JOIN price_lists pl ON pl.id = c.price_list_id
        WHERE ${where} ORDER BY st."lastVisit" DESC NULLS LAST, c.name LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { customers: rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT c.id, c.name, c.phone, c.email, c.trn, c.price_list_id AS "priceListId", pl.name AS "priceListName", c.points,
              c.birth_month AS "birthMonth", c.birth_day AS "birthDay", c.tags,
              json_build_object('email', c.consent_email, 'sms', c.consent_sms, 'whatsapp', c.consent_whatsapp) AS consent,
              c.consent_at AS "consentAt", c.consent_source AS "consentSource"
         FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id WHERE c.id = $1 AND c.tenant_id = $2`,
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

  app.post("/customers", async (req) => {
    const ctx = await app.authAdmin(req);
    return { id: await saveCustomer(app.db, ctx, null, CustomerSchema.parse(req.body)) };
  });

  app.put<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    return { id: await saveCustomer(app.db, ctx, req.params.id, CustomerSchema.parse(req.body)) };
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
    const { rows } = await app.db.query(
      `${STORE_SELECT} WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY code`,
      [ctx.tenantId, ctx.storeIds],
    );
    return { stores: rows };
  });

  /** A new store with its first register, within the plan's store limit. */
  app.post("/stores", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can add a store");
    const body = StoreSchema.extend({
      code: z
        .string()
        .trim()
        .min(2)
        .max(8)
        .regex(/^[A-Za-z0-9]+$/, "Use letters and numbers, e.g. DXB2"),
    }).parse(req.body);
    await checkPriceList(ctx.tenantId, body.priceListId);
    const usage = await planUsage(app.db, ctx.tenantId);
    if (usage.maxStores !== null && usage.stores >= usage.maxStores) {
      throw new HttpError(409, "plan_limit", `The ${usage.planName} plan includes ${usage.maxStores} store${usage.maxStores === 1 ? "" : "s"}. Contact us to move to a bigger plan.`);
    }
    if (usage.maxRegisters !== null && usage.registers >= usage.maxRegisters) {
      throw new HttpError(409, "plan_limit", `The ${usage.planName} plan includes ${usage.maxRegisters} registers, and a new store needs one.`);
    }
    const id = randomUUID();
    try {
      await withTx(app.db, async (tx) => {
        await tx.query(
          `INSERT INTO stores (id, tenant_id, code, name, name_ar, address, phone, trn, timezone, cash_rounding_step, receipt_footer,
             price_list_id, ownership, franchisee, royalty_bp, marketing_fee_bp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [id, ctx.tenantId, body.code.toUpperCase(), body.name, empty(body.nameAr), empty(body.address), empty(body.phone),
            empty(body.trn), body.timezone, body.cashRoundingStep, empty(body.receiptFooter), body.priceListId ?? null, ...fees(body)],
        );
        await tx.query("INSERT INTO registers (id, store_id, code, name) VALUES ($1, $2, 'R1', 'Counter 1')", [randomUUID(), id]);
        await adminAudit(tx, ctx, "store.create", "store", id, { name: body.name, code: body.code.toUpperCase() });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "code_taken", "Another store already uses this code");
      throw err;
    }
    return { id };
  });

  /** Receipt details reach the tills with their next catalog sync. */
  app.put<{ Params: { id: string } }>("/stores/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change store details");
    const body = StoreSchema.parse(req.body);
    await checkPriceList(ctx.tenantId, body.priceListId);
    const res = await app.db.query(
      `UPDATE stores SET name = $3, name_ar = $4, address = $5, phone = $6, trn = $7, timezone = $8,
              cash_rounding_step = $9, receipt_footer = $10, price_list_id = $11, ownership = $12, franchisee = $13,
              royalty_bp = $14, marketing_fee_bp = $15, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, ctx.tenantId, body.name, empty(body.nameAr), empty(body.address), empty(body.phone), empty(body.trn),
        body.timezone, body.cashRoundingStep, empty(body.receiptFooter), body.priceListId ?? null, ...fees(body)],
    );
    if (!res.rowCount) throw notFound("Store");
    await adminAudit(app.db, ctx, "store.update", "store", req.params.id, body);
    return { id: req.params.id };
  });
}
