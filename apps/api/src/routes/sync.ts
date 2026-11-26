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

    const [taxes, categories, products, variants, paymentMethods, users, stores, promotions, priceLists, priceListItems, loyalty, scale, modifierGroups, tables] = await Promise.all([
      q(`SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded", kind, active
           FROM taxes WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, parent_id AS "parentId", name, name_ar AS "nameAr", sort, active
           FROM categories WHERE tenant_id = $1 AND updated_at > $2`),
      // A product the store leaves out of its range goes out as switched off.
      app.db
        .query(
          `SELECT p.id, p.category_id AS "categoryId", p.name, p.name_ar AS "nameAr", p.uom, p.tax_id AS "taxId", p.modifier_group_ids AS "modifierGroupIds",
                  (p.active AND NOT EXISTS (SELECT 1 FROM store_hidden_products h WHERE h.product_id = p.id AND h.store_id = $3)) AS active
             FROM products p WHERE p.tenant_id = $1 AND p.updated_at > $2`,
          [...params, device.storeId],
        )
        .then((r) => r.rows),
      q(`SELECT id, product_id AS "productId", sku, barcode, extra_barcodes AS "extraBarcodes", plu, attributes, price, active
           FROM variants WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, kind, active FROM payment_methods WHERE tenant_id = $1 AND updated_at > $2`),
      // Staff limited to other stores cannot sign in on this till.
      app.db
        .query(
          `SELECT u.id, u.name, u.role, u.pin_salt AS "pinSalt", u.pin_hash AS "pinHash",
                  (u.active AND (u.role = 'owner' OR NOT EXISTS (SELECT 1 FROM user_stores us WHERE us.user_id = u.id)
                    OR EXISTS (SELECT 1 FROM user_stores us WHERE us.user_id = u.id AND us.store_id = $3))) AS active
             FROM users u WHERE u.tenant_id = $1 AND u.updated_at > $2`,
          [...params, device.storeId],
        )
        .then((r) => r.rows),
      // The till's own store, so receipt details edited in the back office reach it.
      app.db
        .query(
          `SELECT id, code, name, name_ar AS "nameAr", address, phone, trn, timezone,
                  cash_rounding_step AS "cashRoundingStep", receipt_footer AS "receiptFooter", price_list_id AS "priceListId"
             FROM stores WHERE id = $1 AND updated_at > $2`,
          [device.storeId, since ?? "-infinity"],
        )
        .then((r) => r.rows),
      // A coupon that has reached its use limit goes out as switched off.
      q(`SELECT id, name, kind, json_build_object('all', target_all, 'categoryIds', category_ids, 'productIds', product_ids) AS target,
                percent_bp AS "percentBp", buy_qty AS "buyQty", get_qty AS "getQty", bundle_qty AS "bundleQty",
                bundle_price AS "bundlePrice", amount, min_subtotal AS "minSubtotal", min_qty AS "minQty", code,
                starts_at AS "startsAt", ends_at AS "endsAt", days, start_time AS "startTime", end_time AS "endTime",
                store_ids AS "storeIds", priority, (active AND (max_uses IS NULL OR uses < max_uses)) AS active
           FROM promotions WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, active FROM price_lists WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT i.price_list_id || ':' || i.variant_id AS id, i.price_list_id AS "priceListId", i.variant_id AS "variantId",
                i.price, i.active
           FROM price_list_items i WHERE i.tenant_id = $1 AND i.updated_at > $2`),
      // The points programme, as one row keyed by the business, so a store hub caches it too.
      q(`SELECT tenant_id AS id, enabled, points_per_aed AS "pointsPerAed", point_value_fils AS "pointValueFils",
                min_redeem_points AS "minRedeemPoints"
           FROM loyalty_settings WHERE tenant_id = $1 AND updated_at > $2`),
      // How the business's scales print barcodes, one row keyed by the business.
      q(`SELECT tenant_id AS id, rules FROM scale_settings WHERE tenant_id = $1 AND updated_at > $2`),
      q(`SELECT id, name, name_ar AS "nameAr", min_choices AS "minChoices", max_choices AS "maxChoices", options, sort, active
           FROM modifier_groups WHERE tenant_id = $1 AND updated_at > $2`),
      // Restaurant tables of this till's store.
      app.db
        .query(
          `SELECT id, area, name, seats, sort, active FROM dining_tables WHERE store_id = $1 AND updated_at > $2`,
          [device.storeId, since ?? "-infinity"],
        )
        .then((r) => r.rows),
    ]);
    return {
      serverTime,
      full: !since,
      taxes,
      categories,
      products,
      variants,
      paymentMethods,
      users,
      promotions,
      priceLists,
      priceListItems,
      loyalty,
      scale,
      modifierGroups,
      tables,
      store: stores[0] ?? null,
    };
  });
}
