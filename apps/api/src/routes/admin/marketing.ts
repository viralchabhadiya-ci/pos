import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { renderMessage, TENANT_TZ_SQL, withOptOut } from "../../crm/campaigns.js";
import { normalizePhone, reachable, segmentSql, SegmentRulesSchema, type Channel } from "../../crm/segments.js";
import { HttpError, notFound } from "../../errors.js";
import { adminAudit, forbidden, isUniqueViolation } from "./common.js";

const SegmentSchema = z.object({ name: z.string().trim().min(1, "Give the segment a name").max(80), rules: SegmentRulesSchema });

const CampaignSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name").max(120),
  kind: z.enum(["one_off", "birthday"]).default("one_off"),
  channel: z.enum(["email", "sms", "whatsapp"]),
  segmentId: z.string().uuid().nullish(),
  subject: z.string().trim().max(150).nullish(),
  message: z.string().trim().min(1, "Write the message").max(1000),
  couponCode: z.string().trim().toUpperCase().max(40).nullish(),
});

/** SMS over this many characters goes out as several parts and costs more. */
const SMS_PART = 160;

const CAMPAIGN_SELECT = `SELECT c.id, c.name, c.kind, c.channel, c.segment_id AS "segmentId", s.name AS "segmentName", c.subject, c.message,
         c.coupon_code AS "couponCode", c.status, c.scheduled_at AS "scheduledAt", c.started_at AS "startedAt", c.finished_at AS "finishedAt",
         c.created_at AS "createdAt",
         (SELECT json_build_object(
             'queued', COUNT(*) FILTER (WHERE m.status = 'queued'), 'sent', COUNT(*) FILTER (WHERE m.status = 'sent'),
             'failed', COUNT(*) FILTER (WHERE m.status = 'failed'), 'skipped', COUNT(*) FILTER (WHERE m.status = 'skipped'))
            FROM campaign_messages m WHERE m.campaign_id = c.id) AS counts
    FROM campaigns c LEFT JOIN customer_segments s ON s.id = c.segment_id`;

