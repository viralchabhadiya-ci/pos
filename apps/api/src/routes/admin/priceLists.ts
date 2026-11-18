import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const ListSchema = z.object({
  name: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
});

const ItemsSchema = z.object({
  items: z
    .array(z.object({ variantId: z.string().uuid(), price: z.number().int().min(0).max(100_000_000) }))
    .min(1)
    .max(2000),
});

const nameTaken = () => new HttpError(409, "name_taken", "Another price list already has this name");

/**
 * Price lists: other prices for some products, for a kind of customer (wholesale, staff)
 * or for one store. On the till a customer's list wins over the store's; products not on
 * the list keep their own price.
 */
export async function priceListRoutes(app: FastifyInstance) {
  app.get("/price-lists", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT l.id, l.name, l.active, l.updated_at AS "updatedAt",
              (SELECT COUNT(*)::int FROM price_list_items i WHERE i.price_list_id = l.id AND i.active) AS "itemCount",
              (SELECT COUNT(*)::int FROM customers c WHERE c.price_list_id = l.id) AS "customerCount",
              COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.code)
                          FROM stores s WHERE s.price_list_id = l.id), '[]') AS stores
         FROM price_lists l WHERE l.tenant_id = $1 ORDER BY l.active DESC, l.name`,
      [ctx.tenantId],
    );
    return { priceLists: rows };
  });

  app.get<{ Params: { id: string } }>("/price-lists/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query("SELECT id, name, active FROM price_lists WHERE id = $1 AND tenant_id = $2", [
      req.params.id,
      ctx.tenantId,
    ]);
    if (!rows[0]) throw notFound("Price list");
    const items = await app.db.query(
      `SELECT i.variant_id AS "variantId", p.id AS "productId", p.name, v.sku, v.barcode, v.price AS "basePrice", i.price,
              p.active AND v.active AS "productActive"
         FROM price_list_items i JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
        WHERE i.price_list_id = $1 AND i.active ORDER BY p.name`,
      [req.params.id],
    );
    return { ...rows[0], items: items.rows };
  });

  app.post("/price-lists", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = ListSchema.parse(req.body);
    const id = randomUUID();
    try {
      await app.db.query("INSERT INTO price_lists (id, tenant_id, name, active) VALUES ($1, $2, $3, $4)", [
        id,
        ctx.tenantId,
        body.name,
        body.active,
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await adminAudit(app.db, ctx, "price_list.create", "price_list", id, body);
    return { id };
  });

  app.put<{ Params: { id: string } }>("/price-lists/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = ListSchema.parse(req.body);
    try {
      const res = await app.db.query(
        "UPDATE price_lists SET name = $3, active = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2",
        [req.params.id, ctx.tenantId, body.name, body.active],
      );
      if (!res.rowCount) throw notFound("Price list");
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await adminAudit(app.db, ctx, "price_list.update", "price_list", req.params.id, body);
    return { id: req.params.id };
  });

  /** Adds products to the list or changes their price. */
  app.put<{ Params: { id: string } }>("/price-lists/:id/items", async (req) => {
    const ctx = await app.authAdmin(req);
    const { items } = ItemsSchema.parse(req.body);
    const variantIds = [...new Set(items.map((i) => i.variantId))];
    if (variantIds.length !== items.length) throw new HttpError(400, "bad_request", "A product is listed twice");
    await withTx(app.db, async (tx) => {
      const list = await tx.query("SELECT 1 FROM price_lists WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [req.params.id, ctx.tenantId]);
      if (!list.rowCount) throw notFound("Price list");
      const known = await tx.query("SELECT COUNT(*)::int AS n FROM variants WHERE tenant_id = $1 AND id = ANY($2)", [ctx.tenantId, variantIds]);
      if (known.rows[0].n !== variantIds.length) throw new HttpError(400, "bad_request", "Some of these products do not exist");
      await tx.query(
        `INSERT INTO price_list_items (price_list_id, variant_id, tenant_id, price, active, updated_at)
         SELECT $1, x.variant_id, $2, x.price, true, now()
           FROM unnest($3::uuid[], $4::int[]) AS x(variant_id, price)
         ON CONFLICT (price_list_id, variant_id) DO UPDATE SET price = excluded.price, active = true, updated_at = now()`,
        [req.params.id, ctx.tenantId, items.map((i) => i.variantId), items.map((i) => i.price)],
      );
      await adminAudit(tx, ctx, "price_list.items", "price_list", req.params.id, {
        count: items.length,
        ...(items.length <= 5 ? { items } : {}),
      });
    });
    return { id: req.params.id, count: items.length };
  });

  /** Takes a product off the list; it goes back to its own price. */
  app.delete<{ Params: { id: string; variantId: string } }>("/price-lists/:id/items/:variantId", async (req) => {
    const ctx = await app.authAdmin(req);
    const res = await app.db.query(
      `UPDATE price_list_items SET active = false, updated_at = now()
        WHERE price_list_id = $1 AND variant_id = $2 AND tenant_id = $3 AND active`,
      [req.params.id, req.params.variantId, ctx.tenantId],
    );
    if (!res.rowCount) throw notFound("Price list item");
    await adminAudit(app.db, ctx, "price_list.remove_item", "price_list", req.params.id, { variantId: req.params.variantId });
    return { ok: true };
  });
}
