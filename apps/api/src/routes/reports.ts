import type { FastifyInstance } from "fastify";
import { z } from "zod";

const QuerySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export async function reportRoutes(app: FastifyInstance) {
  /** Daily sales for the device's store, using the store's own timezone for the day. */
  app.get("/reports/daily", async (req) => {
    const device = await app.authenticate(req);
    const { date } = QuerySchema.parse(req.query);
    const params = [device.storeId, date];
    const dayFilter = `o.store_id = $1 AND (o.created_at AT TIME ZONE s.timezone)::date = $2::date`;

    const totals = await app.db.query(
      `SELECT COUNT(*)::int AS order_count, COALESCE(SUM(o.total), 0)::int AS total,
              COALESCE(SUM(o.subtotal_net), 0)::int AS net, COALESCE(SUM(o.tax_total), 0)::int AS tax,
              COALESCE(SUM(o.discount_total), 0)::int AS discounts
         FROM orders o JOIN stores s ON s.id = o.store_id WHERE ${dayFilter}`,
      params,
    );
    const payments = await app.db.query(
      `SELECT p.kind, SUM(p.amount)::int AS amount
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN stores s ON s.id = o.store_id
        WHERE ${dayFilter} GROUP BY p.kind ORDER BY p.kind`,
      params,
    );
    const vat = await app.db.query(
      `SELECT ol.tax_rate_bp AS "rateBp", SUM(ol.net)::int AS net, SUM(ol.tax)::int AS tax
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
        WHERE ${dayFilter} GROUP BY ol.tax_rate_bp ORDER BY ol.tax_rate_bp NULLS FIRST`,
      params,
    );
    const top = await app.db.query(
      `SELECT ol.variant_id AS "variantId", MAX(ol.name) AS name, SUM(ol.qty) AS qty, SUM(ol.gross)::int AS total
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
        WHERE ${dayFilter} GROUP BY ol.variant_id ORDER BY total DESC LIMIT 10`,
      params,
    );
    return { date, ...totals.rows[0], payments: payments.rows, vat: vat.rows, topProducts: top.rows };
  });
}
