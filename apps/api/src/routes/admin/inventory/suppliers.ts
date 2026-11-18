import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../../../errors.js";
import { adminAudit, isUniqueViolation } from "../common.js";
import { HttpError } from "../../../errors.js";
import { empty } from "./common.js";

const SupplierSchema = z.object({
  name: z.string().trim().min(1).max(160),
  contactName: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().email().max(200).nullish().or(z.literal("")),
  trn: z.string().trim().regex(/^\d{15}$/, "A TRN has 15 digits").nullish().or(z.literal("")),
  address: z.string().trim().max(400).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  leadTimeDays: z.number().int().min(0).max(120).default(3),
  notes: z.string().trim().max(1000).nullish(),
  active: z.boolean().default(true),
});

const ListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
});

const SELECT = `
  SELECT s.id, s.name, s.contact_name AS "contactName", s.phone, s.email, s.trn, s.address,
         s.payment_terms_days AS "paymentTermsDays", s.lead_time_days AS "leadTimeDays", s.notes, s.active,
         (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('ordered', 'partial')) AS "openOrders",
         (SELECT COUNT(*)::int FROM supplier_items si WHERE si.supplier_id = s.id) AS "itemCount",
         (SELECT MAX(r.received_at) FROM goods_receipts r WHERE r.supplier_id = s.id) AS "lastDelivery"
    FROM suppliers s`;

const nameTaken = () => new HttpError(409, "name_taken", "Another supplier already has this name");

export async function supplierRoutes(app: FastifyInstance) {
  app.get("/suppliers", async (req) => {
    const ctx = await app.authAdmin(req);
    const { q, status } = ListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["s.tenant_id = $1"];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(s.name ILIKE $2 OR s.contact_name ILIKE $2 OR s.phone ILIKE $2 OR s.email ILIKE $2)`);
    }
    if (status !== "all") where.push(status === "active" ? "s.active" : "NOT s.active");
    const { rows } = await app.db.query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY lower(s.name) LIMIT 500`, params);
    return { suppliers: rows };
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${SELECT} WHERE s.id = $1 AND s.tenant_id = $2`, [req.params.id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Supplier");
    const items = await app.db.query(
      `SELECT si.variant_id AS "variantId", p.id AS "productId", p.name, v.barcode, si.supplier_sku AS "supplierSku",
              si.unit_cost AS "unitCost", si.updated_at AS "updatedAt"
         FROM supplier_items si JOIN variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
        WHERE si.supplier_id = $1 ORDER BY p.name`,
      [req.params.id],
    );
    return { ...rows[0], items: items.rows };
  });

  app.post("/suppliers", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = SupplierSchema.parse(req.body);
    const id = randomUUID();
    try {
      await app.db.query(
        `INSERT INTO suppliers (id, tenant_id, name, contact_name, phone, email, trn, address, payment_terms_days, lead_time_days, notes, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, ctx.tenantId, b.name, empty(b.contactName), empty(b.phone), empty(b.email), empty(b.trn), empty(b.address),
          b.paymentTermsDays, b.leadTimeDays, empty(b.notes), b.active],
      );
    } catch (err) {
      throw isUniqueViolation(err) ? nameTaken() : err;
    }
    await adminAudit(app.db, ctx, "supplier.create", "supplier", id, { name: b.name });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/suppliers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = SupplierSchema.parse(req.body);
    let res;
    try {
      res = await app.db.query(
        `UPDATE suppliers SET name = $3, contact_name = $4, phone = $5, email = $6, trn = $7, address = $8,
                payment_terms_days = $9, lead_time_days = $10, notes = $11, active = $12, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, ctx.tenantId, b.name, empty(b.contactName), empty(b.phone), empty(b.email), empty(b.trn), empty(b.address),
          b.paymentTermsDays, b.leadTimeDays, empty(b.notes), b.active],
      );
    } catch (err) {
      throw isUniqueViolation(err) ? nameTaken() : err;
    }
    if (!res.rowCount) throw notFound("Supplier");
    await adminAudit(app.db, ctx, "supplier.update", "supplier", req.params.id, { name: b.name, active: b.active });
    return { id: req.params.id };
  });
}
