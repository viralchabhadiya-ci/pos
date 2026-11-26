import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { normalizePhone, reachable, segmentSql, SegmentRulesSchema, type Channel } from "./segments.js";
import type { Senders } from "./senders.js";

/** The business's timezone: its first store's. */
export const TENANT_TZ_SQL = (tenant: string) =>
  `COALESCE((SELECT s.timezone FROM stores s WHERE s.tenant_id = ${tenant} ORDER BY s.code LIMIT 1), 'Asia/Dubai')`;

/** Marketing goes out between these hours in the shop's time, never at night. */
export const SEND_FROM_HOUR = 9;
export const SEND_UNTIL_HOUR = 21;
/** Birthday offers go out from this hour on the day. */
export const BIRTHDAY_HOUR = 10;
const BATCH = 100;
const MAX_ATTEMPTS = 3;

export interface Recipient {
  name: string;
  points: number;
}

/**
 * Fills {name} (first name), {points}, {coupon} and {shop} in a message. Unknown braces stay
 * as they are, so a typo shows up in the preview rather than vanishing.
 */
export function renderMessage(template: string, r: Recipient, extra: { coupon?: string | null; shop: string }): string {
  const first = r.name.trim().split(/\s+/)[0] ?? "";
  return template.replace(/\{(name|points|coupon|shop)\}/g, (_, k: string) =>
    k === "name" ? first : k === "points" ? String(r.points) : k === "coupon" ? (extra.coupon ?? "") : extra.shop,
  );
}

/** SMS and WhatsApp carry the opt-out link in the text; email has it in the footer. */
export function withOptOut(channel: Channel, text: string, url: string | null) {
  if (!url || channel === "email") return text;
  return `${text}\nStop: ${url}`;
}

const token = () => randomBytes(18).toString("base64url");

/** Puts a message in the queue for every reachable customer of the campaign's segment. */
async function enqueueSegment(db: Db, campaign: { id: string; tenant_id: string; channel: Channel; segment_id: string | null }) {
  const rules = campaign.segment_id
    ? SegmentRulesSchema.parse((await db.query("SELECT rules FROM customer_segments WHERE id = $1", [campaign.segment_id])).rows[0]?.rules ?? {})
    : {};
  const params: unknown[] = [campaign.tenant_id];
  const seg = segmentSql(rules, params, TENANT_TZ_SQL("$1"));
  const { rows } = await db.query(`SELECT c.id, c.email, c.phone FROM ${seg.from} WHERE ${seg.where} AND ${reachable(campaign.channel)}`, params);
  return insertMessages(db, campaign, rows, "");
}

