import type { FastifyInstance } from "fastify";
import { z } from "zod";

const QuerySchema = z.object({ since: z.string().datetime().optional() });

/**
 * Catalog sync. Without `since` the till gets a full snapshot; with it, only rows changed
 * after that time (inactive rows included, so the till can hide them).
 */
export async function syncRoutes(app: FastifyInstance) {
  app.get("/sync/catalog", async (req) => {
    const device = await app.authenticate(req);
    const { since } = QuerySchema.parse(req.query);
    const serverTime = new Date().toISOString();
    const params = [device.tenantId, since ?? "-infinity"];
    const q = (sql: string) => app.db.query(sql, params).then((r) => r.rows);

    const [taxes, categories, products, variants, paymentMethods, users] = await Promise.all([
      q(`SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded", active
           FROM taxes WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, parent_id AS "parentId", name, name_ar AS "nameAr", sort, active
           FROM categories WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, category_id AS "categoryId", name, name_ar AS "nameAr", uom, tax_id AS "taxId", active
           FROM products WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, product_id AS "productId", sku, barcode, attributes, price, active
           FROM variants WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, kind, active FROM payment_methods WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, role, pin_salt AS "pinSalt", pin_hash AS "pinHash", active
           FROM users WHERE tenant_id = $1 AND updated_at > $2`),
    ]);
    return { serverTime, full: !since, taxes, categories, products, variants, paymentMethods, users };
  });
}
