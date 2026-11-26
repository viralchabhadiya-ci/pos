import type { Db } from "../db.js";
import { csvCell, reportCsv, runSalesReport, runVatReport, SALES, VAT_COLUMNS, vatCsvRows, type Column, type GroupBy } from "../routes/admin/reports.js";
import type { Mailer } from "./mailer.js";
import { C, esc, money, table } from "./render.js";

export type ScheduleReport = GroupBy | "vat";
export type Frequency = "daily" | "weekly" | "monthly";

export const SCHEDULE_REPORTS: ScheduleReport[] = ["product", "category", "cashier", "payment", "day", "margin", "margin_category", "staff", "vat"];

export const reportTitle = (r: ScheduleReport) => (r === "vat" ? "VAT return" : SALES[r].title);

const MAX_ATTEMPTS = 5;
const retryDelaySeconds = (attempts: number) => 300 * 2 ** Math.min(8, Math.max(0, attempts - 1));
const LOCK_SECONDS = 300;
/** Rows shown in the email body; the attached CSV has them all. */
const EMAIL_ROWS = 25;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The period a schedule reports on when it runs on `today` (a local date), or null when it
 * does not run that day: daily covers yesterday, weekly runs on Mondays for the week before
 * (Monday to Sunday), monthly runs on the 1st for the month before.
 */
export function periodFor(frequency: Frequency, today: string): { from: string; to: string } | null {
  const d = new Date(`${today}T00:00:00Z`);
  const yesterday = iso(new Date(d.getTime() - 86_400_000));
  if (frequency === "daily") return { from: yesterday, to: yesterday };
  if (frequency === "weekly") {
    if (d.getUTCDay() !== 1) return null;
    return { from: iso(new Date(d.getTime() - 7 * 86_400_000)), to: yesterday };
  }
  if (d.getUTCDate() !== 1) return null;
  return { from: `${yesterday.slice(0, 7)}-01`, to: yesterday };
}

/** The most recent finished period, for "send now". */
export function lastPeriod(frequency: Frequency, today: string): { from: string; to: string } {
  for (let back = 0; back < 32; back++) {
    const day = iso(new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000));
    const p = periodFor(frequency, day);
    if (p) return p;
  }
  throw new Error("unreachable");
}

interface ScheduleRow {
  id: string;
  tenantId: string;
  name: string;
  report: ScheduleReport;
  storeId: string | null;
  storeName: string | null;
  businessName: string;
}

export interface BuiltReport {
  subject: string;
  html: string;
  text: string;
  csv: string;
  filename: string;
  rowCount: number;
}

function fmt(c: Column, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (c.money) return money(Number(v));
  if (c.bp) return `${(Number(v) / 100).toFixed(1)}%`;
  return esc(v);
}

