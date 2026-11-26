import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../app.js";
import { HttpError, notFound } from "../../errors.js";
import { DEFAULT_RATE_LIMIT, newApiKey, SCOPE_NAMES, SCOPES, type Scope } from "../../public/auth.js";
import { checkWebhookUrl, deliverNow, eventBody, MAX_ATTEMPTS, newWebhookSecret } from "../../webhooks/deliver.js";
import { API_VERSION, emitEvent, EVENT_NAMES, EVENT_TYPES } from "../../webhooks/events.js";
import { adminAudit, forbidden } from "./common.js";

const MAX_KEYS = 25;
const MAX_ENDPOINTS = 10;

const KeySchema = z.object({
  name: z.string().trim().min(1, "Give the key a name, like the app that will use it").max(80),
  scopes: z
    .array(z.enum(SCOPE_NAMES as [Scope, ...Scope[]]))
    .min(1, "Choose at least one permission")
    .transform((s) => [...new Set(s)]),
  rateLimit: z.number().int().min(10).max(6000).default(DEFAULT_RATE_LIMIT),
  /** Optional end date; the key stops working at the end of that day (UTC). */
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});

const EndpointSchema = z.object({
  url: z.string().trim().min(1, "Enter the address").max(500),
  description: z.string().trim().max(200).nullish(),
  events: z
    .array(z.enum(["*", ...EVENT_NAMES] as [string, ...string[]]))
    .min(1, "Choose at least one event")
    .transform((e) => (e.includes("*") ? ["*"] : [...new Set(e)])),
  active: z.boolean().default(true),
});