/** Back office Marketing: segments, campaigns by email, SMS and WhatsApp, and birthday offers. */
export async function marketingRoutes(app: FastifyInstance) {
  const tz = TENANT_TZ_SQL("$1");

  async function audience(tenantId: string, rules: z.infer<typeof SegmentRulesSchema>) {
    const params: unknown[] = [tenantId];
    const seg = segmentSql(rules, params, tz);
    const { rows } = await app.db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${reachable("email")})::int AS email,
              COUNT(*) FILTER (WHERE ${reachable("sms")})::int AS sms,
              COUNT(*) FILTER (WHERE ${reachable("whatsapp")})::int AS whatsapp
         FROM ${seg.from} WHERE ${seg.where}`,
      params,
    );
    const sample = await app.db.query(`SELECT c.id, c.name, c.phone, c.email FROM ${seg.from} WHERE ${seg.where} ORDER BY c.name LIMIT 5`, params);
    return { ...rows[0], sample: sample.rows };
  }

  const loadRules = async (tenantId: string, segmentId: string | null | undefined) => {
    if (!segmentId) return {};
    const { rows } = await app.db.query("SELECT rules FROM customer_segments WHERE id = $1 AND tenant_id = $2", [segmentId, tenantId]);
    if (!rows[0]) throw new HttpError(400, "bad_request", "That segment does not exist");
    return SegmentRulesSchema.parse(rows[0].rules);
  };

  // Segments
  app.get("/segments", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT id, name, rules, updated_at AS "updatedAt" FROM customer_segments WHERE tenant_id = $1 ORDER BY name`,
      [ctx.tenantId],
    );
    const withCounts = await Promise.all(rows.map(async (s) => ({ ...s, audience: await audience(ctx.tenantId, SegmentRulesSchema.parse(s.rules)) })));
    return { segments: withCounts, everyone: await audience(ctx.tenantId, {}) };
  });

  /** How many customers some rules would reach, before saving. */
  app.post("/segments/preview", async (req) => {
    const ctx = await app.authAdmin(req);
    return audience(ctx.tenantId, SegmentRulesSchema.parse((req.body as { rules?: unknown })?.rules ?? {}));
  });

  app.post("/segments", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = SegmentSchema.parse(req.body);
    const id = randomUUID();
    try {
      await app.db.query("INSERT INTO customer_segments (id, tenant_id, name, rules) VALUES ($1, $2, $3, $4)", [id, ctx.tenantId, b.name, JSON.stringify(b.rules)]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "name_taken", "Another segment has this name");
      throw err;
    }
    await adminAudit(app.db, ctx, "segment.create", "segment", id, { name: b.name });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/segments/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const b = SegmentSchema.parse(req.body);
    try {
      const r = await app.db.query("UPDATE customer_segments SET name = $3, rules = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2", [
        id,
        ctx.tenantId,
        b.name,
        JSON.stringify(b.rules),
      ]);
      if (!r.rowCount) throw notFound("Segment");
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "name_taken", "Another segment has this name");
      throw err;
    }
    await adminAudit(app.db, ctx, "segment.update", "segment", id, { name: b.name });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/segments/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const used = await app.db.query("SELECT 1 FROM campaigns WHERE segment_id = $1 AND status NOT IN ('sent', 'cancelled')", [id]);
    if (used.rowCount) throw new HttpError(409, "in_use", "A campaign that has not finished uses this segment");
    await app.db.query("UPDATE campaigns SET segment_id = NULL WHERE segment_id = $1 AND tenant_id = $2", [id, ctx.tenantId]);
    const r = await app.db.query("DELETE FROM customer_segments WHERE id = $1 AND tenant_id = $2 RETURNING name", [id, ctx.tenantId]);
    if (!r.rowCount) throw notFound("Segment");
    await adminAudit(app.db, ctx, "segment.delete", "segment", id, { name: r.rows[0].name });
    return { ok: true };
  });

  // Campaigns
  app.get("/campaigns", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${CAMPAIGN_SELECT} WHERE c.tenant_id = $1 ORDER BY c.created_at DESC LIMIT 200`, [ctx.tenantId]);
    return {
      campaigns: rows,
      // What is set up, so the screen can say when messages only go to the log.
      transports: { email: app.senders.email.transport, sms: app.senders.sms.transport, whatsapp: app.senders.whatsapp.transport },
      unsubscribeLinks: !!process.env.PUBLIC_URL,
    };
  });

  /**
   * One campaign with its results: messages by status, and sales by the customers who got it
   * in the 7 days after their message.
   */
  app.get<{ Params: { id: string } }>("/campaigns/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await app.db.query(`${CAMPAIGN_SELECT} WHERE c.id = $1 AND c.tenant_id = $2`, [id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Campaign");
    const results = await app.db.query(
      `SELECT COUNT(DISTINCT o.customer_id)::int AS buyers, COUNT(o.id)::int AS orders, COALESCE(SUM(o.total), 0)::int AS sales
         FROM campaign_messages m JOIN orders o ON o.customer_id = m.customer_id AND o.refund_of_order_id IS NULL
          AND o.created_at > m.sent_at AND o.created_at <= m.sent_at + interval '7 days'
        WHERE m.campaign_id = $1 AND m.status = 'sent'`,
      [id],
    );
    const recent = await app.db.query(
      `SELECT m.id, cu.name, m.to_address AS "to", m.status, m.error, m.sent_at AS "sentAt"
         FROM campaign_messages m JOIN customers cu ON cu.id = m.customer_id WHERE m.campaign_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
      [id],
    );
    return { ...rows[0], results: results.rows[0], messages: recent.rows };
  });

  const checkCampaign = async (tenantId: string, b: z.infer<typeof CampaignSchema>) => {
    if (b.channel === "email" && !b.subject) throw new HttpError(400, "bad_request", "An email needs a subject");
    if (b.segmentId) await loadRules(tenantId, b.segmentId);
    if (b.message.includes("{coupon}") && !b.couponCode) throw new HttpError(400, "bad_request", "The message has {coupon}; pick the coupon code");
    if (b.couponCode) {
      const { rowCount } = await app.db.query("SELECT 1 FROM promotions WHERE tenant_id = $1 AND code = $2 AND active", [tenantId, b.couponCode]);
      if (!rowCount) throw new HttpError(400, "bad_request", `No active coupon has the code ${b.couponCode}`);
    }
  };

  app.post("/campaigns", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = CampaignSchema.parse(req.body);
    await checkCampaign(ctx.tenantId, b);
    const id = randomUUID();
    await app.db.query(
      `INSERT INTO campaigns (id, tenant_id, name, kind, channel, segment_id, subject, message, coupon_code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, ctx.tenantId, b.name, b.kind, b.channel, b.kind === "birthday" ? null : (b.segmentId ?? null), b.subject ?? null, b.message, b.couponCode ?? null, ctx.userId],
    );
    await adminAudit(app.db, ctx, "campaign.create", "campaign", id, { name: b.name, channel: b.channel, kind: b.kind });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/campaigns/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const b = CampaignSchema.parse(req.body);
    await checkCampaign(ctx.tenantId, b);
    const r = await app.db.query(
      `UPDATE campaigns SET name = $3, kind = $4, channel = $5, segment_id = $6, subject = $7, message = $8, coupon_code = $9, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'scheduled', 'paused', 'active') RETURNING status`,
      [id, ctx.tenantId, b.name, b.kind, b.channel, b.kind === "birthday" ? null : (b.segmentId ?? null), b.subject ?? null, b.message, b.couponCode ?? null],
    );
    if (!r.rowCount) throw new HttpError(409, "wrong_state", "A campaign that is sending or sent cannot be changed");
    await adminAudit(app.db, ctx, "campaign.update", "campaign", id, { name: b.name });
    return { ok: true };
  });

  /** What one customer would get, with the placeholders filled. */
  app.post<{ Params: { id: string } }>("/campaigns/:id/preview", async (req) => {
    const ctx = await app.authAdmin(req);
    const c = await loadCampaign(ctx.tenantId, req.params.id);
    const rules = c.kind === "birthday" ? {} : await loadRules(ctx.tenantId, c.segmentId);
    const reach = await audience(ctx.tenantId, rules);
    const shop = (await app.db.query("SELECT name FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0].name as string;
    const sample = { name: reach.sample[0]?.name ?? "Fatima Ali", points: 120 };
    const text = withOptOut(c.channel, renderMessage(c.message, sample, { coupon: c.couponCode, shop }), process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/u/…` : null);
    return {
      text,
      subject: c.subject ? renderMessage(c.subject, sample, { coupon: c.couponCode, shop }) : null,
      reach: c.kind === "birthday" ? null : reach[c.channel as Channel],
      smsParts: c.channel === "sms" ? Math.ceil(text.length / SMS_PART) : null,
    };
  });

  /** Sends one copy to the owner's own address or number, without consent rules. */
  app.post<{ Params: { id: string } }>("/campaigns/:id/test", async (req) => {
    const ctx = await app.authAdmin(req);
    const c = await loadCampaign(ctx.tenantId, req.params.id);
    const { to } = z.object({ to: z.string().trim().min(3).max(200) }).parse(req.body);
    const addr = c.channel === "email" ? z.string().email("Enter an email address").parse(to) : normalizePhone(to);
    if (!addr) throw new HttpError(400, "bad_request", "Enter a mobile number, like 050 123 4567");
    const shop = (await app.db.query("SELECT name FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0].name as string;
    const me = { name: ctx.name, points: 0 };
    try {
      await app.senders[c.channel as Channel].send({
        to: addr,
        subject: c.subject ? `[Test] ${renderMessage(c.subject, me, { coupon: c.couponCode, shop })}` : null,
        text: renderMessage(c.message, me, { coupon: c.couponCode, shop }),
      });
    } catch (err) {
      throw new HttpError(502, "send_failed", `Could not send: ${(err as Error).message}`);
    }
    return { ok: true, to: addr, transport: app.senders[c.channel as Channel].transport };
  });

  /** Starts a campaign: one-off now or at a time, birthday offers from today on. Owners only. */
  app.post<{ Params: { id: string } }>("/campaigns/:id/start", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can send campaigns");
    if (!process.env.PUBLIC_URL) {
      throw new HttpError(409, "no_public_url", "Marketing messages must carry an unsubscribe link. Set PUBLIC_URL on the server first.");
    }
    const c = await loadCampaign(ctx.tenantId, req.params.id);
    const { at } = z.object({ at: z.string().datetime().nullish() }).parse(req.body ?? {});
    if (!["draft", "paused", "scheduled"].includes(c.status)) throw new HttpError(409, "wrong_state", `This campaign is ${c.status}`);
    const status = c.kind === "birthday" ? "active" : c.status === "paused" && c.startedAt ? "sending" : "scheduled";
    await app.db.query("UPDATE campaigns SET status = $3, scheduled_at = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2", [
      c.id,
      ctx.tenantId,
      status,
      at ?? new Date().toISOString(),
    ]);
    await adminAudit(app.db, ctx, "campaign.start", "campaign", c.id, { name: c.name, at: at ?? null });
    return { status };
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/pause", async (req) => {
    const ctx = await app.authAdmin(req);
    const c = await loadCampaign(ctx.tenantId, req.params.id);
    if (!["scheduled", "sending", "active"].includes(c.status)) throw new HttpError(409, "wrong_state", `This campaign is ${c.status}`);
    // A scheduled one-off that never started goes back to draft; one part sent waits as paused.
    const status = c.status === "scheduled" ? "draft" : "paused";
    await app.db.query("UPDATE campaigns SET status = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2", [c.id, ctx.tenantId, status]);
    await adminAudit(app.db, ctx, "campaign.pause", "campaign", c.id, { name: c.name });
    return { status };
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/cancel", async (req) => {
    const ctx = await app.authAdmin(req);
    const c = await loadCampaign(ctx.tenantId, req.params.id);
    if (["sent", "cancelled"].includes(c.status)) throw new HttpError(409, "wrong_state", `This campaign is ${c.status}`);
    await app.db.query("UPDATE campaigns SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1", [c.id]);
    await app.db.query("UPDATE campaign_messages SET status = 'skipped', error = 'Campaign cancelled' WHERE campaign_id = $1 AND status = 'queued'", [c.id]);
    await adminAudit(app.db, ctx, "campaign.cancel", "campaign", c.id, { name: c.name });
    return { status: "cancelled" };
  });

  async function loadCampaign(tenantId: string, rawId: string) {
    const id = z.string().uuid().parse(rawId);
    const { rows } = await app.db.query(
      `SELECT id, name, kind, channel, segment_id AS "segmentId", subject, message, coupon_code AS "couponCode", status, started_at AS "startedAt"
         FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (!rows[0]) throw notFound("Campaign");
    return rows[0];
  }
}
