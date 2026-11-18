import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { buildDailySummary } from "./daily.js";
import type { Mailer } from "./mailer.js";
import { renderDailyEmail } from "./render.js";

export interface ReportSettings {
  dailyEnabled: boolean;
  sendHour: number;
  extraEmails: string[];
}

export const DEFAULT_REPORT_SETTINGS: ReportSettings = { dailyEnabled: true, sendHour: 8, extraEmails: [] };

/** Tries before a daily summary is given up; waits 5, 10, 20, 40 minutes between them. */
export const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 300;
export const retryDelaySeconds = (attempts: number) => 300 * 2 ** Math.max(0, attempts - 1);

/**
 * The business's reporting timezone: its first store's. Daily summaries are sent at the
 * chosen hour there, and cover the day before.
 */
export const TENANT_TZ = `COALESCE((SELECT s.timezone FROM stores s WHERE s.tenant_id = t.id ORDER BY s.code LIMIT 1), 'Asia/Dubai')`;

export async function loadReportSettings(db: Db, tenantId: string): Promise<ReportSettings> {
  const { rows } = await db.query(
    `SELECT daily_enabled AS "dailyEnabled", send_hour AS "sendHour", extra_emails AS "extraEmails"
       FROM report_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? DEFAULT_REPORT_SETTINGS;
}

/**
 * Who gets the daily summary: owners and managers with an email who have it on (owners by
 * default, managers when they turn it on), plus the extra addresses. Lowercased, no repeats.
 */
export async function dailyRecipients(db: Db, tenantId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT lower(u.email) AS email FROM users u LEFT JOIN report_subscriptions r ON r.user_id = u.id
      WHERE u.tenant_id = $1 AND u.active AND u.role IN ('owner', 'manager') AND u.email IS NOT NULL
        AND COALESCE(r.daily, u.role = 'owner')
     UNION
     SELECT lower(e) FROM report_settings s, unnest(s.extra_emails) e WHERE s.tenant_id = $1
     ORDER BY 1`,
    [tenantId],
  );
  return rows.map((r) => r.email as string);
}

export interface SendOptions {
  appUrl?: string;
}

async function sendSummary(db: Db, mailer: Mailer, tenantId: string, date: string, to: string[], opts: SendOptions) {
  const summary = await buildDailySummary(db, tenantId, date);
  const email = renderDailyEmail(summary, { appUrl: opts.appUrl });
  await mailer.send({ to, ...email });
}

/**
 * Queues yesterday's summary for every business whose send hour has come, then sends what is
 * due. Safe to run on many servers at once: each business and day is queued once, and a row
 * is held by one worker at a time.
 */
export async function runDueReports(db: Db, mailer: Mailer, opts: SendOptions = {}): Promise<number> {
  await db.query(
    `INSERT INTO report_deliveries (id, tenant_id, kind, report_date)
     SELECT gen_random_uuid(), t.id, 'daily', local.today - 1
       FROM tenants t
       LEFT JOIN report_settings rs ON rs.tenant_id = t.id
       CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE ${TENANT_TZ}) AS now) n
       CROSS JOIN LATERAL (SELECT n.now::date AS today) local
      WHERE COALESCE(rs.daily_enabled, true)
        -- A paused or closed business gets no emails.
        AND t.status NOT IN ('suspended', 'cancelled')
        AND EXTRACT(HOUR FROM n.now) >= COALESCE(rs.send_hour, 8)
        -- A business that signed up today has no yesterday to report on.
        AND (t.created_at AT TIME ZONE ${TENANT_TZ})::date < local.today
     ON CONFLICT (tenant_id, report_date) WHERE kind = 'daily' DO NOTHING`,
  );
  const { rows } = await db.query(
    `UPDATE report_deliveries d SET status = 'sending', attempts = d.attempts + 1,
            locked_until = now() + make_interval(secs => ${LOCK_SECONDS})
      WHERE d.id IN (SELECT id FROM report_deliveries
                      WHERE kind = 'daily' AND ((status = 'pending' AND next_attempt_at <= now())
                         OR (status = 'sending' AND locked_until < now()))
                      ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.tenant_id AS "tenantId", to_char(d.report_date, 'YYYY-MM-DD') AS date, d.attempts`,
  );
  let sent = 0;
  for (const row of rows) {
    const to = await dailyRecipients(db, row.tenantId);
    if (!to.length) {
      await db.query(
        `UPDATE report_deliveries SET status = 'skipped', locked_until = NULL, last_error = 'Nobody is set to get the daily summary'
          WHERE id = $1`,
        [row.id],
      );
      continue;
    }
    try {
      await sendSummary(db, mailer, row.tenantId, row.date, to, opts);
      await db.query(
        `UPDATE report_deliveries SET status = 'sent', sent_at = now(), recipients = $2, transport = $3,
                locked_until = NULL, last_error = NULL WHERE id = $1`,
        [row.id, to, mailer.transport],
      );
      sent += 1;
    } catch (err) {
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE report_deliveries SET status = $2, recipients = $3, transport = $4, locked_until = NULL,
                last_error = $5, next_attempt_at = now() + make_interval(secs => $6) WHERE id = $1`,
        [
          row.id,
          giveUp ? "failed" : "pending",
          to,
          mailer.transport,
          String((err as Error).message ?? err).slice(0, 500),
          retryDelaySeconds(row.attempts),
        ],
      );
    }
  }
  return sent;
}

/** Sends one day's summary right away, e.g. from "Email me this" in the owner app. */
export async function sendSummaryNow(
  db: Db,
  mailer: Mailer,
  args: { tenantId: string; date: string; to: string[]; requestedBy: string },
  opts: SendOptions = {},
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO report_deliveries (id, tenant_id, kind, report_date, status, recipients, attempts, transport, requested_by)
     VALUES ($1, $2, 'manual', $3, 'sending', $4, 1, $5, $6)`,
    [id, args.tenantId, args.date, args.to, mailer.transport, args.requestedBy],
  );
  try {
    await sendSummary(db, mailer, args.tenantId, args.date, args.to, opts);
    await db.query("UPDATE report_deliveries SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
    return { id, status: "sent" as const, transport: mailer.transport };
  } catch (err) {
    const message = String((err as Error).message ?? err).slice(0, 500);
    await db.query("UPDATE report_deliveries SET status = 'failed', last_error = $2 WHERE id = $1", [id, message]);
    return { id, status: "failed" as const, transport: mailer.transport, error: message };
  }
}

/** Runs the daily summaries every minute in the background. Returns a stop function. */
export function startReportWorker(
  db: Db,
  mailer: Mailer,
  log: { error: (obj: unknown, msg?: string) => void },
  opts: SendOptions & { intervalMs?: number } = {},
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueReports(db, mailer, opts);
    } catch (err) {
      log.error(err, "daily summary worker failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
