import type { Db } from "../db.js";
import { CARD_PROBLEM_SQL } from "../routes/admin/terminals.js";
import { expireApprovals } from "../routes/approvals.js";

export type Severity = "high" | "medium" | "low";

export interface AlertItem {
  label: string;
  detail?: string;
  /** Money in fils when the line is about an amount. */
  amount?: number;
  /** A back office page that deals with it, as a hash route. */
  href?: string;
}

export interface Alert {
  kind:
    | "approvals_pending"
    | "card_problems"
    | "einvoices_failed"
    | "cash_variance"
    | "till_offline"
    | "totals_mismatch"
    | "low_stock"
    | "report_failed";
  severity: Severity;
  title: string;
  count: number;
  items: AlertItem[];
  href?: string;
}

/** A drawer counted this far off what it should hold is worth the owner's eye. */
export const CASH_VARIANCE_FILS = 1000;
/** A till with an open shift that has not reached the server for this long is shown as offline. */
export const OFFLINE_MINUTES = 15;
const RECENT_DAYS = 7;
const ITEMS = 5;

const fmt = (fils: number) => (fils / 100).toFixed(2);

/**
 * Everything an owner should look at now, most urgent first. Each check is a cheap count with
 * a few example lines, so the owner app can poll it.
 */
export async function loadAlerts(db: Db, tenantId: string, storeId: string | null = null): Promise<Alert[]> {
  await expireApprovals(db, tenantId);
  const p = [tenantId, storeId];
  const [approvals, cards, einv, cash, offline, mismatch, stock, report] = await Promise.all([
    db.query(
      `SELECT a.id, a.summary, a.amount, a.created_at, r.name AS register, u.name AS requester, COUNT(*) OVER ()::int AS n
         FROM approval_requests a JOIN registers r ON r.id = a.register_id LEFT JOIN users u ON u.id = a.requested_by
        WHERE a.tenant_id = $1 AND ($2::uuid IS NULL OR a.store_id = $2) AND a.status = 'pending'
        ORDER BY a.created_at LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT c.id, c.kind, c.amount, c.status, r.name AS register, COUNT(*) OVER ()::int AS n
         FROM card_transactions c JOIN registers r ON r.id = c.register_id
        WHERE c.tenant_id = $1 AND ($2::uuid IS NULL OR r.store_id = $2) AND ${CARD_PROBLEM_SQL}
        ORDER BY c.created_at DESC LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT e.id, e.status, e.last_error, o.id AS order_id, o.number, COUNT(*) OVER ()::int AS n
         FROM einvoices e JOIN orders o ON o.id = e.order_id
        WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR o.store_id = $2) AND e.status IN ('failed', 'rejected')
        ORDER BY e.updated_at DESC LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT se.id, r.name AS register, u.name AS closed_by, se.closed_at,
              (se.closing_cash_counted - se.expected_cash)::int AS diff, COUNT(*) OVER ()::int AS n
         FROM sessions se JOIN registers r ON r.id = se.register_id JOIN stores s ON s.id = r.store_id
         LEFT JOIN users u ON u.id = se.closed_by
        WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.id = $2) AND se.state = 'closed'
          AND se.closed_at > now() - interval '${RECENT_DAYS} days'
          AND abs(se.closing_cash_counted - se.expected_cash) >= ${CASH_VARIANCE_FILS}
        ORDER BY abs(se.closing_cash_counted - se.expected_cash) DESC LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT d.id, d.name, r.name AS register, d.last_seen_at, COUNT(*) OVER ()::int AS n
         FROM devices d JOIN registers r ON r.id = d.register_id JOIN stores s ON s.id = r.store_id
        WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.id = $2) AND d.role = 'till' AND d.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM sessions se WHERE se.register_id = r.id AND se.state = 'open')
          AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '${OFFLINE_MINUTES} minutes')
        ORDER BY d.last_seen_at NULLS FIRST LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT o.id, o.number, (o.client_total - o.total)::int AS diff, COUNT(*) OVER ()::int AS n
         FROM orders o
        WHERE o.tenant_id = $1 AND ($2::uuid IS NULL OR o.store_id = $2) AND o.totals_mismatch
          AND o.created_at > now() - interval '${RECENT_DAYS} days'
        ORDER BY o.created_at DESC LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT p.id, p.name, v.reorder_level AS "reorderLevel", oh.qty AS "onHand", COUNT(*) OVER ()::int AS n
         FROM products p JOIN variants v ON v.product_id = p.id
         JOIN LATERAL (SELECT COALESCE(SUM(m.qty), 0) AS qty FROM stock_moves m
                        WHERE m.variant_id = v.id AND ($2::uuid IS NULL OR m.store_id = $2)) oh ON true
        WHERE p.tenant_id = $1 AND p.active AND v.reorder_level IS NOT NULL AND oh.qty <= v.reorder_level
        ORDER BY oh.qty - v.reorder_level, p.name LIMIT ${ITEMS}`,
      p,
    ),
    db.query(
      `SELECT status, to_char(report_date, 'YYYY-MM-DD') AS date, last_error FROM report_deliveries
        WHERE tenant_id = $1 AND kind = 'daily' ORDER BY report_date DESC LIMIT 1`,
      [tenantId],
    ),
  ]);

  const alerts: Alert[] = [];
  const n = (rows: { n?: number }[]) => rows[0]?.n ?? 0;

  if (approvals.rows.length) {
    alerts.push({
      kind: "approvals_pending",
      severity: "high",
      title: n(approvals.rows) === 1 ? "1 request waiting for approval" : `${n(approvals.rows)} requests waiting for approval`,
      count: n(approvals.rows),
      items: approvals.rows.map((r) => ({
        label: r.summary,
        detail: [r.register, r.requester].filter(Boolean).join(" · "),
        amount: r.amount ?? undefined,
      })),
    });
  }
  if (cards.rows.length) {
    alerts.push({
      kind: "card_problems",
      severity: "high",
      title: `${n(cards.rows)} card ${n(cards.rows) === 1 ? "payment needs" : "payments need"} checking`,
      count: n(cards.rows),
      href: "#/card-terminals",
      items: cards.rows.map((r) => ({
        label: r.status === "approved" ? `Card ${r.kind} charged but not on any bill` : `Card ${r.kind} never answered`,
        detail: r.register,
        amount: r.amount,
      })),
    });
  }
  if (einv.rows.length) {
    alerts.push({
      kind: "einvoices_failed",
      severity: "high",
      title: `${n(einv.rows)} e-${n(einv.rows) === 1 ? "invoice" : "invoices"} not accepted`,
      count: n(einv.rows),
      href: "#/einvoicing",
      items: einv.rows.map((r) => ({
        label: `Bill ${r.number}`,
        detail: r.last_error ?? r.status,
        href: `#/sales/${r.order_id}`,
      })),
    });
  }
  if (cash.rows.length) {
    alerts.push({
      kind: "cash_variance",
      severity: "medium",
      title: `${n(cash.rows)} ${n(cash.rows) === 1 ? "shift" : "shifts"} closed with cash over or short`,
      count: n(cash.rows),
      items: cash.rows.map((r) => ({
        label: `${r.register}: ${r.diff < 0 ? "short" : "over"} by AED ${fmt(Math.abs(r.diff))}`,
        detail: r.closed_by ? `Closed by ${r.closed_by}` : undefined,
        amount: r.diff,
      })),
    });
  }
  if (offline.rows.length) {
    alerts.push({
      kind: "till_offline",
      severity: "medium",
      title: `${n(offline.rows)} ${n(offline.rows) === 1 ? "till has" : "tills have"} not synced for ${OFFLINE_MINUTES}+ minutes`,
      count: n(offline.rows),
      href: "#/devices",
      items: offline.rows.map((r) => ({
        label: `${r.name} (${r.register})`,
        detail: r.last_seen_at ? `Last seen ${new Date(r.last_seen_at).toISOString()}` : "Never seen",
      })),
    });
  }
  if (mismatch.rows.length) {
    alerts.push({
      kind: "totals_mismatch",
      severity: "medium",
      title: `${n(mismatch.rows)} ${n(mismatch.rows) === 1 ? "bill" : "bills"} with a total that differs from the till`,
      count: n(mismatch.rows),
      href: "#/sales",
      items: mismatch.rows.map((r) => ({ label: `Bill ${r.number}`, amount: r.diff, href: `#/sales/${r.id}` })),
    });
  }
  if (stock.rows.length) {
    alerts.push({
      kind: "low_stock",
      severity: "low",
      title: `${n(stock.rows)} ${n(stock.rows) === 1 ? "product is" : "products are"} low on stock`,
      count: n(stock.rows),
      href: "#/products",
      items: stock.rows.map((r) => ({ label: r.name, detail: `${r.onHand} left, reorder at ${r.reorderLevel}` })),
    });
  }
  const last = report.rows[0];
  if (last?.status === "failed") {
    alerts.push({
      kind: "report_failed",
      severity: "low",
      title: "The daily summary email could not be sent",
      count: 1,
      items: [{ label: `Summary for ${last.date}`, detail: last.last_error ?? undefined }],
    });
  }
  return alerts;
}
