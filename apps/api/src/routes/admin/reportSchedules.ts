import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import { deliver, lastPeriod, loadSchedule, reportTitle, SCHEDULE_REPORTS, type ScheduleReport } from "../../reports/scheduled.js";
import { adminAudit, forbidden } from "./common.js";

const ScheduleSchema = z.object({
  name: z.string().trim().min(1, "Give the report a name").max(80),
  report: z.enum(SCHEDULE_REPORTS as [ScheduleReport, ...ScheduleReport[]]),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  storeId: z.string().uuid().nullable().default(null),
  recipients: z
    .array(z.string().trim().toLowerCase().email("One of the email addresses is not valid"))
    .min(1, "Add at least one email address")
    .max(20, "At most 20 addresses")
    .transform((list) => [...new Set(list)]),
  sendHour: z.number().int().min(0).max(23).default(7),
  active: z.boolean().default(true),
});

const SELECT = `SELECT rs.id, rs.name, rs.report, rs.frequency, rs.store_id AS "storeId", st.name AS "storeName",
         rs.recipients, rs.send_hour AS "sendHour", rs.active, rs.created_at AS "createdAt",
         (SELECT row_to_json(x) FROM (SELECT r.status, r.sent_at AS "sentAt", r.last_error AS "lastError",
                 to_char(r.period_from, 'YYYY-MM-DD') AS "from", to_char(r.period_to, 'YYYY-MM-DD') AS "to"
            FROM report_schedule_runs r WHERE r.schedule_id = rs.id ORDER BY r.created_at DESC LIMIT 1) x) AS "lastRun"
    FROM report_schedules rs LEFT JOIN stores st ON st.id = rs.store_id`;

/** Reports emailed on a schedule (Reports → Scheduled). Owners set them up; managers can see them. */
export async function reportScheduleRoutes(app: FastifyInstance) {
  const checkStore = async (tenantId: string, storeId: string | null) => {
    if (!storeId) return;
    const { rowCount } = await app.db.query("SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2", [storeId, tenantId]);
    if (!rowCount) throw new HttpError(400, "bad_request", "That store is not in this business");
  };

  app.get("/report-schedules", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${SELECT} WHERE rs.tenant_id = $1 ORDER BY rs.name`, [ctx.tenantId]);
    return { schedules: rows.map((r) => ({ ...r, title: reportTitle(r.report) })), reports: SCHEDULE_REPORTS.map((id) => ({ id, title: reportTitle(id) })) };
  });

  app.post("/report-schedules", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can schedule reports");
    const b = ScheduleSchema.parse(req.body);
    await checkStore(ctx.tenantId, b.storeId);
    const id = randomUUID();
    await app.db.query(
      `INSERT INTO report_schedules (id, tenant_id, name, report, frequency, store_id, recipients, send_hour, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, ctx.tenantId, b.name, b.report, b.frequency, b.storeId, b.recipients, b.sendHour, b.active, ctx.userId],
    );
    await adminAudit(app.db, ctx, "report_schedule.create", "report_schedule", id, { name: b.name, report: b.report, frequency: b.frequency, recipients: b.recipients });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/report-schedules/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change scheduled reports");
    const id = z.string().uuid().parse(req.params.id);
    const b = ScheduleSchema.parse(req.body);
    await checkStore(ctx.tenantId, b.storeId);
    const { rowCount } = await app.db.query(
      `UPDATE report_schedules SET name = $3, report = $4, frequency = $5, store_id = $6, recipients = $7, send_hour = $8,
              active = $9, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId, b.name, b.report, b.frequency, b.storeId, b.recipients, b.sendHour, b.active],
    );
    if (!rowCount) throw new HttpError(404, "not_found", "Scheduled report not found");
    await adminAudit(app.db, ctx, "report_schedule.update", "report_schedule", id, { name: b.name, active: b.active, recipients: b.recipients });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/report-schedules/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can delete scheduled reports");
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await app.db.query("DELETE FROM report_schedules WHERE id = $1 AND tenant_id = $2 RETURNING name", [id, ctx.tenantId]);
    if (!rows.length) throw new HttpError(404, "not_found", "Scheduled report not found");
    await adminAudit(app.db, ctx, "report_schedule.delete", "report_schedule", id, { name: rows[0].name });
    return { ok: true };
  });

  /** Sends the last finished period now, e.g. to check how the email looks. */
  app.post<{ Params: { id: string } }>("/report-schedules/:id/send", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can send scheduled reports");
    const id = z.string().uuid().parse(req.params.id);
    const s = await loadSchedule(app.db, id, ctx.tenantId);
    if (!s) throw new HttpError(404, "not_found", "Scheduled report not found");
    const { rows } = await app.db.query(
      `SELECT to_char((now() AT TIME ZONE COALESCE((SELECT timezone FROM stores WHERE id = $2),
                (SELECT timezone FROM stores WHERE tenant_id = $1 ORDER BY code LIMIT 1), 'Asia/Dubai'))::date, 'YYYY-MM-DD') AS today`,
      [ctx.tenantId, s.storeId],
    );
    const period = lastPeriod(s.frequency, rows[0].today);
    // Sending by hand counts as that period's run, so the scheduled send does not repeat it.
    const { rows: run } = await app.db.query(
      `INSERT INTO report_schedule_runs (id, schedule_id, tenant_id, period_from, period_to, status, attempts)
       VALUES ($1, $2, $3, $4, $5, 'sending', 1)
       ON CONFLICT (schedule_id, period_to) DO UPDATE SET status = 'sending', attempts = report_schedule_runs.attempts + 1
       RETURNING id`,
      [randomUUID(), id, ctx.tenantId, period.from, period.to],
    );
    const runId = run[0].id as string;
    // No automatic retry for a send by hand: the owner sees the error and can press again.
    if (!(await deliver(app.db, app.mailer, s, period, runId, Number.MAX_SAFE_INTEGER))) {
      const { rows: e } = await app.db.query("SELECT last_error FROM report_schedule_runs WHERE id = $1", [runId]);
      throw new HttpError(502, "send_failed", `The email could not be sent: ${e[0]?.last_error ?? "unknown error"}`);
    }
    return { ok: true, period, transport: app.mailer.transport };
  });
}
