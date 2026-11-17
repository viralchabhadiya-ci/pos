import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { buildPintXml } from "../../einvoice/pint.js";
import { loadDocument, loadSettings, sendNow, type QueueOptions } from "../../einvoice/queue.js";
import { adminAudit, forbidden } from "./common.js";

const STATUSES = ["pending", "sending", "accepted", "rejected", "failed", "skipped"] as const;

const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    scope: z.enum(["b2b", "all"]),
    provider: z.enum(["simulator", "http"]),
    simulatorMode: z.enum(["accept", "flaky", "down", "reject"]).default("accept"),
    endpointUrl: z.string().trim().url("Enter the provider's full address, starting with https://").max(500).nullish().or(z.literal("")),
    /** Leave out to keep the saved key; send "" to remove it. */
    apiKey: z.string().trim().max(500).optional(),
    legalName: z.string().trim().max(200).nullish(),
    street: z.string().trim().max(200).nullish(),
    city: z.string().trim().max(100).nullish(),
    emirate: z.enum(["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"]).nullish(),
    maxAttempts: z.number().int().min(1).max(20).default(8),
  })
  .superRefine((s, ctx) => {
    if (s.provider === "http" && !s.endpointUrl) {
      ctx.addIssue({ code: "custom", path: ["endpointUrl"], message: "Enter the provider's address" });
    }
    if (s.endpointUrl && !/^https:\/\//.test(s.endpointUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(s.endpointUrl)) {
      ctx.addIssue({ code: "custom", path: ["endpointUrl"], message: "Use an https:// address" });
    }
  });

const ListSchema = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const EINVOICE_SELECT = `SELECT e.id, e.order_id AS "orderId", e.kind, e.status, e.forced, e.attempts,
  e.next_attempt_at AS "nextAttemptAt", e.provider, e.provider_ref AS "providerRef", e.last_error AS "lastError",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt", e.accepted_at AS "acceptedAt", e.xml IS NOT NULL AS "hasXml"`;

const empty = (s: string | null | undefined) => (s ? s : null);