async function insertMessages(
  db: Db,
  campaign: { id: string; tenant_id: string; channel: Channel },
  rows: { id: string; email: string | null; phone: string | null }[],
  period: string,
) {
  let n = 0;
  for (const c of rows) {
    const to = campaign.channel === "email" ? c.email : normalizePhone(c.phone);
    const r = await db.query(
      `INSERT INTO campaign_messages (id, campaign_id, tenant_id, customer_id, period, channel, to_address, token, status, error)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (campaign_id, customer_id, period) DO NOTHING`,
      [campaign.id, campaign.tenant_id, c.id, period, campaign.channel, to ?? (c.phone ?? ""), token(), to ? "queued" : "skipped", to ? null : "Not a mobile number"],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

export interface RunOptions {
  publicUrl?: string | null;
  now?: Date;
}

/**
 * One pass of the marketing worker: starts scheduled campaigns that are due, adds today's
 * birthdays, then sends a batch of queued messages. Everything waits for the sending hours.
 */
export async function runCampaigns(db: Db, senders: Senders, opts: RunOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const local = `($1::timestamptz AT TIME ZONE ${TENANT_TZ_SQL("c.tenant_id")})`;
  const inHours = `EXTRACT(HOUR FROM ${local}) >= ${SEND_FROM_HOUR} AND EXTRACT(HOUR FROM ${local}) < ${SEND_UNTIL_HOUR}`;

  // Scheduled one-off campaigns whose time has come.
  const due = await db.query(
    `UPDATE campaigns c SET status = 'sending', started_at = $1, updated_at = now()
      FROM tenants t WHERE t.id = c.tenant_id AND t.status NOT IN ('suspended', 'cancelled')
        AND c.kind = 'one_off' AND c.status = 'scheduled' AND c.scheduled_at <= $1 AND ${inHours}
      RETURNING c.id, c.tenant_id, c.channel, c.segment_id`,
    [now],
  );
  for (const c of due.rows) await enqueueSegment(db, c);

  // Birthday campaigns: customers whose birthday is today (29 February counts on the 28th in other years).
  const bdays = await db.query(
    `SELECT c.id, c.tenant_id, c.channel, to_char(${local}, 'YYYY') AS year, EXTRACT(MONTH FROM ${local})::int AS m,
            EXTRACT(DAY FROM ${local})::int AS d,
            EXTRACT(DAY FROM (date_trunc('month', ${local}) + interval '1 month - 1 day'))::int AS last_day
       FROM campaigns c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.kind = 'birthday' AND c.status = 'active' AND t.status NOT IN ('suspended', 'cancelled')
        AND EXTRACT(HOUR FROM ${local}) >= ${BIRTHDAY_HOUR} AND EXTRACT(HOUR FROM ${local}) < ${SEND_UNTIL_HOUR}`,
    [now],
  );
  for (const b of bdays.rows) {
    const { rows } = await db.query(
      `SELECT c.id, c.email, c.phone FROM customers c
        WHERE c.tenant_id = $1 AND c.birth_month = $2 AND (c.birth_day = $3 OR ($3 = $4 AND $2 = 2 AND c.birth_day = 29))
          AND ${reachable(b.channel)}`,
      [b.tenant_id, b.m, b.d, b.last_day],
    );
    await insertMessages(db, b, rows, b.year);
  }

  // Send a batch from the queue, oldest first, only for campaigns still running and in hours.
  // One API process runs this worker (like the e-invoice queue); two would send twice.
  const { rows: batch } = await db.query(
    `SELECT m.id, m.to_address AS "to", m.channel, m.token, m.attempts, cu.name, cu.points, c.message, c.subject, c.coupon_code AS coupon, t.name AS shop
       FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id JOIN customers cu ON cu.id = m.customer_id
       JOIN tenants t ON t.id = c.tenant_id
      WHERE m.status = 'queued' AND c.status IN ('sending', 'active') AND ${inHours}
        -- Consent can be taken back while a campaign is queued.
        AND CASE m.channel WHEN 'email' THEN cu.consent_email WHEN 'sms' THEN cu.consent_sms ELSE cu.consent_whatsapp END
      ORDER BY m.created_at LIMIT ${BATCH}`,
    [now],
  );
  let sent = 0;
  const base = opts.publicUrl?.replace(/\/$/, "") ?? null;
  for (const m of batch) {
    const url = base ? `${base}/u/${m.token}` : null;
    const text = withOptOut(m.channel, renderMessage(m.message, m, { coupon: m.coupon, shop: m.shop }), url);
    try {
      const res = await senders[m.channel as Channel].send({ to: m.to, subject: m.subject ? renderMessage(m.subject, m, { coupon: m.coupon, shop: m.shop }) : null, text, unsubscribeUrl: url });
      await db.query("UPDATE campaign_messages SET status = 'sent', sent_at = now(), attempts = attempts + 1, provider_ref = $2, error = NULL WHERE id = $1", [m.id, res.ref ?? null]);
      sent++;
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 300);
      await db.query(
        "UPDATE campaign_messages SET attempts = attempts + 1, error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'queued' END WHERE id = $1",
        [m.id, msg, MAX_ATTEMPTS],
      );
    }
  }
  // Withdrawn consent: those messages are skipped rather than left waiting.
  await db.query(
    `UPDATE campaign_messages m SET status = 'skipped', error = 'Customer withdrew consent'
       FROM customers cu WHERE cu.id = m.customer_id AND m.status = 'queued'
        AND NOT CASE m.channel WHEN 'email' THEN cu.consent_email WHEN 'sms' THEN cu.consent_sms ELSE cu.consent_whatsapp END`,
  );
  // One-off campaigns with nothing left to send are done.
  await db.query(
    `UPDATE campaigns c SET status = 'sent', finished_at = now(), updated_at = now()
      WHERE c.status = 'sending' AND NOT EXISTS (SELECT 1 FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'queued')`,
  );
  return sent;
}

export function startCampaignWorker(db: Db, senders: Senders, log: { error: (obj: unknown, msg?: string) => void }, opts: { publicUrl?: string | null; intervalMs?: number } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runCampaigns(db, senders, { publicUrl: opts.publicUrl });
    } catch (err) {
      log.error(err, "campaign worker failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
