import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
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
  groupBy: z.enum(["product", "category", "cashier", "payment", "day", "margin", "margin_category", "staff"]).default("product"),
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

export interface Column {
  key: string;
  label: string;
  money?: boolean;
  /** A percentage in basis points (1250 = 12.50%). */
  bp?: boolean;
}

/** Cost of a line: units times the cost at sale, null when the product has no cost. */
const LINE_COST = `ROUND(ol.qty * COALESCE(ol.unit_cost, v.cost))`;
const MARGIN_COLS = `SUM(ol.net)::int AS net,
                 SUM(${LINE_COST}) FILTER (WHERE COALESCE(ol.unit_cost, v.cost) IS NOT NULL)::int AS cost,
                 (SUM(ol.net) FILTER (WHERE COALESCE(ol.unit_cost, v.cost) IS NOT NULL)
                   - SUM(${LINE_COST}) FILTER (WHERE COALESCE(ol.unit_cost, v.cost) IS NOT NULL))::int AS profit,
                 COALESCE(SUM(ol.net) FILTER (WHERE COALESCE(ol.unit_cost, v.cost) IS NULL), 0)::int AS "noCostNet"`;
const MARGIN_COLUMNS: Column[] = [
  { key: "qty", label: "Qty sold" },
  { key: "net", label: "Net sales", money: true },
  { key: "cost", label: "Cost", money: true },
  { key: "profit", label: "Gross profit", money: true },
  { key: "marginBp", label: "Margin", bp: true },
];

export type GroupBy = z.infer<typeof SalesSchema>["groupBy"];

