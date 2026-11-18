import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db, Tx } from "../db.js";
import { withTx } from "../db.js";
import { HttpError, notFound } from "../errors.js";
import { hashPassword, hashToken, newDeviceToken, verifyPassword } from "../security.js";
import { openAdminSession } from "./admin/auth.js";
import { isUniqueViolation } from "./admin/common.js";

/**
 * The platform console API, mounted under /platform: the operator's own staff look after the
 * businesses on the platform (plans, trials, pausing an account, signing in to help), and see
 * whether the system is healthy. Platform staff are separate from every business's users.
 */

export interface PlatformContext {
  userId: string;
  role: "admin" | "support";
  name: string;
}

const SESSION_HOURS = 12;
const SUPPORT_MINUTES = 60;
const MAX_FAILURES = 5;
const STATUSES = ["trial", "active", "past_due", "suspended", "cancelled"] as const;

const LoginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });
const ListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  plan: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const TenantUpdateSchema = z.object({
  planId: z.string().max(40).optional(),
  status: z.enum(STATUSES).optional(),
  trialEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
const PlanSchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceMonthly: z.number().int().min(0).max(100_000_000),
  maxStores: z.number().int().positive().nullable(),
  maxRegisters: z.number().int().positive().nullable(),
  active: z.boolean(),
});
const UserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["admin", "support"]),
  password: z.string().min(10, "Use at least 10 characters").max(200),
});
const UserUpdateSchema = z.object({
  role: z.enum(["admin", "support"]).optional(),
  active: z.boolean().optional(),
  password: z.string().min(10, "Use at least 10 characters").max(200).optional(),
});

async function platformAudit(db: Db | Tx, ctx: PlatformContext | null, tenantId: string | null, action: string, data: object = {}) {
  await db.query("INSERT INTO platform_audit (platform_user_id, tenant_id, action, data) VALUES ($1, $2, $3, $4)", [
    ctx?.userId ?? null,
    tenantId,
    action,
    JSON.stringify(data),
  ]);
}