/** Runs the report for the period and lays it out as an email with the CSV attached. */
export async function buildScheduledReport(db: Db, s: ScheduleRow, period: { from: string; to: string }): Promise<BuiltReport> {
  const title = reportTitle(s.report);
  const when = period.from === period.to ? period.from : `${period.from} to ${period.to}`;
  const where = s.storeName ?? "All stores";
  let columns: Column[];
  let rows: Record<string, unknown>[];
  let extra = "";
  if (s.report === "vat") {
    const vat = await runVatReport(db, s.tenantId, { ...period, storeId: s.storeId });
    columns = VAT_COLUMNS;
    rows = vatCsvRows(vat.rows);
    extra = `<p style="margin:0 0 12px;color:${C.fg}">Standard rated supplies <strong>AED ${money(vat.boxes.standardRated.amount)}</strong>, VAT <strong>AED ${money(
      vat.boxes.standardRated.vat,
    )}</strong>. Zero rated AED ${money(vat.boxes.zeroRated.amount)}, exempt AED ${money(vat.boxes.exempt.amount)}.</p>`;
  } else {
    const r = await runSalesReport(db, s.tenantId, { groupBy: s.report, ...period, storeId: s.storeId });
    columns = r.columns;
    rows = r.rows;
  }
  const csv = reportCsv(columns, rows);
  const shown = rows.slice(0, EMAIL_ROWS);
  const body = rows.length
    ? table(
        columns.map((c) => c.label + (c.money ? " (AED)" : "")),
        shown.map((r) => columns.map((c) => fmt(c, r[c.key]))),
        columns.map((c) => Boolean(c.money || c.bp || ["qty", "orders", "count", "refunds", "voids", "noSales", "hours", "itemsPerBill"].includes(c.key))),
      )
    : `<p style="color:${C.muted}">Nothing was sold in this period.</p>`;
  const more = rows.length > EMAIL_ROWS ? `<p style="color:${C.muted};font-size:13px">Showing ${EMAIL_ROWS} of ${rows.length} rows. The attached CSV has them all.</p>` : "";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f4">
<div style="max-width:760px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.fg}">
<p style="margin:0;color:${C.muted};font-size:14px">${esc(s.businessName)} · ${esc(where)}</p>
<h1 style="font-size:22px;margin:4px 0 4px">${esc(s.name)}</h1>
<p style="margin:0 0 16px;color:${C.muted}">${esc(title)}, ${esc(when)}</p>
${extra}<div style="overflow-x:auto">${body}</div>${more}
<p style="margin:24px 0 0;font-size:12px;color:${C.muted}">Amounts in AED. Refunds are taken off sales. You get this email because the owner added you to the scheduled report "${esc(s.name)}" in the back office.</p>
</div></body></html>`;
  const text = [
    `${s.name}: ${title}, ${when} (${where})`,
    "",
    ...shown.map((r) => columns.map((c) => `${c.label}: ${csvCell(c, r[c.key])}`).join(" · ")),
    rows.length > EMAIL_ROWS ? `\n${rows.length - EMAIL_ROWS} more rows in the attached CSV.` : "",
  ].join("\n");
  const slug = s.report === "vat" ? "vat" : `sales-by-${s.report.replace("_", "-")}`;
  return {
    subject: `${s.name} · ${when}`,
    html,
    text,
    csv,
    filename: `${slug}-${period.from}-to-${period.to}.csv`,
    rowCount: rows.length,
  };
}

const SCHEDULE_TZ = `COALESCE(st.timezone, (SELECT s2.timezone FROM stores s2 WHERE s2.tenant_id = rs.tenant_id ORDER BY s2.code LIMIT 1), 'Asia/Dubai')`;

/** Queues today's runs for every schedule whose hour has come, then sends what is due. */
export async function runDueSchedules(db: Db, mailer: Mailer): Promise<number> {
  const { rows: candidates } = await db.query(
    `SELECT rs.id, rs.frequency, to_char((now() AT TIME ZONE ${SCHEDULE_TZ})::date, 'YYYY-MM-DD') AS today
       FROM report_schedules rs JOIN tenants t ON t.id = rs.tenant_id LEFT JOIN stores st ON st.id = rs.store_id
      WHERE rs.active AND t.status NOT IN ('suspended', 'cancelled')
        AND EXTRACT(HOUR FROM now() AT TIME ZONE ${SCHEDULE_TZ}) >= rs.send_hour`,
  );
  for (const c of candidates) {
    const p = periodFor(c.frequency, c.today);
    if (!p) continue;
    await db.query(
      `INSERT INTO report_schedule_runs (id, schedule_id, tenant_id, period_from, period_to)
       SELECT gen_random_uuid(), id, tenant_id, $2, $3 FROM report_schedules WHERE id = $1
       ON CONFLICT (schedule_id, period_to) DO NOTHING`,
      [c.id, p.from, p.to],
    );
  }
  const { rows } = await db.query(
    `UPDATE report_schedule_runs r SET status = 'sending', attempts = r.attempts + 1,
            locked_until = now() + make_interval(secs => ${LOCK_SECONDS})
      WHERE r.id IN (SELECT id FROM report_schedule_runs
                      WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
                      ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.schedule_id AS "scheduleId", r.attempts,
                to_char(r.period_from, 'YYYY-MM-DD') AS "from", to_char(r.period_to, 'YYYY-MM-DD') AS "to"`,
  );
  let sent = 0;
  for (const run of rows) {
    const schedule = await loadSchedule(db, run.scheduleId);
    if (!schedule) continue;
    const ok = await deliver(db, mailer, schedule, { from: run.from, to: run.to }, run.id, run.attempts);
    if (ok) sent += 1;
  }
  return sent;
}

export async function loadSchedule(db: Db, id: string, tenantId?: string) {
  const { rows } = await db.query(
    `SELECT rs.id, rs.tenant_id AS "tenantId", rs.name, rs.report, rs.store_id AS "storeId", st.name AS "storeName",
            rs.recipients, rs.frequency, t.name AS "businessName"
       FROM report_schedules rs JOIN tenants t ON t.id = rs.tenant_id LEFT JOIN stores st ON st.id = rs.store_id
      WHERE rs.id = $1 AND ($2::uuid IS NULL OR rs.tenant_id = $2)`,
    [id, tenantId ?? null],
  );
  return (rows[0] as (ScheduleRow & { recipients: string[]; frequency: Frequency }) | undefined) ?? null;
}

/** Builds and sends one run; records the outcome. Returns true when the mail server took it. */
export async function deliver(
  db: Db,
  mailer: Mailer,
  s: ScheduleRow & { recipients: string[] },
  period: { from: string; to: string },
  runId: string,
  attempts: number,
): Promise<boolean> {
  try {
    const built = await buildScheduledReport(db, s, period);
    await mailer.send({
      to: s.recipients,
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachments: [{ filename: built.filename, content: `﻿${built.csv}`, contentType: "text/csv; charset=utf-8" }],
    });
    await db.query(
      `UPDATE report_schedule_runs SET status = 'sent', sent_at = now(), recipients = $2, transport = $3, row_count = $4,
              locked_until = NULL, last_error = NULL WHERE id = $1`,
      [runId, s.recipients, mailer.transport, built.rowCount],
    );
    return true;
  } catch (err) {
    await db.query(
      `UPDATE report_schedule_runs SET status = $2, recipients = $3, transport = $4, locked_until = NULL, last_error = $5,
              next_attempt_at = now() + make_interval(secs => $6) WHERE id = $1`,
      [runId, attempts >= MAX_ATTEMPTS ? "failed" : "pending", s.recipients, mailer.transport, String((err as Error).message ?? err).slice(0, 500), retryDelaySeconds(attempts)],
    );
    return false;
  }
}
