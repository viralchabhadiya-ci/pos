import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../app.js";
import { notFound } from "../../errors.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");

const ListSchema = z.object({
  from: Day.optional(),
  to: Day.optional(),
  q: z.string().trim().max(60).optional(),
  storeId: z.string().uuid().optional(),
  type: z.enum(["all", "sales", "refunds"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const DashboardSchema = z.object({ date: Day.optional(), storeId: z.string().uuid().optional() });

/** Today's date in a store's timezone, so "today" means the shop's day, not the server's. */
async function storeToday(app: FastifyInstance, ctx: AdminContext, storeId?: string): Promise<string> {
  const { rows } = await app.db.query(
    `SELECT to_char(now() AT TIME ZONE COALESCE(
              (SELECT timezone FROM stores WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY code LIMIT 1),
              'Asia/Dubai'), 'YYYY-MM-DD') AS d`,
    [ctx.tenantId, storeId ?? null],
  );
  return rows[0].d;
}

export async function salesRoutes(app: FastifyInstance) {
  app.get("/orders", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = ListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["o.tenant_id = $1"];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll("$?", `$${params.length}`));
    };
    if (f.storeId) add("o.store_id = $?", f.storeId);
    if (f.from) add("(o.created_at AT TIME ZONE s.timezone)::date >= $?::date", f.from);
    if (f.to) add("(o.created_at AT TIME ZONE s.timezone)::date <= $?::date", f.to);
    if (f.q) add("o.number ILIKE $?", `%${f.q}%`);
    if (f.type !== "all") where.push(f.type === "refunds" ? "o.refund_of_order_id IS NOT NULL" : "o.refund_of_order_id IS NULL");
    const filter = `FROM orders o JOIN stores s ON s.id = o.store_id WHERE ${where.join(" AND ")}`;

    const count = await app.db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(o.total), 0)::int AS total ${filter}`, params);
    const { rows } = await app.db.query(
      `SELECT o.id, o.number, o.created_at AS "createdAt", o.total, o.tax_total AS "taxTotal",
              o.refund_of_order_id IS NOT NULL AS "isRefund", s.name AS "storeName", r.name AS "registerName",
              u.name AS "cashierName",
              (SELECT COUNT(*)::int FROM order_lines l WHERE l.order_id = o.id) AS "lineCount",
              (SELECT array_agg(DISTINCT p.kind) FROM payments p WHERE p.order_id = o.id) AS "paymentKinds"
         ${filter.replace("FROM orders o JOIN stores s ON s.id = o.store_id", `FROM orders o JOIN stores s ON s.id = o.store_id
              JOIN registers r ON r.id = o.register_id JOIN users u ON u.id = o.cashier_id`)}
        ORDER BY o.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      params,
    );
    return { orders: rows, count: count.rows[0].n, total: count.rows[0].total };
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT o.id, o.number, o.created_at AS "createdAt", o.synced_at AS "syncedAt",
              o.amount_total AS "amountTotal", o.discount_total AS "discountTotal", o.subtotal_net AS "subtotalNet",
              o.tax_total AS "taxTotal", o.total, o.cash_rounding AS "cashRounding", o.order_discount_bp AS "orderDiscountBp",
              o.totals_mismatch AS "totalsMismatch",
              s.name AS "storeName", r.name AS "registerName", u.name AS "cashierName",
              c.name AS "customerName", c.phone AS "customerPhone",
              o.refund_of_order_id AS "refundOfId", ro.number AS "refundOfNumber",
              COALESCE((SELECT json_agg(json_build_object('id', x.id, 'number', x.number, 'total', x.total) ORDER BY x.created_at)
                 FROM orders x WHERE x.refund_of_order_id = o.id), '[]') AS refunds
         FROM orders o
         JOIN stores s ON s.id = o.store_id
         JOIN registers r ON r.id = o.register_id
         JOIN users u ON u.id = o.cashier_id
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN orders ro ON ro.id = o.refund_of_order_id
        WHERE o.id = $1 AND o.tenant_id = $2`,
      [req.params.id, ctx.tenantId],
    );
    const order = rows[0];
    if (!order) throw notFound("Bill");
    const lines = await app.db.query(
      `SELECT line_no AS "lineNo", name, qty, unit_price AS "unitPrice", discount_bp AS "discountBp",
              line_discount + order_discount AS discount, tax_rate_bp AS "taxRateBp", net, tax, gross, note
         FROM order_lines WHERE order_id = $1 ORDER BY line_no`,
      [order.id],
    );
    const payments = await app.db.query(
      `SELECT p.kind, m.name, p.amount, p.tendered, p.change, p.reference
         FROM payments p JOIN payment_methods m ON m.id = p.method_id WHERE p.order_id = $1`,
      [order.id],
    );
    return { ...order, lines: lines.rows, payments: payments.rows };
  });

  /**
   * One day at a glance for the owner. Days and hours follow each store's own timezone;
   * refunds are stored as negative orders, so sums already net them off.
   */
  app.get("/dashboard", async (req) => {
    const ctx = await app.authAdmin(req);
    const q = DashboardSchema.parse(req.query);
    const date = q.date ?? (await storeToday(app, ctx, q.storeId));
    const params = [ctx.tenantId, q.storeId ?? null, date];
    const scope = "o.tenant_id = $1 AND ($2::uuid IS NULL OR o.store_id = $2)";
    const local = "(o.created_at AT TIME ZONE s.timezone)";
    const day = `${scope} AND ${local}::date = $3::date`;
    const base = "FROM orders o JOIN stores s ON s.id = o.store_id";

    const [totals, hourly, payments, top, trend, recent] = await Promise.all([
      app.db.query(
        `SELECT COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS "orderCount",
                COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS "refundCount",
                COALESCE(SUM(o.total), 0)::int AS total,
                COALESCE(SUM(o.subtotal_net), 0)::int AS net,
                COALESCE(SUM(o.tax_total), 0)::int AS tax,
                COALESCE(SUM(o.discount_total), 0)::int AS discounts,
                COALESCE(-SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS refunds
           ${base} WHERE ${day}`,
        params,
      ),
      app.db.query(
        `SELECT EXTRACT(HOUR FROM ${local})::int AS hour, COUNT(*)::int AS orders, SUM(o.total)::int AS total
           ${base} WHERE ${day} GROUP BY 1 ORDER BY 1`,
        params,
      ),
      app.db.query(
        `SELECT CASE WHEN p.kind = 'cash' THEN 'cash' ELSE 'card' END AS kind, SUM(p.amount)::int AS amount
           FROM payments p JOIN orders o ON o.id = p.order_id JOIN stores s ON s.id = o.store_id
          WHERE ${day} GROUP BY 1 ORDER BY 1`,
        params,
      ),
      app.db.query(
        `SELECT ol.variant_id AS "variantId", MAX(ol.name) AS name, SUM(ol.qty)::float AS qty, SUM(ol.gross)::int AS total
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
          WHERE ${day} GROUP BY ol.variant_id HAVING SUM(ol.gross) > 0 ORDER BY total DESC LIMIT 5`,
        params,
      ),
      app.db.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS date, COALESCE(t.total, 0)::int AS total, COALESCE(t.orders, 0)::int AS orders
           FROM generate_series($3::date - 6, $3::date, interval '1 day') d
           LEFT JOIN (SELECT ${local}::date AS day, SUM(o.total) AS total,
                             COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL) AS orders
                        ${base} WHERE ${scope} AND ${local}::date BETWEEN $3::date - 6 AND $3::date GROUP BY 1) t
             ON t.day = d::date
          ORDER BY d`,
        params,
      ),
      app.db.query(
        `SELECT o.id, o.number, o.created_at AS "createdAt", o.total, o.refund_of_order_id IS NOT NULL AS "isRefund"
           ${base} WHERE ${day} ORDER BY o.created_at DESC LIMIT 8`,
        params,
      ),
    ]);
    const t = totals.rows[0];
    return {
      date,
      ...t,
      averageBasket: t.orderCount ? Math.round((t.total + t.refunds) / t.orderCount) : 0,
      hourly: hourly.rows,
      payments: payments.rows,
      topProducts: top.rows,
      trend: trend.rows,
      recentOrders: recent.rows,
    };
  });
}