const DeliveryList = z.object({
  status: z.enum(["all", "pending", "succeeded", "failed"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

const ownerOnly = (ctx: AdminContext) => {
  if (ctx.role !== "owner") throw forbidden("Only the owner can manage API keys and webhooks");
};

const ENDPOINT_SELECT = `
  SELECT w.id, w.url, w.description, w.events, w.active, w.disabled_reason AS "disabledReason",
         w.failing_since AS "failingSince", w.last_success_at AS "lastSuccessAt", w.created_at AS "createdAt",
         COUNT(d.id) FILTER (WHERE d.status = 'pending')::int AS pending,
         COUNT(d.id) FILTER (WHERE d.status = 'failed' AND d.created_at > now() - interval '7 days')::int AS "failedWeek",
         COUNT(d.id) FILTER (WHERE d.status = 'succeeded' AND d.created_at > now() - interval '7 days')::int AS "succeededWeek"
    FROM webhook_endpoints w LEFT JOIN webhook_deliveries d ON d.endpoint_id = w.id`;

const parseUuid = (id: string, what: string) => {
  if (!z.string().uuid().safeParse(id).success) throw notFound(what);
  return id;
};

/** API keys and webhooks, for the owner's Developers page. */
export async function developerRoutes(app: FastifyInstance) {
  const urlError = (url: string) => {
    const err = checkWebhookUrl(url, app.webhookOptions);
    if (err) throw new HttpError(400, "bad_url", err);
  };

  app.get("/developers/meta", async (req) => {
    await app.authAdmin(req);
    return {
      scopes: Object.entries(SCOPES).map(([id, label]) => ({ id, label })),
      events: Object.entries(EVENT_TYPES).map(([id, label]) => ({ id, label })),
      apiVersion: API_VERSION,
      maxAttempts: MAX_ATTEMPTS,
      defaultRateLimit: DEFAULT_RATE_LIMIT,
    };
  });

  // API keys

  app.get("/api-keys", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT k.id, k.name, k.prefix, k.scopes, k.rate_limit AS "rateLimit", k.created_at AS "createdAt",
              k.last_used_at AS "lastUsedAt", k.expires_at AS "expiresAt", k.revoked_at AS "revokedAt", u.name AS "createdBy",
              (SELECT COALESCE(SUM(count), 0)::int FROM api_rate_windows w WHERE w.key_id = k.id AND w.window_start > now() - interval '1 hour') AS "requestsHour"
         FROM api_keys k JOIN users u ON u.id = k.created_by
        WHERE k.tenant_id = $1 ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
      [ctx.tenantId],
    );
    return { keys: rows };
  });

  /** The full key is in this answer only; afterwards only its first characters are shown. */
  app.post("/api-keys", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const body = KeySchema.parse(req.body);
    const expiresAt = body.expiresOn ? new Date(`${body.expiresOn}T23:59:59.999Z`) : null;
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now())) {
      throw new HttpError(400, "bad_request", "The end date must be today or later");
    }
    const { rows } = await app.db.query(
      "SELECT COUNT(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL",
      [ctx.tenantId],
    );
    if (rows[0].n >= MAX_KEYS) throw new HttpError(409, "too_many_keys", `A business can have ${MAX_KEYS} keys. Revoke one you no longer use.`);
    const id = randomUUID();
    const key = newApiKey();
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, token_hash, scopes, rate_limit, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, ctx.tenantId, body.name, key.prefix, key.hash, body.scopes, body.rateLimit, ctx.userId, expiresAt],
    );
    await adminAudit(app.db, ctx, "api_key.create", "api_key", id, { name: body.name, scopes: body.scopes });
    return { id, key: key.token, prefix: key.prefix };
  });

  app.post<{ Params: { id: string } }>("/api-keys/:id/revoke", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const res = await app.db.query(
      `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND tenant_id = $2 RETURNING name`,
      [parseUuid(req.params.id, "API key"), ctx.tenantId],
    );
    if (!res.rowCount) throw notFound("API key");
    await adminAudit(app.db, ctx, "api_key.revoke", "api_key", req.params.id, { name: res.rows[0].name });
    return { ok: true };
  });

  // Webhook endpoints

  app.get("/webhooks", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${ENDPOINT_SELECT} WHERE w.tenant_id = $1 GROUP BY w.id ORDER BY w.created_at`, [ctx.tenantId]);
    return { endpoints: rows };
  });

  app.get<{ Params: { id: string } }>("/webhooks/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${ENDPOINT_SELECT} WHERE w.id = $1 AND w.tenant_id = $2 GROUP BY w.id`, [
      parseUuid(req.params.id, "Webhook"),
      ctx.tenantId,
    ]);
    if (!rows[0]) throw notFound("Webhook");
    return rows[0];
  });

  /** The signing secret is returned once here; the owner can show it again or replace it later. */
  app.post("/webhooks", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const body = EndpointSchema.parse(req.body);
    urlError(body.url);
    const { rows } = await app.db.query("SELECT COUNT(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1", [ctx.tenantId]);
    if (rows[0].n >= MAX_ENDPOINTS) throw new HttpError(409, "too_many_webhooks", `A business can have ${MAX_ENDPOINTS} webhooks`);
    const id = randomUUID();
    const secret = newWebhookSecret();
    await app.db.query(
      `INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ctx.tenantId, body.url, body.description || null, body.events, secret, body.active, ctx.userId],
    );
    await adminAudit(app.db, ctx, "webhook.create", "webhook", id, { url: body.url, events: body.events });
    return { id, secret };
  });

  app.put<{ Params: { id: string } }>("/webhooks/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const body = EndpointSchema.parse(req.body);
    urlError(body.url);
    // Turning it back on clears the reason it was turned off and gives it a fresh start.
    const res = await app.db.query(
      `UPDATE webhook_endpoints SET url = $3, description = $4, events = $5, active = $6, updated_at = now(),
              disabled_reason = CASE WHEN $6 THEN NULL ELSE disabled_reason END,
              failing_since = CASE WHEN $6 AND NOT active THEN NULL ELSE failing_since END
        WHERE id = $1 AND tenant_id = $2`,
      [parseUuid(req.params.id, "Webhook"), ctx.tenantId, body.url, body.description || null, body.events, body.active],
    );
    if (!res.rowCount) throw notFound("Webhook");
    await adminAudit(app.db, ctx, "webhook.update", "webhook", req.params.id, { url: body.url, events: body.events, active: body.active });
    return { id: req.params.id };
  });

  app.delete<{ Params: { id: string } }>("/webhooks/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const res = await app.db.query("DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2 RETURNING url", [
      parseUuid(req.params.id, "Webhook"),
      ctx.tenantId,
    ]);
    if (!res.rowCount) throw notFound("Webhook");
    await adminAudit(app.db, ctx, "webhook.delete", "webhook", req.params.id, { url: res.rows[0].url });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/webhooks/:id/secret", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const { rows } = await app.db.query("SELECT secret FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2", [
      parseUuid(req.params.id, "Webhook"),
      ctx.tenantId,
    ]);
    if (!rows[0]) throw notFound("Webhook");
    return { secret: rows[0].secret };
  });

  /** A new secret takes effect at once, so update the receiver straight after. */
  app.post<{ Params: { id: string } }>("/webhooks/:id/secret", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const secret = newWebhookSecret();
    const res = await app.db.query("UPDATE webhook_endpoints SET secret = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2", [
      parseUuid(req.params.id, "Webhook"),
      ctx.tenantId,
      secret,
    ]);
    if (!res.rowCount) throw notFound("Webhook");
    await adminAudit(app.db, ctx, "webhook.secret", "webhook", req.params.id);
    return { secret };
  });

  /** Sends a ping event now and answers with what the receiver said. */
  app.post<{ Params: { id: string } }>("/webhooks/:id/test", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const id = parseUuid(req.params.id, "Webhook");
    const ep = await app.db.query("SELECT active FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2", [id, ctx.tenantId]);
    if (!ep.rows[0]) throw notFound("Webhook");
    if (!ep.rows[0].active) throw new HttpError(409, "inactive", "Turn the webhook on before sending a test");
    const eventId = await emitEvent(app.db, ctx.tenantId, "ping", { message: "A test event from your POS back office", sentBy: ctx.name }, id);
    const { rows } = await app.db.query("SELECT id FROM webhook_deliveries WHERE event_id = $1", [eventId]);
    await deliverNow(app.db, rows[0].id, app.webhookOptions);
    return deliveryDetail(ctx.tenantId, rows[0].id);
  });

  // Delivery log

  app.get<{ Params: { id: string } }>("/webhooks/:id/deliveries", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = DeliveryList.parse(req.query);
    const params: unknown[] = [parseUuid(req.params.id, "Webhook"), ctx.tenantId];
    let where = "d.endpoint_id = $1 AND d.tenant_id = $2";
    if (f.status !== "all") {
      params.push(f.status);
      where += " AND d.status = $3";
    }
    const [list, count] = await Promise.all([
      app.db.query(
        `SELECT d.id, e.type, e.id AS "eventId", d.status, d.attempts, d.response_status AS "responseStatus", d.error,
                d.created_at AS "createdAt", d.last_attempt_at AS "lastAttemptAt", d.next_attempt_at AS "nextAttemptAt",
                d.delivered_at AS "deliveredAt"
           FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
          WHERE ${where} ORDER BY d.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n FROM webhook_deliveries d WHERE ${where}`, params),
    ]);
    return { deliveries: list.rows, count: count.rows[0].n };
  });

  async function deliveryDetail(tenantId: string, id: string) {
    const { rows } = await app.db.query(
      `SELECT d.id, d.endpoint_id AS "endpointId", w.url, e.id AS "eventId", e.type, e.data, e.created_at AS "eventCreatedAt",
              d.status, d.attempts, d.response_status AS "responseStatus", d.error, d.created_at AS "createdAt",
              d.next_attempt_at AS "nextAttemptAt", d.delivered_at AS "deliveredAt"
         FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id
        WHERE d.id = $1 AND d.tenant_id = $2`,
      [id, tenantId],
    );
    const d = rows[0];
    if (!d) throw notFound("Delivery");
    const attempts = await app.db.query(
      `SELECT at, response_status AS "responseStatus", response_body AS "responseBody", error, duration_ms AS "durationMs"
         FROM webhook_attempts WHERE delivery_id = $1 ORDER BY at DESC`,
      [id],
    );
    const { data, eventCreatedAt, ...rest } = d;
    return {
      ...rest,
      // Exactly what the receiver gets (the signature changes on every try).
      body: JSON.parse(eventBody({ id: d.eventId, type: d.type, createdAt: eventCreatedAt, data })),
      attemptLog: attempts.rows,
    };
  }

  app.get<{ Params: { id: string } }>("/webhook-deliveries/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    return deliveryDetail(ctx.tenantId, parseUuid(req.params.id, "Delivery"));
  });

  app.post<{ Params: { id: string } }>("/webhook-deliveries/:id/retry", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx);
    const id = parseUuid(req.params.id, "Delivery");
    const { rows } = await app.db.query(
      `SELECT w.active FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE d.id = $1 AND d.tenant_id = $2`,
      [id, ctx.tenantId],
    );
    if (!rows[0]) throw notFound("Delivery");
    if (!rows[0].active) throw new HttpError(409, "inactive", "Turn the webhook on before sending again");
    await deliverNow(app.db, id, app.webhookOptions);
    return deliveryDetail(ctx.tenantId, id);
  });
}
