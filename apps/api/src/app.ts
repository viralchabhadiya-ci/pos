import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Db } from "./db.js";
import { HttpError, unauthorized } from "./errors.js";
import { hashToken } from "./security.js";
import { customerRoutes } from "./routes/customers.js";
import { orderRoutes } from "./routes/orders.js";
import { pairingRoutes } from "./routes/pairing.js";
import { reportRoutes } from "./routes/reports.js";
import { sessionRoutes } from "./routes/sessions.js";
import { syncRoutes } from "./routes/sync.js";
import { adminRoutes } from "./routes/admin/index.js";
import { displayRoutes } from "./routes/display.js";
import { receiptPageRoutes } from "./routes/receiptPage.js";

/** A signed-in back office user (owner or manager). */
export interface AdminContext {
  userId: string;
  tenantId: string;
  role: "owner" | "manager";
  name: string;
}

export interface DeviceContext {
  deviceId: string;
  role: "till" | "display";
  registerId: string;
  storeId: string;
  tenantId: string;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    authenticate: (req: FastifyRequest) => Promise<DeviceContext>;
    authAdmin: (req: FastifyRequest) => Promise<AdminContext>;
  }
}

export async function buildApp(db: Db, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  app.decorate("db", db);

  app.decorate("authenticate", async (req: FastifyRequest): Promise<DeviceContext> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const { rows } = await db.query(
      `UPDATE devices d SET last_seen_at = now()
         FROM registers r JOIN stores s ON s.id = r.store_id
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND r.id = d.register_id
        RETURNING d.id, d.role, d.register_id, r.store_id, s.tenant_id`,
      [hashToken(header.slice(7))],
    );
    const row = rows[0];
    if (!row) throw unauthorized();
    return { deviceId: row.id, role: row.role, registerId: row.register_id, storeId: row.store_id, tenantId: row.tenant_id };
  });

  app.decorate("authAdmin", async (req: FastifyRequest): Promise<AdminContext> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized", "Please sign in");
    const { rows } = await db.query(
      `SELECT u.id, u.tenant_id, u.role, u.name FROM admin_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.active AND u.role IN ('owner', 'manager')`,
      [hashToken(header.slice(7))],
    );
    const row = rows[0];
    if (!row) throw new HttpError(401, "unauthorized", "Your session has ended. Please sign in again.");
    return { userId: row.id, tenantId: row.tenant_id, role: row.role, name: row.name };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong" });
  });

  app.get("/health", async () => ({ ok: true }));
  await app.register(pairingRoutes);
  await app.register(syncRoutes);
  await app.register(sessionRoutes);
  await app.register(orderRoutes);
  await app.register(customerRoutes);
  await app.register(reportRoutes);
  await app.register(displayRoutes);
  await app.register(receiptPageRoutes);
  await app.register(adminRoutes, { prefix: "/admin" });
  return app;
}
