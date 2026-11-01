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

    const [taxes, categories, products, variants, paymentMethods, users, stores] = await Promise.all([
      q(`SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded", kind, active
           FROM taxes WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, parent_id AS "parentId", name, name_ar AS "nameAr", sort, active
           FROM categories WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, category_id AS "categoryId", name, name_ar AS "nameAr", uom, tax_id AS "taxId", active
           FROM products WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, product_id AS "productId", sku, barcode, extra_barcodes AS "extraBarcodes", attributes, price, active
           FROM variants WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, kind, active FROM payment_methods WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, role, pin_salt AS "pinSalt", pin_hash AS "pinHash", active
           FROM users WHERE tenant_id = $1 AND updated_at > $2`),
      // The till's own store, so receipt details edited in the back office reach it.
      app.db
        .query(
          `SELECT id, code, name, name_ar AS "nameAr", address, phone, trn, timezone,
                  cash_rounding_step AS "cashRoundingStep", receipt_footer AS "receiptFooter"
             FROM stores WHERE id = $1 AND updated_at > $2`,
          [device.storeId, since ?? "-infinity"],
        )
        .then((r) => r.rows),
    ]);
    return { serverTime, full: !since, taxes, categories, products, variants, paymentMethods, users, store: stores[0] ?? null };
  });
}
