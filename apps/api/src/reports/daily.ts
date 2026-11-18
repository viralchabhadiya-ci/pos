import type { Db } from "../db.js";
import { loadAlerts, type Alert } from "../owner/alerts.js";

export interface DayTotals {
  total: number;
  net: number;
  tax: number;
  discounts: number;
  refunds: number;
  orderCount: number;
  refundCount: number;
  averageBasket: number;
}

export interface DailySummary {
  tenantName: string;
  currency: string;
  date: string;
  /** The same weekday one week before, for comparison. */
  compareDate: string;
  totals: DayTotals;
  previous: DayTotals;
  stores: { id: string; name: string; total: number; orderCount: number }[];
  payments: { name: string; kind: string; count: number; total: number }[];
  topProducts: { name: string; qty: number; total: number }[];
  cashiers: { name: string; orderCount: number; total: number; refundCount: number }[];
  busiestHour: { hour: number; orderCount: number; total: number } | null;
  shifts: { register: string; closedBy: string | null; expected: number; counted: number; difference: number }[];
  approvals: { approved: number; denied: number; expired: number };
  alerts: Alert[];
}

/** Orders on a store-local calendar day across all of a business's stores. $1 tenant, $2 day. */
const DAY = "o.tenant_id = $1 AND (o.created_at AT TIME ZONE s.timezone)::date = $2::date";
const BASE = "FROM orders o JOIN stores s ON s.id = o.store_id";

async function dayTotals(db: Db, tenantId: string, date: string): Promise<DayTotals> {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(o.total), 0)::int AS total, COALESCE(SUM(o.subtotal_net), 0)::int AS net,
            COALESCE(SUM(o.tax_total), 0)::int AS tax, COALESCE(SUM(o.discount_total), 0)::int AS discounts,
            COALESCE(-SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS refunds,
            COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS "orderCount",
            COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS "refundCount"
       ${BASE} WHERE ${DAY}`,
    [tenantId, date],
  );
  const t = rows[0];
  // Average of sales only: refunds are taken back out of the total first.
  return { ...t, averageBasket: t.orderCount ? Math.round((t.total + t.refunds) / t.orderCount) : 0 };
}

/** Everything in the daily summary email for one business and one day. */
export async function buildDailySummary(db: Db, tenantId: string, date: string): Promise<DailySummary> {
  const p = [tenantId, date];
  const [tenant, compare, totals, stores, payments, top, cashiers, hours, shifts, approvals, alerts] = await Promise.all([
    db.query("SELECT name, currency FROM tenants WHERE id = $1", [tenantId]),
    db.query("SELECT to_char($1::date - 7, 'YYYY-MM-DD') AS d", [date]),
    dayTotals(db, tenantId, date),
    db.query(
      `SELECT s.id, s.name, COALESCE(SUM(o.total), 0)::int AS total,
              (COUNT(o.id) FILTER (WHERE o.refund_of_order_id IS NULL))::int AS "orderCount"
         FROM stores s LEFT JOIN orders o ON o.store_id = s.id AND (o.created_at AT TIME ZONE s.timezone)::date = $2::date
        WHERE s.tenant_id = $1 GROUP BY s.id ORDER BY s.code`,
      p,
    ),
    db.query(
      `SELECT m.name, p.kind, COUNT(*)::int AS count, SUM(p.amount)::int AS total
         FROM payments p JOIN payment_methods m ON m.id = p.method_id JOIN orders o ON o.id = p.order_id
         JOIN stores s ON s.id = o.store_id
        WHERE ${DAY} GROUP BY m.name, p.kind ORDER BY total DESC`,
      p,
    ),
    db.query(
      `SELECT MAX(ol.name) AS name, SUM(ol.qty)::float AS qty, SUM(ol.gross)::int AS total
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
        WHERE ${DAY} GROUP BY ol.variant_id HAVING SUM(ol.gross) > 0 ORDER BY total DESC, name LIMIT 5`,
      p,
    ),
    db.query(
      `SELECT u.name, COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS "orderCount",
              COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS "refundCount", SUM(o.total)::int AS total
         ${BASE} JOIN users u ON u.id = o.cashier_id
        WHERE ${DAY} GROUP BY u.id ORDER BY total DESC`,
      p,
    ),
    db.query(
      `SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE s.timezone)::int AS hour,
              COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS "orderCount", SUM(o.total)::int AS total
         ${BASE} WHERE ${DAY} GROUP BY 1 ORDER BY total DESC, hour LIMIT 1`,
      p,
    ),
    db.query(
      `SELECT r.name AS register, u.name AS "closedBy", se.expected_cash AS expected, se.closing_cash_counted AS counted,
              (se.closing_cash_counted - se.expected_cash)::int AS difference
         FROM sessions se JOIN registers r ON r.id = se.register_id JOIN stores s ON s.id = r.store_id
         LEFT JOIN users u ON u.id = se.closed_by
        WHERE s.tenant_id = $1 AND se.state = 'closed' AND (se.closed_at AT TIME ZONE s.timezone)::date = $2::date
        ORDER BY se.closed_at`,
      p,
    ),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE a.status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE a.status = 'denied')::int AS denied,
              COUNT(*) FILTER (WHERE a.status = 'expired')::int AS expired
         FROM approval_requests a JOIN stores s ON s.id = a.store_id
        WHERE a.tenant_id = $1 AND (a.created_at AT TIME ZONE s.timezone)::date = $2::date`,
      p,
    ),
    loadAlerts(db, tenantId),
  ]);
  const compareDate = compare.rows[0].d;
  return {
    tenantName: tenant.rows[0]?.name ?? "",
    currency: tenant.rows[0]?.currency ?? "AED",
    date,
    compareDate,
    totals,
    previous: await dayTotals(db, tenantId, compareDate),
    stores: stores.rows,
    payments: payments.rows,
    topProducts: top.rows,
    cashiers: cashiers.rows,
    busiestHour: hours.rows[0] ?? null,
    shifts: shifts.rows,
    approvals: approvals.rows[0],
    // Approvals waiting now are not useful in a morning email; the owner app shows them live.
    alerts: alerts.filter((a) => a.kind !== "approvals_pending"),
  };
}
