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
import { cardRoutes } from "./routes/card.js";
import { giftCardRoutes } from "./routes/giftCards.js";
import { platformRoutes } from "./routes/platform.js";
import { signupRoutes } from "./routes/signup.js";
import { createProviders, type PaymentProvider } from "./payments/index.js";
import { approvalRoutes } from "./routes/approvals.js";
import { tillEventRoutes } from "./routes/tillEvents.js";
import { createMailer, type Mailer } from "./reports/mailer.js";
import { publicRoutes } from "./public/routes.js";
import { deliverOptionsFromEnv, type DeliverOptions } from "./webhooks/deliver.js";

/** A signed-in back office user (owner or manager). */
export interface AdminContext {
  userId: string;
  tenantId: string;
  role: "owner" | "manager";
  name: string;
  /** Set when platform support signed in as this user, to help the business. */
  support?: { by: string; reason: string; endsAt: string };
  /** Set when the change came through the public API with this key. */
  apiKey?: { id: string; name: string };
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
    paymentProviders: Map<string, PaymentProvider>;
    mailer: Mailer;
    webhookOptions: DeliverOptions;
  }
}

export async function buildApp(
  db: Db,
  opts: { logger?: boolean; paymentProviders?: Map<string, PaymentProvider>; mailer?: Mailer; webhookOptions?: DeliverOptions } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 5 * 1024 * 1024,
    // Behind a load balancer, set TRUST_PROXY=1 so per-address limits (sign-up) see the real client.
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  await app.register(cors, { origin: true });
  app.decorate("db", db);
  app.decorate("paymentProviders", opts.paymentProviders ?? createProviders());
  app.decorate("mailer", opts.mailer ?? createMailer());
  app.decorate("webhookOptions", opts.webhookOptions ?? deliverOptionsFromEnv());

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
      `SELECT u.id, u.tenant_id, u.role, u.name, t.status, s.support_reason, s.expires_at, p.name AS support_name
         FROM admin_sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
         LEFT JOIN platform_users p ON p.id = s.support_by
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.active AND u.role IN ('owner', 'manager')`,
      [hashToken(header.slice(7))],
    );
    const row = rows[0];
    if (!row) throw new HttpError(401, "unauthorized", "Your session has ended. Please sign in again.");
    // A paused or closed business cannot use the back office, except through a support session.
    if (!row.support_name && (row.status === "suspended" || row.status === "cancelled")) {
      throw new HttpError(401, "unauthorized", "This business account is paused. Contact support.");
    }
    return {
      userId: row.id,
      tenantId: row.tenant_id,
      role: row.role,
      name: row.support_name ? `${row.support_name} (support)` : row.name,
      support: row.support_name
        ? { by: row.support_name, reason: row.support_reason, endsAt: (row.expires_at as Date).toISOString() }
        : undefined,
    };
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
  await app.register(cardRoutes);
  await app.register(giftCardRoutes);
  await app.register(signupRoutes);
  await app.register(approvalRoutes);
  await app.register(tillEventRoutes);
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(platformRoutes, { prefix: "/platform" });
  await app.register(publicRoutes);
  return app;
}