export async function platformRoutes(app: FastifyInstance) {
  async function auth(req: FastifyRequest): Promise<PlatformContext> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized", "Please sign in");
    const { rows } = await app.db.query(
      `SELECT u.id, u.role, u.name FROM platform_sessions s JOIN platform_users u ON u.id = s.platform_user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`,
      [hashToken(header.slice(7))],
    );
    if (!rows[0]) throw new HttpError(401, "unauthorized", "Your session has ended. Please sign in again.");
    return { userId: rows[0].id, role: rows[0].role, name: rows[0].name };
  }
  const adminOnly = (ctx: PlatformContext) => {
    if (ctx.role !== "admin") throw new HttpError(403, "forbidden", "Only a platform admin can do this");
  };

  app.post("/login", async (req) => {
    const { email, password } = LoginSchema.parse(req.body);
    // Failures share the sign-in throttle table, under their own key.
    const key = `platform:${email.toLowerCase()}`;
    const failures = await app.db.query(
      "SELECT COUNT(*)::int AS n FROM login_attempts WHERE email = $1 AND at > now() - interval '15 minutes'",
      [key],
    );
    if (failures.rows[0].n >= MAX_FAILURES) {
      throw new HttpError(429, "too_many_attempts", "Too many wrong passwords. Try again in 15 minutes.");
    }
    const { rows } = await app.db.query(
      "SELECT id, name, role, password_hash FROM platform_users WHERE lower(email) = lower($1) AND active",
      [email],
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      await app.db.query("INSERT INTO login_attempts (email) VALUES ($1)", [key]);
      throw new HttpError(401, "bad_credentials", "Email or password is wrong");
    }
    await app.db.query("DELETE FROM login_attempts WHERE email = $1", [key]);
    const { token, hash } = newDeviceToken();
    await app.db.query(
      `INSERT INTO platform_sessions (id, token_hash, platform_user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [randomUUID(), hash, user.id, SESSION_HOURS],
    );
    await app.db.query("UPDATE platform_users SET last_login_at = now() WHERE id = $1", [user.id]);
    return { token, user: { id: user.id, name: user.name, role: user.role } };
  });

  app.post("/logout", async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      await app.db.query("UPDATE platform_sessions SET revoked_at = now() WHERE token_hash = $1", [hashToken(header.slice(7))]);
    }
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const ctx = await auth(req);
    return { user: { id: ctx.userId, name: ctx.name, role: ctx.role } };
  });

  /** The numbers on the console's first page, and whether the system is healthy. */
  app.get("/overview", async (req) => {
    await auth(req);
    const started = Date.now();
    await app.db.query("SELECT 1");
    const dbMs = Date.now() - started;
    const { rows } = await app.db.query(
      `SELECT
         (SELECT json_object_agg(status, n) FROM (SELECT status, COUNT(*)::int AS n FROM tenants GROUP BY status) x) AS by_status,
         (SELECT COUNT(*)::int FROM tenants WHERE created_at > now() - interval '7 days') AS signups_7d,
         (SELECT COUNT(*)::int FROM tenants WHERE created_at > now() - interval '30 days') AS signups_30d,
         (SELECT COUNT(*)::int FROM tenants WHERE status = 'trial' AND trial_ends_at < now() + interval '3 days') AS trials_ending,
         (SELECT COALESCE(SUM(p.price_monthly), 0)::bigint FROM tenants t JOIN plans p ON p.id = t.plan_id
           WHERE t.status IN ('active', 'past_due')) AS mrr,
         (SELECT COUNT(*)::int FROM devices WHERE revoked_at IS NULL AND last_seen_at > now() - interval '5 minutes') AS devices_online,
         (SELECT COUNT(*)::int FROM devices WHERE revoked_at IS NULL) AS devices,
         (SELECT COUNT(*)::int FROM orders WHERE created_at > now() - interval '24 hours') AS orders_24h,
         (SELECT COALESCE(SUM(total), 0)::bigint FROM orders WHERE created_at > now() - interval '24 hours') AS sales_24h,
         (SELECT COUNT(*)::int FROM orders WHERE totals_mismatch AND created_at > now() - interval '7 days') AS mismatches_7d,
         (SELECT COUNT(*)::int FROM card_transactions WHERE status IN ('pending', 'unknown')
             AND created_at < now() - interval '10 minutes') AS card_unanswered,
         (SELECT COUNT(*)::int FROM einvoices WHERE status IN ('failed', 'rejected')) AS einvoice_problems,
         (SELECT COUNT(*)::int FROM einvoices WHERE status IN ('pending', 'sending') AND created_at < now() - interval '1 hour') AS einvoice_stuck,
         (SELECT COALESCE(json_agg(name ORDER BY name), '[]') FROM schema_migrations) AS migrations`,
    );
    const r = rows[0];
    const checks = [
      { id: "database", label: "Database", ok: dbMs < 1000, detail: `${dbMs} ms` },
      { id: "card", label: "Card payments waiting for an answer", ok: r.card_unanswered === 0, detail: String(r.card_unanswered) },
      { id: "einvoice", label: "E-invoices stuck for over an hour", ok: r.einvoice_stuck === 0, detail: String(r.einvoice_stuck) },
      { id: "einvoice_failed", label: "E-invoices failed or rejected", ok: r.einvoice_problems === 0, detail: String(r.einvoice_problems) },
      { id: "mismatch", label: "Bills with a total mismatch (7 days)", ok: r.mismatches_7d === 0, detail: String(r.mismatches_7d) },
    ];
    return {
      tenants: { byStatus: r.by_status ?? {}, signups7d: r.signups_7d, signups30d: r.signups_30d, trialsEnding: r.trials_ending },
      mrr: Number(r.mrr),
      devices: { online: r.devices_online, total: r.devices },
      orders24h: r.orders_24h,
      sales24h: Number(r.sales_24h),
      checks,
      server: { uptimeSeconds: Math.round(process.uptime()), node: process.version, migrations: r.migrations },
    };
  });

  app.get("/tenants", async (req) => {
    await auth(req);
    const f = ListSchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.q) {
      params.push(`%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`(t.name ILIKE $${params.length} OR t.contact_email ILIKE $${params.length}
                   OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE $${params.length}))`);
    }
    if (f.status) {
      params.push(f.status);
      where.push(`t.status = $${params.length}`);
    }
    if (f.plan) {
      params.push(f.plan);
      where.push(`t.plan_id = $${params.length}`);
    }
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await app.db.query(`SELECT COUNT(*)::int AS n FROM tenants t ${sql}`, params);
    params.push(f.limit, f.offset);
    const { rows } = await app.db.query(
      `SELECT t.id, t.name, t.status, t.plan_id AS "planId", p.name AS "planName", t.trial_ends_at AS "trialEndsAt",
              t.business_type AS "businessType", t.created_at AS "createdAt",
              COALESCE(t.contact_email, (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner'
                                          ORDER BY u.email LIMIT 1)) AS "contactEmail",
              (SELECT COUNT(*)::int FROM stores s WHERE s.tenant_id = t.id) AS stores,
              (SELECT COUNT(*)::int FROM registers r JOIN stores s ON s.id = r.store_id WHERE s.tenant_id = t.id) AS registers,
              (SELECT MAX(o.created_at) FROM orders o WHERE o.tenant_id = t.id) AS "lastSaleAt",
              (SELECT COALESCE(SUM(o.total), 0)::bigint FROM orders o WHERE o.tenant_id = t.id
                  AND o.created_at > now() - interval '30 days') AS "sales30d"
         FROM tenants t JOIN plans p ON p.id = t.plan_id ${sql}
        ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { tenants: rows.map((r) => ({ ...r, sales30d: Number(r.sales30d) })), count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/tenants/:id", async (req) => {
    await auth(req);
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await app.db.query(
      `SELECT t.id, t.name, t.status, t.plan_id AS "planId", t.trial_ends_at AS "trialEndsAt", t.business_type AS "businessType",
              t.contact_email AS "contactEmail", t.contact_phone AS "contactPhone", t.notes, t.created_at AS "createdAt",
              t.status_changed_at AS "statusChangedAt"
         FROM tenants t WHERE t.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound("Business");
    const [stores, users, activity, audit, support] = await Promise.all([
      app.db.query(
        `SELECT s.id, s.code, s.name, s.trn,
                (SELECT COUNT(*)::int FROM registers r WHERE r.store_id = s.id) AS registers,
                (SELECT COUNT(*)::int FROM devices d JOIN registers r ON r.id = d.register_id
                  WHERE r.store_id = s.id AND d.revoked_at IS NULL) AS devices,
                (SELECT COUNT(*)::int FROM devices d JOIN registers r ON r.id = d.register_id
                  WHERE r.store_id = s.id AND d.revoked_at IS NULL AND d.last_seen_at > now() - interval '5 minutes') AS "devicesOnline"
           FROM stores s WHERE s.tenant_id = $1 ORDER BY s.code`,
        [id],
      ),
      app.db.query(
        `SELECT id, name, email, role, active, last_login_at AS "lastLoginAt" FROM users
          WHERE tenant_id = $1 AND role IN ('owner', 'manager') ORDER BY role DESC, name`,
        [id],
      ),
      app.db.query(
        `SELECT COUNT(*)::int AS "orders30d", COALESCE(SUM(total), 0)::bigint AS "sales30d", MAX(created_at) AS "lastSaleAt",
                (SELECT COUNT(*)::int FROM products WHERE tenant_id = $1 AND active) AS products
           FROM orders WHERE tenant_id = $1 AND created_at > now() - interval '30 days'`,
        [id],
      ),
      app.db.query(
        `SELECT a.id, a.action, a.data, a.at, u.name AS "by" FROM platform_audit a LEFT JOIN platform_users u ON u.id = a.platform_user_id
          WHERE a.tenant_id = $1 ORDER BY a.at DESC LIMIT 50`,
        [id],
      ),
      app.db.query(
        `SELECT s.id, s.created_at AS "createdAt", s.expires_at AS "endsAt", s.support_reason AS reason, p.name AS "by"
           FROM admin_sessions s JOIN platform_users p ON p.id = s.support_by
          WHERE s.tenant_id = $1 ORDER BY s.created_at DESC LIMIT 20`,
        [id],
      ),
    ]);
    const a = activity.rows[0];
    return {
      tenant: rows[0],
      stores: stores.rows,
      users: users.rows,
      activity: { ...a, sales30d: Number(a.sales30d) },
      audit: audit.rows,
      supportSessions: support.rows,
    };
  });

  app.put<{ Params: { id: string } }>("/tenants/:id", async (req) => {
    const ctx = await auth(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = TenantUpdateSchema.parse(req.body);
    // Support staff may keep notes and extend a trial; plan and account status are for admins.
    if (body.planId !== undefined || body.status !== undefined) adminOnly(ctx);
    return withTx(app.db, async (tx) => {
      const cur = await tx.query("SELECT plan_id, status, trial_ends_at, notes FROM tenants WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rows[0]) throw notFound("Business");
      if (body.planId !== undefined) {
        const plan = await tx.query("SELECT 1 FROM plans WHERE id = $1", [body.planId]);
        if (!plan.rowCount) throw new HttpError(400, "bad_request", "Unknown plan");
      }
      await tx.query(
        `UPDATE tenants SET plan_id = COALESCE($2, plan_id), status = COALESCE($3, status),
                trial_ends_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE trial_ends_at END,
                notes = CASE WHEN $6::boolean THEN $7 ELSE notes END,
                status_changed_at = CASE WHEN $3::text IS NOT NULL AND $3::text <> status THEN now() ELSE status_changed_at END
          WHERE id = $1`,
        [
          id,
          body.planId ?? null,
          body.status ?? null,
          body.trialEndsAt !== undefined,
          body.trialEndsAt ?? null,
          body.notes !== undefined,
          body.notes ?? null,
        ],
      );
      const before = cur.rows[0];
      const changes: Record<string, unknown> = {};
      if (body.planId !== undefined && body.planId !== before.plan_id) changes.plan = { from: before.plan_id, to: body.planId };
      if (body.status !== undefined && body.status !== before.status) changes.status = { from: before.status, to: body.status };
      if (body.trialEndsAt !== undefined) changes.trialEndsAt = body.trialEndsAt;
      if (body.notes !== undefined && body.notes !== before.notes) changes.notes = true;
      if (Object.keys(changes).length) await platformAudit(tx, ctx, id, "tenant.update", changes);
      // Pausing or closing an account also ends its back office sessions (not support ones).
      if (body.status === "suspended" || body.status === "cancelled") {
        await tx.query("UPDATE admin_sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL AND support_by IS NULL", [id]);
      }
      return { ok: true };
    });
  });

  /**
   * Signs a platform user in to a business's back office as its owner, for an hour, to help
   * them. The business sees who did it, and why, in its own audit log.
   */
  app.post<{ Params: { id: string } }>("/tenants/:id/support-session", async (req) => {
    const ctx = await auth(req);
    const id = z.string().uuid().parse(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(5, "Say why, in a few words").max(300) }).parse(req.body);
    const owner = await app.db.query(
      "SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND active ORDER BY last_login_at DESC NULLS LAST LIMIT 1",
      [id],
    );
    if (!owner.rows[0]) throw new HttpError(409, "no_owner", "This business has no active owner to sign in as");
    return withTx(app.db, async (tx) => {
      const token = await openAdminSession(tx, owner.rows[0].id, id, { by: ctx.userId, reason, minutes: SUPPORT_MINUTES });
      await tx.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1::uuid, $2, 'support.sign_in', 'tenant', $1::text, $3)`,
        [id, owner.rows[0].id, JSON.stringify({ support: ctx.name, reason, minutes: SUPPORT_MINUTES })],
      );
      await platformAudit(tx, ctx, id, "support.sign_in", { reason });
      return { token, minutes: SUPPORT_MINUTES };
    });
  });

  app.get("/plans", async (req) => {
    await auth(req);
    const { rows } = await app.db.query(
      `SELECT p.id, p.name, p.price_monthly AS "priceMonthly", p.max_stores AS "maxStores", p.max_registers AS "maxRegisters",
              p.active, (SELECT COUNT(*)::int FROM tenants t WHERE t.plan_id = p.id AND t.status <> 'cancelled') AS tenants
         FROM plans p ORDER BY p.sort, p.id`,
    );
    return { plans: rows };
  });

  app.put<{ Params: { id: string } }>("/plans/:id", async (req) => {
    const ctx = await auth(req);
    adminOnly(ctx);
    const body = PlanSchema.parse(req.body);
    const res = await app.db.query(
      `UPDATE plans SET name = $2, price_monthly = $3, max_stores = $4, max_registers = $5, active = $6, updated_at = now() WHERE id = $1`,
      [req.params.id, body.name, body.priceMonthly, body.maxStores, body.maxRegisters, body.active],
    );
    if (!res.rowCount) throw notFound("Plan");
    await platformAudit(app.db, ctx, null, "plan.update", { plan: req.params.id, ...body });
    return { ok: true };
  });

  app.get("/users", async (req) => {
    await auth(req);
    const { rows } = await app.db.query(
      `SELECT id, email, name, role, active, last_login_at AS "lastLoginAt", created_at AS "createdAt" FROM platform_users ORDER BY name`,
    );
    return { users: rows };
  });

  app.post("/users", async (req) => {
    const ctx = await auth(req);
    adminOnly(ctx);
    const body = UserSchema.parse(req.body);
    const id = randomUUID();
    try {
      await app.db.query("INSERT INTO platform_users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)", [
        id,
        body.email,
        body.name,
        body.role,
        hashPassword(body.password),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "email_taken", "A platform user already has this email");
      throw err;
    }
    await platformAudit(app.db, ctx, null, "platform_user.create", { id, email: body.email, role: body.role });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/users/:id", async (req) => {
    const ctx = await auth(req);
    adminOnly(ctx);
    const id = z.string().uuid().parse(req.params.id);
    const body = UserUpdateSchema.parse(req.body);
    if (id === ctx.userId && (body.active === false || body.role === "support")) {
      throw new HttpError(409, "self_lockout", "You cannot remove your own admin access");
    }
    return withTx(app.db, async (tx) => {
      const res = await tx.query(
        `UPDATE platform_users SET role = COALESCE($2, role), active = COALESCE($3, active),
                password_hash = COALESCE($4, password_hash) WHERE id = $1`,
        [id, body.role ?? null, body.active ?? null, body.password ? hashPassword(body.password) : null],
      );
      if (!res.rowCount) throw notFound("Platform user");
      if (body.active === false || body.password) {
        await tx.query("UPDATE platform_sessions SET revoked_at = now() WHERE platform_user_id = $1 AND revoked_at IS NULL", [id]);
      }
      await platformAudit(tx, ctx, null, "platform_user.update", { id, role: body.role, active: body.active, password: !!body.password });
      return { ok: true };
    });
  });

  app.get("/audit", async (req) => {
    await auth(req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    const { rows } = await app.db.query(
      `SELECT a.id, a.action, a.data, a.at, u.name AS "by", t.id AS "tenantId", t.name AS "tenantName"
         FROM platform_audit a LEFT JOIN platform_users u ON u.id = a.platform_user_id LEFT JOIN tenants t ON t.id = a.tenant_id
        ORDER BY a.at DESC LIMIT $1`,
      [limit],
    );
    return { audit: rows };
  });
}

/** Creates (or resets) a platform admin from the command line or a seed. */
export async function ensurePlatformAdmin(db: Db, email: string, name: string, password: string) {
  const { rows } = await db.query(
    `INSERT INTO platform_users (id, email, name, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)
     ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true, role = 'admin'
     RETURNING id`,
    [randomUUID(), email.toLowerCase(), name, hashPassword(password)],
  );
  return rows[0].id as string;
}
