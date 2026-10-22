import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const CategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  nameAr: z.string().trim().max(80).nullish(),
  sort: z.number().int().min(0).max(10_000).default(0),
  active: z.boolean().default(true),
});

const ProductSchema = z.object({
  name: z.string().trim().min(1).max(160),
  nameAr: z.string().trim().max(160).nullish(),
  categoryId: z.string().uuid().nullish(),
  uom: z.enum(["unit", "kg"]).default("unit"),
  taxId: z.string().uuid().nullish(),
  /** Price in fils, VAT included when the tax is price-included. */
  price: z.number().int().min(0).max(100_000_000),
  cost: z.number().int().min(0).max(100_000_000).nullish(),
  barcode: z.string().trim().max(64).nullish(),
  sku: z.string().trim().max(64).nullish(),
  active: z.boolean().default(true),
});

const StockSchema = z.object({
  storeId: z.string().uuid(),
  qty: z.number().refine((n) => n !== 0, "Quantity cannot be zero"),
  reason: z.enum(["receive", "adjust"]),
});

const ListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(["active", "inactive", "all"]).default("all"),
});

const PRODUCT_SELECT = `
  SELECT p.id, v.id AS "variantId", p.name, p.name_ar AS "nameAr", p.category_id AS "categoryId", c.name AS "categoryName",
         p.uom, p.tax_id AS "taxId", v.price, v.cost, v.barcode, v.sku, p.active, p.updated_at AS "updatedAt",
         COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.variant_id = v.id), 0) AS "onHand"
    FROM products p
    JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
    LEFT JOIN categories c ON c.id = p.category_id`;

const empty = (s: string | null | undefined) => (s ? s : null);

