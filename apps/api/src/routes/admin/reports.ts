import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../app.js";
import { money, toCsv } from "../../csv.js";
import { HttpError } from "../../errors.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");

const RangeSchema = z.object({
  from: Day,
  to: Day,
  storeId: z.string().uuid().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

const SalesSchema = RangeSchema.extend({
  groupBy: z.enum(["product", "category", "cashier", "payment", "day"]).default("product"),
});

/** Longest range one report covers, so a typo like 2025 instead of 2026 does not scan years. */
const MAX_DAYS = 400;

function range(q: z.infer<typeof RangeSchema>) {
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
  if (days < 0) throw new HttpError(400, "bad_request", "The start date is after the end date");
  if (days > MAX_DAYS) throw new HttpError(400, "bad_request", `Pick at most ${MAX_DAYS} days`);
}

/** Orders in the range, by each store's own calendar day. $1 tenant, $2 store or null, $3 from, $4 to. */
const SCOPE = `o.tenant_id = $1 AND ($2::uuid IS NULL OR o.store_id = $2)
  AND (o.created_at AT TIME ZONE s.timezone)::date BETWEEN $3::date AND $4::date`;

interface Column {
  key: string;
  label: string;
  money?: boolean;
}

const SALES: Record<z.infer<typeof SalesSchema>["groupBy"], { sql: string; columns: Column[] }> = {
  product: {
    sql: `SELECT ol.variant_id AS id, MAX(ol.name) AS name, MAX(c.name) AS category, SUM(ol.qty)::float AS qty,
                 SUM(ol.line_discount + ol.order_discount)::int AS discount, SUM(ol.net)::int AS net,
                 SUM(ol.tax)::int AS tax, SUM(ol.gross)::int AS total
            FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
            JOIN variants v ON v.id = ol.variant_id JOIN products p ON p.id = v.product_id
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE ${SCOPE} GROUP BY ol.variant_id ORDER BY total DESC, name`,
    columns: [
      { key: "name", label: "Product" },
      { key: "category", label: "Category" },
      { key: "qty", label: "Qty sold" },
      { key: "discount", label: "Discounts", money: true },
      { key: "net", label: "Net", money: true },
      { key: "tax", label: "VAT", money: true },
      { key: "total", label: "Total", money: true },
    ],
  },
  category: {
    sql: `SELECT c.id, COALESCE(MAX(c.name), 'No category') AS name, SUM(ol.qty)::float AS qty,
                 COUNT(DISTINCT o.id)::int AS orders, SUM(ol.net)::int AS net, SUM(ol.tax)::int AS tax,
                 SUM(ol.gross)::int AS total
            FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
            JOIN variants v ON v.id = ol.variant_id JOIN products p ON p.id = v.product_id
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE ${SCOPE} GROUP BY c.id ORDER BY total DESC`,
    columns: [
      { key: "name", label: "Category" },
      { key: "qty", label: "Qty sold" },
      { key: "orders", label: "Bills" },
      { key: "net", label: "Net", money: true },
      { key: "tax", label: "VAT", money: true },
      { key: "total", label: "Total", money: true },
    ],
  },
  cashier: {
    sql: `SELECT u.id, u.name, COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS orders,
                 COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS refunds,
                 COALESCE(-SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS "refundTotal",
                 SUM(o.discount_total)::int AS discount, SUM(o.total)::int AS total
            FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.cashier_id
           WHERE ${SCOPE} GROUP BY u.id ORDER BY total DESC`,
    columns: [
      { key: "name", label: "Cashier" },
      { key: "orders", label: "Bills" },
      { key: "refunds", label: "Refunds" },
      { key: "refundTotal", label: "Refunded", money: true },
      { key: "discount", label: "Discounts", money: true },
      { key: "total", label: "Net sales", money: true },
    ],
  },
  payment: {
    sql: `SELECT m.id, m.name, p.kind, COUNT(*)::int AS count, SUM(p.amount)::int AS total
            FROM payments p JOIN payment_methods m ON m.id = p.method_id
            JOIN orders o ON o.id = p.order_id JOIN stores s ON s.id = o.store_id
           WHERE ${SCOPE} GROUP BY m.id, p.kind ORDER BY total DESC`,
    columns: [
      { key: "name", label: "Payment method" },
      { key: "count", label: "Payments" },
      { key: "total", label: "Amount", money: true },
    ],
  },
  day: {
    sql: `SELECT to_char((o.created_at AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD') AS id,
                 to_char((o.created_at AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD') AS name,
                 COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS orders,
                 SUM(o.subtotal_net)::int AS net, SUM(o.tax_total)::int AS tax, SUM(o.total)::int AS total
            FROM orders o JOIN stores s ON s.id = o.store_id
           WHERE ${SCOPE} GROUP BY 1 ORDER BY 1`,
    columns: [
      { key: "name", label: "Day" },
      { key: "orders", label: "Bills" },
      { key: "net", label: "Net", money: true },
      { key: "tax", label: "VAT", money: true },
      { key: "total", label: "Total", money: true },
    ],
  },
};

function sendCsv(reply: FastifyReply, filename: string, columns: Column[], rows: Record<string, unknown>[]) {
  const csv = toCsv(
    columns.map((c) => c.label),
    rows.map((r) => columns.map((c) => (c.money ? money(r[c.key] as number) : r[c.key]))),
  );
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${filename}"`)
    .send(csv);
}

const params = (ctx: AdminContext, q: z.infer<typeof RangeSchema>) => [ctx.tenantId, q.storeId ?? null, q.from, q.to];

export async function adminReportRoutes(app: FastifyInstance) {
  app.get("/reports/sales", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = SalesSchema.parse(req.query);
    range(q);
    const report = SALES[q.groupBy];
    const { rows } = await app.db.query(report.sql, params(ctx, q));
    if (q.format === "csv") return sendCsv(reply, `sales-by-${q.groupBy}-${q.from}-to-${q.to}.csv`, report.columns, rows);
    return { from: q.from, to: q.to, groupBy: q.groupBy, columns: report.columns, rows };
  });

  /**
   * VAT for the return, split the way the FTA VAT 201 form asks: standard-rated supplies
   * (box 1), zero-rated (box 4) and exempt (box 5). Refunds are credit notes and reduce
   * the period they are issued in.
   */
  app.get("/reports/vat", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = RangeSchema.parse(req.query);
    range(q);
    const { rows } = await app.db.query(
      `SELECT COALESCE(t.kind, CASE WHEN ol.tax_rate_bp > 0 THEN 'standard' ELSE 'none' END) AS kind,
              COALESCE(ol.tax_rate_bp, 0) AS "rateBp",
              COALESCE(SUM(ol.net) FILTER (WHERE o.refund_of_order_id IS NULL), 0)::int AS "salesNet",
              COALESCE(SUM(ol.tax) FILTER (WHERE o.refund_of_order_id IS NULL), 0)::int AS "salesVat",
              COALESCE(-SUM(ol.net) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS "refundNet",
              COALESCE(-SUM(ol.tax) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS "refundVat",
              SUM(ol.net)::int AS net, SUM(ol.tax)::int AS vat
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
         LEFT JOIN taxes t ON t.id = ol.tax_id
        WHERE ${SCOPE} GROUP BY 1, 2 ORDER BY 2 DESC, 1`,
      params(ctx, q),
    );
    const sum = (kind: string, key: "net" | "vat") =>
      rows.filter((r) => r.kind === kind).reduce((n, r) => n + (r[key] as number), 0);
    const boxes = {
      standardRated: { amount: sum("standard", "net"), vat: sum("standard", "vat") },
      zeroRated: { amount: sum("zero", "net") },
      exempt: { amount: sum("exempt", "net") },
      outOfScope: { amount: sum("none", "net") },
    };
    if (q.format === "csv") {
      const label = { standard: "Standard rated", zero: "Zero rated", exempt: "Exempt", none: "No VAT" } as Record<string, string>;
      return sendCsv(
        reply,
        `vat-${q.from}-to-${q.to}.csv`,
        [
          { key: "label", label: "Supply" },
          { key: "rate", label: "Rate %" },
          { key: "salesNet", label: "Sales net", money: true },
          { key: "salesVat", label: "Sales VAT", money: true },
          { key: "refundNet", label: "Credit notes net", money: true },
          { key: "refundVat", label: "Credit notes VAT", money: true },
          { key: "net", label: "Net amount", money: true },
          { key: "vat", label: "VAT due", money: true },
        ],
        rows.map((r) => ({ ...r, label: label[r.kind] ?? r.kind, rate: (r.rateBp / 100).toFixed(2) })),
      );
    }
    return { from: q.from, to: q.to, rows, boxes };
  });
}
