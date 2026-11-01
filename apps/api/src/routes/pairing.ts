import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { newDeviceToken } from "../security.js";
import { loadDeviceSetup } from "./setup.js";

const ClaimSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().uuid(),
  deviceName: z.string().min(1).max(100),
});

export async function pairingRoutes(app: FastifyInstance) {
  /** A new device scans the pairing QR (or types the code) and receives its token. */
  app.post("/pairing/claim", async (req) => {
    const body = ClaimSchema.parse(req.body);
    const { token, hash } = newDeviceToken();
    const paired = await withTx(app.db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT register_id, role FROM pairing_codes
          WHERE code = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [body.code],
      );
      const pairing = rows[0];
      if (!pairing) throw new HttpError(400, "invalid_code", "Pairing code is wrong or expired");
      await tx.query("UPDATE pairing_codes SET used_at = now() WHERE code = $1", [body.code]);
      await tx.query(
        "INSERT INTO devices (id, register_id, name, role, token_hash) VALUES ($1, $2, $3, $4, $5)",
        [body.deviceId, pairing.register_id, body.deviceName, pairing.role, hash],
      );
      return { registerId: pairing.register_id as string, role: pairing.role as "till" | "display" };
    });
    return { token, ...(await loadDeviceSetup(app.db, paired.registerId, paired.role)) };
  });

  /** Lets a paired device refresh its store, register and open-session details. */
  app.get("/device/setup", async (req) => {
    const device = await app.authenticate(req);
    return loadDeviceSetup(app.db, device.registerId, device.role);
  });
}