export async function catalogRoutes(app: FastifyInstance) {
  async function checkRefs(tenantId: string, body: { categoryId?: string | null; taxId?: string | null }) {
    if (body.categoryId) {
      const c = await app.db.query("SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2", [body.categoryId, tenantId]);
      if (!c.rowCount) throw new HttpError(400, "bad_request", "That category does not exist");
    }
    if (body.taxId) {
      const t = await app.db.query("SELECT 1 FROM taxes WHERE id = $1 AND tenant_id = $2", [body.taxId, tenantId]);
      if (!t.rowCount) throw new HttpError(400, "bad_request", "That tax does not exist");
    }
  }

  const barcodeTaken = () => new HttpError(409, "barcode_taken", "Another product already uses this barcode");

  app.get("/taxes", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded", active FROM taxes WHERE tenant_id = $1 ORDER BY rate_bp`,
      [ctx.tenantId],
    );
    return { taxes: rows };
  });

  app.get("/categories", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT c.id, c.name, c.name_ar AS "nameAr", c.sort, c.active,
              (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id AND p.active) AS "productCount"
         FROM categories c WHERE c.tenant_id = $1 ORDER BY c.sort, c.name`,
      [ctx.tenantId],
    );
    return { categories: rows };
  });

  app.post("/categories", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = CategorySchema.parse(req.body);
    const id = randomUUID();
    await app.db.query(
      "INSERT INTO categories (id, tenant_id, name, name_ar, sort, active) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, ctx.tenantId, body.name, empty(body.nameAr), body.sort, body.active],
    );
    await adminAudit(app.db, ctx, "category.create", "category", id, { name: body.name });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/categories/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = CategorySchema.parse(req.body);
    const res = await app.db.query(
      `UPDATE categories SET name = $3, name_ar = $4, sort = $5, active = $6, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, ctx.tenantId, body.name, empty(body.nameAr), body.sort, body.active],
    );
    if (!res.rowCount) throw notFound("Category");
    await adminAudit(app.db, ctx, "category.update", "category", req.params.id, body);
    return { id: req.params.id };
  });

  app.get("/products", async (req) => {
    const ctx = await app.authAdmin(req);
    const { q, categoryId, status } = ListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["p.tenant_id = $1"];
    if (q) {
      params.push(`%${q}%`, q);
      where.push(`(p.name ILIKE $${params.length - 1} OR p.name_ar ILIKE $${params.length - 1} OR v.barcode = $${params.length} OR v.sku = $${params.length})`);
    }
    if (categoryId) {
      params.push(categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    if (status !== "all") where.push(status === "active" ? "p.active" : "NOT p.active");
    const { rows } = await app.db.query(`${PRODUCT_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.name LIMIT 500`, params);
    return { products: rows };
  });

  app.get<{ Params: { id: string } }>("/products/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${PRODUCT_SELECT} WHERE p.id = $1 AND p.tenant_id = $2`, [req.params.id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Product");
    return rows[0];
  });

  /** Products sell as a single variant for now; the variant holds price, barcode and stock. */
  app.post("/products", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = ProductSchema.parse(req.body);
    await checkRefs(ctx.tenantId, body);
    const id = randomUUID();
    try {
      await withTx(app.db, async (tx) => {
        await tx.query(
          `INSERT INTO products (id, tenant_id, category_id, name, name_ar, uom, tax_id, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, ctx.tenantId, body.categoryId ?? null, body.name, empty(body.nameAr), body.uom, body.taxId ?? null, body.active],
        );
        await tx.query(
          `INSERT INTO variants (id, tenant_id, product_id, sku, barcode, price, cost, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [randomUUID(), ctx.tenantId, id, empty(body.sku), empty(body.barcode), body.price, body.cost ?? null, body.active],
        );
        await adminAudit(tx, ctx, "product.create", "product", id, { name: body.name, price: body.price });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw barcodeTaken();
      throw err;
    }
    return { id };
  });

  app.put<{ Params: { id: string } }>("/products/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = ProductSchema.parse(req.body);
    await checkRefs(ctx.tenantId, body);
    try {
      await withTx(app.db, async (tx) => {
        const before = await tx.query(`${PRODUCT_SELECT} WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p`, [
          req.params.id,
          ctx.tenantId,
        ]);
        const old = before.rows[0];
        if (!old) throw notFound("Product");
        await tx.query(
          `UPDATE products SET category_id = $3, name = $4, name_ar = $5, uom = $6, tax_id = $7, active = $8, updated_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [req.params.id, ctx.tenantId, body.categoryId ?? null, body.name, empty(body.nameAr), body.uom, body.taxId ?? null, body.active],
        );
        await tx.query(
          `UPDATE variants SET sku = $2, barcode = $3, price = $4, cost = $5, active = $6, updated_at = now() WHERE id = $1`,
          [old.variantId, empty(body.sku), empty(body.barcode), body.price, body.cost ?? null, body.active],
        );
        // Price changes are what managers most often need to trace later.
        await adminAudit(tx, ctx, "product.update", "product", req.params.id, {
          name: body.name,
          ...(old.price !== body.price ? { priceFrom: old.price, priceTo: body.price } : {}),
          ...(old.active !== body.active ? { active: body.active } : {}),
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw barcodeTaken();
      throw err;
    }
    return { id: req.params.id };
  });

  /** Goods received or a stock count correction, written to the stock ledger. */
  app.post<{ Params: { id: string } }>("/products/:id/stock", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = StockSchema.parse(req.body);
    const { rows } = await app.db.query(
      `SELECT v.id FROM variants v JOIN stores s ON s.id = $3 AND s.tenant_id = v.tenant_id
        WHERE v.product_id = $1 AND v.tenant_id = $2 ORDER BY v.id LIMIT 1`,
      [req.params.id, ctx.tenantId, body.storeId],
    );
    if (!rows[0]) throw notFound("Product or store");
    await withTx(app.db, async (tx) => {
      await tx.query(
        "INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason) VALUES ($1, $2, $3, $4, $5)",
        [ctx.tenantId, body.storeId, rows[0].id, body.qty, body.reason],
      );
      await adminAudit(tx, ctx, `stock.${body.reason}`, "product", req.params.id, { qty: body.qty, storeId: body.storeId });
    });
    const onHand = await app.db.query("SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves WHERE variant_id = $1", [rows[0].id]);
    return { onHand: onHand.rows[0].n };
  });
}