export const SALES: Record<GroupBy, { sql: string; columns: Column[]; title: string }> = {
  margin: {
    title: "Margins by product",
    sql: `SELECT ol.variant_id AS id, MAX(ol.name) AS name, MAX(c.name) AS category, SUM(ol.qty)::float AS qty, ${MARGIN_COLS}
            FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
            JOIN variants v ON v.id = ol.variant_id JOIN products p ON p.id = v.product_id
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE ${SCOPE} AND ol.gift_card_code IS NULL GROUP BY ol.variant_id ORDER BY profit DESC NULLS LAST, name`,
    columns: [{ key: "name", label: "Product" }, { key: "category", label: "Category" }, ...MARGIN_COLUMNS],
  },
  margin_category: {
    title: "Margins by category",
    sql: `SELECT c.id, COALESCE(MAX(c.name), 'No category') AS name, SUM(ol.qty)::float AS qty, ${MARGIN_COLS}
            FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
            JOIN variants v ON v.id = ol.variant_id JOIN products p ON p.id = v.product_id
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE ${SCOPE} AND ol.gift_card_code IS NULL GROUP BY c.id ORDER BY profit DESC NULLS LAST, name`,
    columns: [{ key: "name", label: "Category" }, ...MARGIN_COLUMNS],
  },
  staff: {
    title: "Cashier performance",
    // Hours are the shifts each person opened; voids and drawer opens come from the till's audit events.
    sql: `WITH sales AS (
            SELECT o.cashier_id AS id,
                   COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS orders,
                   COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS refunds,
                   COALESCE(SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NULL), 0)::int AS gross,
                   SUM(o.total)::int AS total, SUM(o.discount_total)::int AS discount,
                   COALESCE((SELECT SUM(ol.qty) FROM order_lines ol JOIN orders o2 ON o2.id = ol.order_id JOIN stores s2 ON s2.id = o2.store_id
                     WHERE o2.cashier_id = o.cashier_id AND o2.refund_of_order_id IS NULL
                       AND o2.tenant_id = $1 AND ($2::uuid IS NULL OR o2.store_id = $2)
                       AND (o2.created_at AT TIME ZONE s2.timezone)::date BETWEEN $3::date AND $4::date), 0)::float AS items
              FROM orders o JOIN stores s ON s.id = o.store_id WHERE ${SCOPE} GROUP BY o.cashier_id),
          events AS (
            SELECT a.user_id AS id, COUNT(*) FILTER (WHERE a.action = 'till.void')::int AS voids,
                   COUNT(*) FILTER (WHERE a.action = 'till.no_sale')::int AS "noSales",
                   COUNT(*) FILTER (WHERE a.action IN ('till.price_override', 'till.discount'))::int AS overrides
              FROM audit_log a LEFT JOIN stores s ON s.id = (a.data->>'storeId')::uuid
             WHERE a.tenant_id = $1 AND a.entity = 'till_event' AND ($2::uuid IS NULL OR s.id = $2)
               AND (a.at AT TIME ZONE COALESCE(s.timezone, 'Asia/Dubai'))::date BETWEEN $3::date AND $4::date
             GROUP BY a.user_id),
          shifts AS (
            SELECT se.opened_by AS id,
                   ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(se.closed_at, now()) - se.opened_at))) / 360.0) / 10.0 AS hours
              FROM sessions se JOIN registers r ON r.id = se.register_id JOIN stores s ON s.id = r.store_id
             WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.id = $2)
               AND (se.opened_at AT TIME ZONE s.timezone)::date BETWEEN $3::date AND $4::date
             GROUP BY se.opened_by)
          SELECT u.id, u.name, COALESCE(sa.orders, 0) AS orders,
                 CASE WHEN sa.orders > 0 THEN ROUND(sa.gross::numeric / sa.orders)::int ELSE 0 END AS "avgBill",
                 CASE WHEN sa.orders > 0 THEN ROUND((sa.items / sa.orders)::numeric, 1)::float ELSE 0 END AS "itemsPerBill",
                 COALESCE(sa.discount, 0) AS discount,
                 CASE WHEN sa.gross + sa.discount > 0 THEN ROUND(sa.discount * 10000.0 / (sa.gross + sa.discount))::int ELSE 0 END AS "discountBp",
                 COALESCE(sa.refunds, 0) AS refunds, COALESCE(ev.voids, 0) AS voids, COALESCE(ev."noSales", 0) AS "noSales",
                 COALESCE(ev.overrides, 0) AS overrides, COALESCE(sh.hours, 0)::float AS hours,
                 CASE WHEN sh.hours > 0 THEN ROUND(COALESCE(sa.total, 0) / sh.hours)::int ELSE NULL END AS "perHour",
                 COALESCE(sa.total, 0) AS total
            FROM users u LEFT JOIN sales sa ON sa.id = u.id LEFT JOIN events ev ON ev.id = u.id LEFT JOIN shifts sh ON sh.id = u.id
           WHERE u.tenant_id = $1 AND (sa.id IS NOT NULL OR ev.id IS NOT NULL OR sh.id IS NOT NULL)
           ORDER BY total DESC, u.name`,
    columns: [
      { key: "name", label: "Cashier" },
      { key: "orders", label: "Bills" },
      { key: "avgBill", label: "Average bill", money: true },
      { key: "itemsPerBill", label: "Items per bill" },
      { key: "discountBp", label: "Discount rate", bp: true },
      { key: "refunds", label: "Refunds" },
      { key: "voids", label: "Voids" },
      { key: "noSales", label: "Drawer opens" },
      { key: "hours", label: "Shift hours" },
      { key: "perHour", label: "Sales per hour", money: true },
      { key: "total", label: "Net sales", money: true },
    ],
  },
  product: {
    title: "Sales by product",
    sql: `SELECT ol.variant_id AS id, MAX(ol.name) AS name, MAX(c.name) AS category, SUM(ol.qty)::float AS qty,
                 SUM(ol.line_discount + ol.promo_discount + ol.order_discount)::int AS discount, SUM(ol.net)::int AS net,
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
    title: "Sales by category",
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
    title: "Sales by cashier",
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
    title: "Sales by payment method",
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
    title: "Sales by day",
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

/** Margin in basis points from net and profit; null when there is no cost to compare. */
function withMargin(rows: Record<string, unknown>[]) {
  for (const r of rows) {
    const net = Number(r.net ?? 0) - Number(r.noCostNet ?? 0);
    r.marginBp = r.profit === null || r.profit === undefined || net === 0 ? null : Math.round((Number(r.profit) * 10_000) / net);
  }
  return rows;
}

/** Runs one sales report for a tenant; used by the screen, the CSV and scheduled emails. */
export async function runSalesReport(
  db: { query: FastifyInstance["db"]["query"] },
  tenantId: string,
  q: { groupBy: GroupBy; from: string; to: string; storeId?: string | null },
) {
  const report = SALES[q.groupBy];
  const { rows } = await db.query(report.sql, [tenantId, q.storeId ?? null, q.from, q.to]);
  if (q.groupBy === "margin" || q.groupBy === "margin_category") withMargin(rows);
  return { columns: report.columns, rows, title: report.title };
}

export function csvCell(c: Column, v: unknown) {
  if (v === null || v === undefined) return "";
  if (c.money) return money(v as number);
  if (c.bp) return ((v as number) / 100).toFixed(2);
  return v;
}

export function reportCsv(columns: Column[], rows: Record<string, unknown>[]) {
  return toCsv(
    columns.map((c) => (c.bp ? `${c.label} %` : c.label)),
    rows.map((r) => columns.map((c) => csvCell(c, r[c.key]))),
  );
}

function sendCsv(reply: FastifyReply, filename: string, columns: Column[], rows: Record<string, unknown>[]) {
  const csv = reportCsv(columns, rows);
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${filename}"`)
    .send(csv);
}