/** E-invoicing settings, the send queue and per-bill status for the back office. */
export async function einvoicingRoutes(app: FastifyInstance, opts: QueueOptions) {
  app.get("/einvoicing/settings", async (req) => {
    const ctx = await app.authAdmin(req);
    const { apiKey, ...settings } = await loadSettings(app.db, ctx.tenantId);
    const stores = await app.db.query(
      `SELECT id, name, trn FROM stores WHERE tenant_id = $1 ORDER BY code`,
      [ctx.tenantId],
    );
    const tenant = await app.db.query("SELECT name FROM tenants WHERE id = $1", [ctx.tenantId]);
    return { settings: { ...settings, hasApiKey: !!apiKey }, stores: stores.rows, tenantName: tenant.rows[0].name };
  });

  app.put("/einvoicing/settings", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change e-invoicing settings");
    const s = SettingsSchema.parse(req.body);
    await app.db.query(
      `INSERT INTO einvoice_settings (tenant_id, enabled, scope, provider, simulator_mode, endpoint_url, api_key,
              legal_name, street, city, emirate, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, ''), $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, scope = $3, provider = $4, simulator_mode = $5,
              endpoint_url = $6, api_key = COALESCE($7, einvoice_settings.api_key), legal_name = $8, street = $9,
              city = $10, emirate = $11, max_attempts = $12, updated_at = now()`,
      [ctx.tenantId, s.enabled, s.scope, s.provider, s.simulatorMode, empty(s.endpointUrl), s.apiKey ?? null,
        empty(s.legalName), empty(s.street), empty(s.city), s.emirate ?? null, s.maxAttempts],
    );
    const { apiKey: _secret, ...logged } = s;
    await adminAudit(app.db, ctx, "einvoicing.settings", "einvoicing", ctx.tenantId, {
      ...logged,
      apiKeyChanged: s.apiKey !== undefined,
    });
    return { ok: true };
  });

  app.get("/einvoices", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = ListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["e.tenant_id = $1"];
    if (f.status) {
      params.push(f.status);
      where.push(`e.status = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${f.q}%`);
      where.push(`o.number ILIKE $${params.length}`);
    }
    const sql = `FROM einvoices e JOIN orders o ON o.id = e.order_id WHERE ${where.join(" AND ")}`;
    const [list, count, counts] = await Promise.all([
      app.db.query(
        `${EINVOICE_SELECT}, o.number, o.total, o.created_at AS "billAt"
           ${sql} ORDER BY e.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
      app.db.query(`SELECT status, COUNT(*)::int AS n FROM einvoices WHERE tenant_id = $1 GROUP BY status`, [ctx.tenantId]),
    ]);
    return {
      einvoices: list.rows,
      count: count.rows[0].n,
      counts: Object.fromEntries(STATUSES.map((s) => [s, counts.rows.find((r) => r.status === s)?.n ?? 0])),
    };
  });

  /** The e-invoice behind one bill, with every send attempt. */
  app.get<{ Params: { id: string } }>("/orders/:id/einvoice", async (req) => {
    const ctx = await app.authAdmin(req);
    const order = await app.db.query("SELECT id FROM orders WHERE id = $1 AND tenant_id = $2", [req.params.id, ctx.tenantId]);
    if (!order.rows[0]) throw notFound("Bill");
    const settings = await loadSettings(app.db, ctx.tenantId);
    const { rows } = await app.db.query(`${EINVOICE_SELECT} FROM einvoices e WHERE e.order_id = $1`, [req.params.id]);
    const einvoice = rows[0] ?? null;
    const attempts = einvoice
      ? (
          await app.db.query(
            `SELECT at, provider, outcome, message, provider_ref AS "providerRef", duration_ms AS "durationMs"
               FROM einvoice_attempts WHERE einvoice_id = $1 ORDER BY at DESC, id DESC LIMIT 50`,
            [einvoice.id],
          )
        ).rows
      : [];
    return { enabled: settings.enabled, einvoice, attempts };
  });

  /** Queues a bill that has no e-invoice yet (sold before e-invoicing was on) and sends it. */
  app.post<{ Params: { id: string } }>("/orders/:id/einvoice", async (req) => {
    const ctx = await app.authAdmin(req);
    const settings = await loadSettings(app.db, ctx.tenantId);
    if (!settings.enabled) throw new HttpError(409, "einvoicing_off", "Turn on e-invoicing first");
    const id = await withTx(app.db, async (tx) => {
      const order = await tx.query("SELECT id, refund_of_order_id FROM orders WHERE id = $1 AND tenant_id = $2", [
        req.params.id,
        ctx.tenantId,
      ]);
      if (!order.rows[0]) throw notFound("Bill");
      const id = randomUUID();
      const res = await tx.query(
        `INSERT INTO einvoices (id, tenant_id, order_id, kind, forced) VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (order_id) DO NOTHING`,
        [id, ctx.tenantId, req.params.id, order.rows[0].refund_of_order_id ? "credit_note" : "invoice"],
      );
      if (!res.rowCount) throw new HttpError(409, "already_queued", "This bill already has an e-invoice");
      return id;
    });
    await adminAudit(app.db, ctx, "einvoice.create", "order", req.params.id, {});
    const result = await sendNow(app.db, id, opts);
    return { id, result };
  });

  /**
   * Sends a document again now. Works for failed and rejected ones (after the data was
   * fixed), for ones still waiting on a retry, and for skipped ones, which are then sent
   * even though they are outside the chosen scope.
   */
  app.post<{ Params: { id: string } }>("/einvoices/:id/retry", async (req) => {
    const ctx = await app.authAdmin(req);
    const settings = await loadSettings(app.db, ctx.tenantId);
    if (!settings.enabled) throw new HttpError(409, "einvoicing_off", "Turn on e-invoicing first");
    const { rows } = await app.db.query(
      `UPDATE einvoices SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL,
              forced = forced OR status = 'skipped', updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'failed', 'rejected', 'skipped')
        RETURNING order_id`,
      [req.params.id, ctx.tenantId],
    );
    if (!rows[0]) {
      const exists = await app.db.query("SELECT status FROM einvoices WHERE id = $1 AND tenant_id = $2", [
        req.params.id,
        ctx.tenantId,
      ]);
      if (!exists.rows[0]) throw notFound("E-invoice");
      throw new HttpError(409, "not_retryable", exists.rows[0].status === "accepted" ? "This e-invoice was already accepted" : "This e-invoice is being sent right now");
    }
    await adminAudit(app.db, ctx, "einvoice.retry", "order", rows[0].order_id, {});
    const result = await sendNow(app.db, req.params.id, opts);
    return { id: req.params.id, result };
  });

  /** Puts every failed document back in the queue, e.g. after the provider was down for a day. */
  app.post("/einvoices/retry-failed", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rowCount } = await app.db.query(
      `UPDATE einvoices SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND status = 'failed'`,
      [ctx.tenantId],
    );
    await adminAudit(app.db, ctx, "einvoice.retry_failed", "einvoicing", ctx.tenantId, { count: rowCount });
    return { queued: rowCount ?? 0 };
  });

  /** The UBL XML as sent, or as it would be sent now if it has not gone yet. */
  app.get<{ Params: { id: string } }>("/einvoices/:id/xml", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT e.xml, o.number FROM einvoices e JOIN orders o ON o.id = e.order_id WHERE e.id = $1 AND e.tenant_id = $2`,
      [req.params.id, ctx.tenantId],
    );
    if (!rows[0]) throw notFound("E-invoice");
    let xml: string = rows[0].xml;
    if (!xml) {
      const { doc } = await loadDocument(app.db, req.params.id, await loadSettings(app.db, ctx.tenantId));
      xml = buildPintXml(doc);
    }
    const file = `${String(rows[0].number).replace(/[^\w.-]/g, "_")}.xml`;
    return reply
      .header("content-type", "application/xml; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}"`)
      .send(xml);
  });
}
