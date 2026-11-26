import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError } from "../../errors.js";
import { loadAlerts } from "../../owner/alerts.js";
import { buildDailySummary } from "../../reports/daily.js";
import {
  dailyRecipients,
  loadReportSettings,
  sendSummaryNow,
  TENANT_TZ,
} from "../../reports/deliver.js";
import { renderDailyEmail } from "../../reports/render.js";
import { expireApprovals } from "../approvals.js";
import { adminAudit, forbidden } from "./common.js";
import { storeParam } from "../../stores.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
const StoreQuery = z.object({ storeId: z.string().uuid().optional() });

const ApprovalList = z.object({
  status: z.enum(["pending", "decided", "all"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const Decision = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().trim().max(300).optional(),
});

const SettingsSchema = z.object({
  dailyEnabled: z.boolean(),
  sendHour: z.number().int().min(0).max(23),
  extraEmails: z.array(z.string().trim().toLowerCase().email("Enter a valid email address")).max(10),
});
const MeSchema = z.object({ daily: z.boolean() });
const SummaryQuery = z.object({ date: Day.optional(), format: z.enum(["json", "html"]).default("json") });
const SendSchema = z.object({ date: Day.optional(), to: z.enum(["me", "recipients"]).default("me") });

const APPROVAL_SELECT = `SELECT a.id, a.kind, a.amount, a.reason, a.summary, a.details, a.status, a.created_at AS "createdAt",
       a.expires_at AS "expiresAt", a.decided_at AS "decidedAt", a.decision_note AS "note",
       s.name AS "storeName", r.name AS "registerName", rq.name AS "requestedBy", dc.name AS "decidedBy"
  FROM approval_requests a JOIN stores s ON s.id = a.store_id JOIN registers r ON r.id = a.register_id
  LEFT JOIN users rq ON rq.id = a.requested_by LEFT JOIN users dc ON dc.id = a.decided_by`;

/** Owner app API: live sales, alerts, approvals and the daily summary email. */
export async function ownerRoutes(app: FastifyInstance) {
  /** The business's own "today" and "yesterday", in its reporting timezone. */
  async function localDays(tenantId: string) {
    const { rows } = await app.db.query(
      `SELECT to_char((now() AT TIME ZONE ${TENANT_TZ})::date, 'YYYY-MM-DD') AS today,
              to_char((now() AT TIME ZONE ${TENANT_TZ})::date - 1, 'YYYY-MM-DD') AS yesterday
         FROM tenants t WHERE t.id = $1`,
      [tenantId],
    );
    return rows[0] as { today: string; yesterday: string };
  }

  app.get("/alerts", async (req) => {
    const ctx = await app.authAdmin(req);
    const q = StoreQuery.parse(req.query);
    const alerts = await loadAlerts(app.db, ctx.tenantId, storeParam(ctx, q.storeId));
    return { alerts, count: alerts.reduce((n, a) => n + (a.severity === "low" ? 0 : a.count), 0) };
  });

  /**
   * What is happening right now: today's sales per store, which tills have a shift open and
   * how they are doing, and how many things wait for the owner. Cheap enough to poll.
   */
  app.get("/live", async (req) => {
    const ctx = await app.authAdmin(req);
    const q = StoreQuery.parse(req.query);
    await expireApprovals(app.db, ctx.tenantId);
    const p = [ctx.tenantId, storeParam(ctx, q.storeId)];
    const [stores, shifts, pending, latest] = await Promise.all([
      app.db.query(
        `SELECT s.id, s.name, s.code, COALESCE(SUM(o.total), 0)::int AS total,
                (COUNT(o.id) FILTER (WHERE o.refund_of_order_id IS NULL))::int AS "orderCount",
                MAX(o.created_at) AS "lastOrderAt"
           FROM stores s LEFT JOIN orders o ON o.store_id = s.id
                AND (o.created_at AT TIME ZONE s.timezone)::date = (now() AT TIME ZONE s.timezone)::date
          WHERE s.tenant_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[])) GROUP BY s.id ORDER BY s.code`,
        p,
      ),
      app.db.query(
        `SELECT se.id, r.name AS "registerName", s.name AS "storeName", u.name AS cashier, se.opened_at AS "openedAt",
                COALESCE(t.total, 0)::int AS total, COALESCE(t.orders, 0)::int AS "orderCount",
                (SELECT MAX(d.last_seen_at) FROM devices d WHERE d.register_id = r.id AND d.revoked_at IS NULL) AS "lastSeenAt"
           FROM sessions se JOIN registers r ON r.id = se.register_id JOIN stores s ON s.id = r.store_id
           JOIN users u ON u.id = se.opened_by
           LEFT JOIN LATERAL (SELECT SUM(o.total) AS total, COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL) AS orders
                                FROM orders o WHERE o.session_id = se.id) t ON true
          WHERE s.tenant_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[])) AND se.state = 'open'
          ORDER BY s.code, r.code`,
        p,
      ),
      app.db.query(
        `SELECT COUNT(*)::int AS n FROM approval_requests
          WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[])) AND status = 'pending'`,
        p,
      ),
      app.db.query(
        `SELECT o.id, o.number, o.total, o.created_at AS "createdAt", o.refund_of_order_id IS NOT NULL AS "isRefund",
                s.name AS "storeName", u.name AS cashier
           FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.cashier_id
          WHERE o.tenant_id = $1 AND ($2::uuid[] IS NULL OR o.store_id = ANY($2::uuid[]))
          ORDER BY o.created_at DESC LIMIT 10`,
        p,
      ),
    ]);
    const total = stores.rows.reduce((n, s) => n + s.total, 0);
    const orderCount = stores.rows.reduce((n, s) => n + s.orderCount, 0);
    return {
      at: new Date().toISOString(),
      today: { total, orderCount },
      stores: stores.rows,
      openShifts: shifts.rows,
      pendingApprovals: pending.rows[0].n,
      latestOrders: latest.rows,
    };
  });

  app.get("/approvals", async (req) => {
    const ctx = await app.authAdmin(req);
    const q = ApprovalList.parse(req.query);
    await expireApprovals(app.db, ctx.tenantId);
    const filter = q.status === "pending" ? "AND a.status = 'pending'" : q.status === "decided" ? "AND a.status <> 'pending'" : "";
    const order = q.status === "pending" ? "a.created_at" : "a.created_at DESC";
    const { rows } = await app.db.query(
      `${APPROVAL_SELECT} WHERE a.tenant_id = $1 AND ($2::uuid[] IS NULL OR a.store_id = ANY($2::uuid[])) ${filter}
        ORDER BY ${order} LIMIT ${q.limit}`,
      [ctx.tenantId, ctx.storeIds],
    );
    return { approvals: rows };
  });

  app.post<{ Params: { id: string } }>("/approvals/:id/decide", async (req) => {
    const ctx = await app.authAdmin(req);
    // Money decisions stay with the business's own people, not platform support.
    if (ctx.support) throw forbidden("Support cannot approve or deny till requests");
    const body = Decision.parse(req.body);
    const id = z.string().uuid().parse(req.params.id);
    await expireApprovals(app.db, ctx.tenantId);
    return withTx(app.db, async (tx) => {
      const status = body.decision === "approve" ? "approved" : "denied";
      const { rows } = await tx.query(
        `UPDATE approval_requests SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
          WHERE id = $1 AND tenant_id = $2 AND status = 'pending' AND expires_at > now()
            AND ($6::uuid[] IS NULL OR store_id = ANY($6::uuid[])) RETURNING id`,
        [id, ctx.tenantId, status, ctx.userId, body.note ?? null, ctx.storeIds],
      );
      if (!rows[0]) {
        const current = await tx.query(
          "SELECT status FROM approval_requests WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[]))",
          [id, ctx.tenantId, ctx.storeIds],
        );
        if (!current.rows[0]) throw new HttpError(404, "not_found", "Approval request not found");
        const was = current.rows[0].status as string;
        const why: Record<string, string> = {
          approved: "This request was already approved.",
          denied: "This request was already denied.",
          cancelled: "The till cancelled this request.",
          expired: "This request ran out of time. The cashier can ask again.",
        };
        throw new HttpError(409, "already_decided", why[was] ?? "This request is no longer waiting.");
      }
      await adminAudit(tx, ctx, `approval.${status}`, "approval", id, { note: body.note ?? null });
      const out = await tx.query(`${APPROVAL_SELECT} WHERE a.id = $1`, [id]);
      return out.rows[0];
    });
  });

  app.get("/report-settings", async (req) => {
    const ctx = await app.authAdmin(req);
    const [settings, recipients, me, deliveries] = await Promise.all([
      loadReportSettings(app.db, ctx.tenantId),
      dailyRecipients(app.db, ctx.tenantId),
      app.db.query(
        `SELECT u.email, COALESCE(r.daily, u.role = 'owner') AS daily FROM users u
           LEFT JOIN report_subscriptions r ON r.user_id = u.id WHERE u.id = $1`,
        [ctx.userId],
      ),
      app.db.query(
        `SELECT id, kind, to_char(report_date, 'YYYY-MM-DD') AS date, status, recipients, attempts, transport,
                last_error AS error, created_at AS "createdAt", sent_at AS "sentAt"
           FROM report_deliveries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [ctx.tenantId],
      ),
    ]);
    return {
      settings,
      recipients,
      me: { email: me.rows[0]?.email ?? null, daily: me.rows[0]?.daily ?? false },
      canEdit: ctx.role === "owner",
      // "log" means no mail server is set up on this server, so nothing really leaves it.
      transport: app.mailer.transport,
      deliveries: deliveries.rows,
    };
  });

  app.put("/report-settings", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change who gets the daily summary");
    const body = SettingsSchema.parse(req.body);
    const extra = [...new Set(body.extraEmails)];
    await app.db.query(
      `INSERT INTO report_settings (tenant_id, daily_enabled, send_hour, extra_emails) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET daily_enabled = $2, send_hour = $3, extra_emails = $4, updated_at = now()`,
      [ctx.tenantId, body.dailyEnabled, body.sendHour, extra],
    );
    await adminAudit(app.db, ctx, "report_settings.update", "tenant", ctx.tenantId, { ...body, extraEmails: extra });
    return { settings: await loadReportSettings(app.db, ctx.tenantId), recipients: await dailyRecipients(app.db, ctx.tenantId) };
  });

  app.put("/report-settings/me", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.support) throw forbidden("Support cannot change who gets the daily email");
    const body = MeSchema.parse(req.body);
    await app.db.query(
      `INSERT INTO report_subscriptions (user_id, tenant_id, daily) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET daily = $3, updated_at = now()`,
      [ctx.userId, ctx.tenantId, body.daily],
    );
    return { daily: body.daily, recipients: await dailyRecipients(app.db, ctx.tenantId) };
  });

  /** The daily summary for any day (yesterday by default), as data or as the email itself. */
  app.get("/reports/daily-summary", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = SummaryQuery.parse(req.query);
    const date = q.date ?? (await localDays(ctx.tenantId)).yesterday;
    const summary = await buildDailySummary(app.db, ctx.tenantId, date);
    if (q.format === "html") {
      const email = renderDailyEmail(summary, { appUrl: process.env.OWNER_APP_URL });
      return reply
        .header("content-type", "text/html; charset=utf-8")
        // The preview is shown in a sandboxed frame; it must never run scripts.
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
        .send(email.html);
    }
    return summary;
  });

  app.post("/reports/daily-summary/send", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = SendSchema.parse(req.body ?? {});
    const date = body.date ?? (await localDays(ctx.tenantId)).yesterday;
    let to: string[];
    if (body.to === "me") {
      const { rows } = await app.db.query("SELECT lower(email) AS email FROM users WHERE id = $1", [ctx.userId]);
      if (!rows[0]?.email) throw new HttpError(400, "no_email", "Your account has no email address");
      to = [rows[0].email];
    } else {
      if (ctx.role !== "owner") throw forbidden("Only the owner can send the summary to everyone");
      to = await dailyRecipients(app.db, ctx.tenantId);
      if (!to.length) throw new HttpError(400, "no_recipients", "Nobody is set to get the daily summary");
    }
    const result = await sendSummaryNow(
      app.db,
      app.mailer,
      { tenantId: ctx.tenantId, date, to, requestedBy: ctx.userId },
      { appUrl: process.env.OWNER_APP_URL },
    );
    if (result.status === "failed") throw new HttpError(502, "send_failed", `The email could not be sent: ${result.error}`);
    return { ...result, date, to };
  });
}