/** The VAT return figures for a period (see /reports/vat). */
export async function runVatReport(
  db: { query: FastifyInstance["db"]["query"] },
  tenantId: string,
  q: { from: string; to: string; storeId?: string | null },
) {
  const { rows } = await db.query(
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
    [tenantId, q.storeId ?? null, q.from, q.to],
  );
  const sum = (kind: string, key: "net" | "vat") =>
    rows.filter((r) => r.kind === kind).reduce((n, r) => n + (r[key] as number), 0);
  const boxes = {
    standardRated: { amount: sum("standard", "net"), vat: sum("standard", "vat") },
    zeroRated: { amount: sum("zero", "net") },
    exempt: { amount: sum("exempt", "net") },
    outOfScope: { amount: sum("none", "net") },
  };
  return { rows, boxes };
}

const VAT_LABEL: Record<string, string> = { standard: "Standard rated", zero: "Zero rated", exempt: "Exempt", none: "No VAT" };
export const VAT_COLUMNS: Column[] = [
  { key: "label", label: "Supply" },
  { key: "rate", label: "Rate %" },
  { key: "salesNet", label: "Sales net", money: true },
  { key: "salesVat", label: "Sales VAT", money: true },
  { key: "refundNet", label: "Credit notes net", money: true },
  { key: "refundVat", label: "Credit notes VAT", money: true },
  { key: "net", label: "Net amount", money: true },
  { key: "vat", label: "VAT due", money: true },
];
export const vatCsvRows = (rows: Record<string, any>[]) =>
  rows.map((r) => ({ ...r, label: VAT_LABEL[r.kind] ?? r.kind, rate: (r.rateBp / 100).toFixed(2) }));

export async function adminReportRoutes(app: FastifyInstance) {
  app.get("/reports/sales", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = SalesSchema.parse(req.query);
    range(q);
    const report = await runSalesReport(app.db, ctx.tenantId, q);
    if (q.format === "csv") return sendCsv(reply, `sales-by-${q.groupBy}-${q.from}-to-${q.to}.csv`, report.columns, report.rows);
    return { from: q.from, to: q.to, groupBy: q.groupBy, ...report };
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
    const { rows, boxes } = await runVatReport(app.db, ctx.tenantId, q);
    if (q.format === "csv") return sendCsv(reply, `vat-${q.from}-to-${q.to}.csv`, VAT_COLUMNS, vatCsvRows(rows));
    return { from: q.from, to: q.to, rows, boxes };
  });
}
