import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../app.js";
import { HttpError, notFound } from "../../errors.js";
import { hashPassword, hashPin, verifyPin } from "../../security.js";
import { adminAudit, forbidden, isUniqueViolation } from "./common.js";

const Role = z.enum(["cashier", "manager", "owner"]);
const Pin = z.string().regex(/^\d{4,8}$/, "PIN must be 4 to 8 digits");

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: Role,
  pin: Pin,
  email: z.string().trim().email().nullish(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200).nullish(),
});

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: Role,
  active: z.boolean(),
  pin: Pin.nullish(),
  email: z.string().trim().email().nullish(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200).nullish(),
});

/** Managers look after cashiers; only an owner can add or change managers and owners. */
function canManage(ctx: AdminContext, role: string) {
  return ctx.role === "owner" || role === "cashier";
}

export async function staffRoutes(app: FastifyInstance) {
  /**
   * On the till a PIN alone says who is signing in, so two active people in one business
   * must never share a PIN.
   */
  async function assertPinFree(tenantId: string, pin: string, exceptUserId?: string) {
    const { rows } = await app.db.query(
      "SELECT id, pin_salt, pin_hash FROM users WHERE tenant_id = $1 AND active AND id IS DISTINCT FROM $2",
      [tenantId, exceptUserId ?? null],
    );
    if (rows.some((u) => verifyPin(pin, u.pin_salt, u.pin_hash))) {
      throw new HttpError(409, "pin_taken", "Someone else already uses this PIN. Choose another one.");
    }
  }

  const emailTaken = () => new HttpError(409, "email_taken", "This email is already used by another account");

  app.get("/staff", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT id, name, email, role, active, last_login_at AS "lastLoginAt", password_hash IS NOT NULL AS "canSignIn"
         FROM users WHERE tenant_id = $1 ORDER BY active DESC, role DESC, name`,
      [ctx.tenantId],
    );
    return { staff: rows };
  });

  app.post("/staff", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = CreateSchema.parse(req.body);
    if (!canManage(ctx, body.role)) throw forbidden("Only the owner can add managers or owners");
    await assertPinFree(ctx.tenantId, body.pin);
    const pin = hashPin(body.pin);
    const id = randomUUID();
    try {
      await app.db.query(
        `INSERT INTO users (id, tenant_id, name, email, role, pin_salt, pin_hash, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, body.name, body.email ?? null, body.role, pin.salt, pin.hash, body.password && body.role !== "cashier" ? hashPassword(body.password) : null],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
    await adminAudit(app.db, ctx, "staff.create", "user", id, { name: body.name, role: body.role });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/staff/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = UpdateSchema.parse(req.body);
    const { rows } = await app.db.query("SELECT role, active FROM users WHERE id = $1 AND tenant_id = $2", [req.params.id, ctx.tenantId]);
    const current = rows[0];
    if (!current) throw notFound("Staff member");
    if (!canManage(ctx, current.role) || !canManage(ctx, body.role)) throw forbidden("Only the owner can change managers or owners");
    if (req.params.id === ctx.userId && (!body.active || body.role !== ctx.role)) {
      throw new HttpError(400, "bad_request", "You cannot switch off or change the role of your own account");
    }
    if (body.pin) await assertPinFree(ctx.tenantId, body.pin, req.params.id);
    // Turning someone back on must not create a PIN clash either.
    if (!body.pin && body.active && !current.active) {
      const self = await app.db.query("SELECT pin_salt, pin_hash FROM users WHERE id = $1", [req.params.id]);
      const others = await app.db.query("SELECT pin_salt, pin_hash FROM users WHERE tenant_id = $1 AND active AND id <> $2", [
        ctx.tenantId,
        req.params.id,
      ]);
      if (others.rows.some((o) => o.pin_hash === self.rows[0].pin_hash && o.pin_salt === self.rows[0].pin_salt)) {
        throw new HttpError(409, "pin_taken", "Set a new PIN: someone active already uses this one");
      }
    }
    const pin = body.pin ? hashPin(body.pin) : null;
    try {
      await app.db.query(
        `UPDATE users SET name = $3, role = $4, active = $5, email = $6,
                pin_salt = COALESCE($7, pin_salt), pin_hash = COALESCE($8, pin_hash),
                password_hash = CASE WHEN $4 = 'cashier' THEN NULL ELSE COALESCE($9, password_hash) END,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, ctx.tenantId, body.name, body.role, body.active, body.email ?? null, pin?.salt ?? null, pin?.hash ?? null, body.password ? hashPassword(body.password) : null],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
    if (!body.active) {
      // A switched-off owner or manager is signed out of the back office at once.
      await app.db.query("UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.id]);
    }
    await adminAudit(app.db, ctx, "staff.update", "user", req.params.id, {
      name: body.name,
      role: body.role,
      active: body.active,
      pinReset: !!body.pin,
    });
    return { id: req.params.id };
  });
}
