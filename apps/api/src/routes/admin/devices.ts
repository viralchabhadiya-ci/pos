import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, notFound } from "../../errors.js";
import { createPairingCode } from "../../seed.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const RegisterSchema = z.object({
  storeId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  code: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers or dashes"),
});

const PairingSchema = z.object({ role: z.enum(["till", "display"]).default("till") });

/** A device counts as online when it has talked to the cloud in the last few minutes. */
const ONLINE_MINUTES = 5;

export async function deviceRoutes(app: FastifyInstance) {
  app.get("/registers", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT r.id, r.code, r.name, r.store_id AS "storeId", s.name AS "storeName",
              (SELECT json_build_object('id', ss.id, 'openedAt', ss.opened_at, 'openedBy', u.name)
                 FROM sessions ss JOIN users u ON u.id = ss.opened_by
                WHERE ss.register_id = r.id AND ss.state = 'open' ORDER BY ss.seq DESC LIMIT 1) AS "openSession",
              COALESCE((SELECT json_agg(json_build_object(
                         'id', d.id, 'name', d.name, 'role', d.role, 'pairedAt', d.paired_at,
                         'lastSeenAt', d.last_seen_at,
                         'online', d.last_seen_at > now() - make_interval(mins => $2))
                       ORDER BY d.paired_at)
                  FROM devices d WHERE d.register_id = r.id AND d.revoked_at IS NULL), '[]') AS devices
         FROM registers r JOIN stores s ON s.id = r.store_id
        WHERE s.tenant_id = $1 ORDER BY s.code, r.code`,
      [ctx.tenantId, ONLINE_MINUTES],
    );
    return { registers: rows };
  });

  app.post("/registers", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = RegisterSchema.parse(req.body);
    const store = await app.db.query("SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2", [body.storeId, ctx.tenantId]);
    if (!store.rowCount) throw notFound("Store");
    const id = randomUUID();
    try {
      await app.db.query("INSERT INTO registers (id, store_id, code, name) VALUES ($1, $2, $3, $4)", [
        id,
        body.storeId,
        body.code.toUpperCase(),
        body.name,
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "code_taken", "This store already has a register with that code");
      throw err;
    }
    await adminAudit(app.db, ctx, "register.create", "register", id, { name: body.name, code: body.code });
    return { id };
  });

  /** A one-time 6-digit code, typed or scanned on the new device within 15 minutes. */
  app.post<{ Params: { id: string } }>("/registers/:id/pairing-code", async (req) => {
    const ctx = await app.authAdmin(req);
    const { role } = PairingSchema.parse(req.body ?? {});
    const reg = await app.db.query(
      "SELECT 1 FROM registers r JOIN stores s ON s.id = r.store_id WHERE r.id = $1 AND s.tenant_id = $2",
      [req.params.id, ctx.tenantId],
    );
    if (!reg.rowCount) throw notFound("Register");
    const code = await createPairingCode(app.db, req.params.id, role);
    const { rows } = await app.db.query("SELECT expires_at AS \"expiresAt\" FROM pairing_codes WHERE code = $1", [code]);
    await adminAudit(app.db, ctx, "device.pairing_code", "register", req.params.id, { role });
    return { code, role, expiresAt: rows[0].expiresAt };
  });

  /** A lost or replaced device stops working at its next request. */
  app.post<{ Params: { id: string } }>("/devices/:id/revoke", async (req) => {
    const ctx = await app.authAdmin(req);
    const res = await app.db.query(
      `UPDATE devices d SET revoked_at = now()
         FROM registers r JOIN stores s ON s.id = r.store_id
        WHERE d.id = $1 AND d.register_id = r.id AND s.tenant_id = $2 AND d.revoked_at IS NULL
        RETURNING d.name`,
      [req.params.id, ctx.tenantId],
    );
    if (!res.rowCount) throw notFound("Device");
    await adminAudit(app.db, ctx, "device.revoke", "device", req.params.id, { name: res.rows[0].name });
    return { ok: true };
  });
}
