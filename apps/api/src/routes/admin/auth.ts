import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db, Tx } from "../../db.js";
import { HttpError } from "../../errors.js";
import { planUsage } from "../../tenants.js";
import { hashToken, newDeviceToken, verifyPassword } from "../../security.js";

const LoginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });

const SESSION_DAYS = 14;
/** After this many failed sign-ins in 15 minutes, an email is locked for the rest of that window. */
const MAX_FAILURES = 5;

/**
 * Opens a back office session and returns its token. A support session (opened by platform
 * staff from the platform console) is short and remembers who opened it and why.
 */
export async function openAdminSession(
  db: Db | Tx,
  userId: string,
  tenantId: string,
  support?: { by: string; reason: string; minutes: number },
) {
  const { token, hash } = newDeviceToken();
  await db.query(
    `INSERT INTO admin_sessions (id, token_hash, user_id, tenant_id, expires_at, support_by, support_reason)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7)`,
    [randomUUID(), hash, userId, tenantId, support ? support.minutes : SESSION_DAYS * 24 * 60, support?.by ?? null, support?.reason ?? null],
  );
  return token;
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/login", async (req) => {
    const { email, password } = LoginSchema.parse(req.body);
    const failures = await app.db.query(
      "SELECT COUNT(*)::int AS n FROM login_attempts WHERE lower(email) = lower($1) AND at > now() - interval '15 minutes'",
      [email],
    );
    if (failures.rows[0].n >= MAX_FAILURES) {
      throw new HttpError(429, "too_many_attempts", "Too many wrong passwords. Try again in 15 minutes.");
    }
    const { rows } = await app.db.query(
      `SELECT u.id, u.tenant_id, u.name, u.role, u.password_hash, t.name AS tenant_name, t.status AS tenant_status
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE lower(u.email) = lower($1) AND u.active AND u.role IN ('owner', 'manager')`,
      [email],
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      await app.db.query("INSERT INTO login_attempts (email) VALUES ($1)", [email]);
      throw new HttpError(401, "bad_credentials", "Email or password is wrong");
    }
    await app.db.query("DELETE FROM login_attempts WHERE lower(email) = lower($1)", [email]);
    if (user.tenant_status === "suspended" || user.tenant_status === "cancelled") {
      throw new HttpError(
        403,
        "account_" + user.tenant_status,
        user.tenant_status === "suspended"
          ? "This business account is paused. Your tills keep selling; contact support to sign in again."
          : "This business account is closed. Contact support if you need your data.",
      );
    }
    const token = await openAdminSession(app.db, user.id, user.tenant_id);
    await app.db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    return {
      token,
      user: { id: user.id, name: user.name, role: user.role },
      tenant: { id: user.tenant_id, name: user.tenant_name },
    };
  });

  app.post("/logout", async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      await app.db.query("UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1", [hashToken(header.slice(7))]);
    }
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT t.name, t.currency, t.status, t.trial_ends_at, COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name, 'code', s.code, 'timezone', s.timezone)
                ORDER BY s.code) FILTER (WHERE s.id IS NOT NULL), '[]') AS stores
         FROM tenants t LEFT JOIN stores s ON s.tenant_id = t.id AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
        WHERE t.id = $1 GROUP BY t.id`,
      [ctx.tenantId, ctx.storeIds],
    );
    const usage = await planUsage(app.db, ctx.tenantId);
    // Every store of the business, for picking the other end of a stock transfer.
    const all = await app.db.query("SELECT id, name, code FROM stores WHERE tenant_id = $1 ORDER BY code", [ctx.tenantId]);
    return {
      // storeIds null: head office, sees every store. A list: a store manager.
      user: { id: ctx.userId, name: ctx.name, role: ctx.role, storeIds: ctx.storeIds },
      tenant: { id: ctx.tenantId, name: rows[0].name, currency: rows[0].currency },
      stores: rows[0].stores,
      transferStores: all.rows,
      account: { status: rows[0].status, trialEndsAt: rows[0].trial_ends_at, ...usage },
      support: ctx.support ?? null,
    };
  });
}
