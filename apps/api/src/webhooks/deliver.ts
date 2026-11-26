import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { API_VERSION } from "./events.js";

/** Waits after each failed try: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, then it gives up (8 tries). */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 21600, 43200, 86400];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
/** An endpoint that has failed for this long with no success is turned off. */
export const DISABLE_AFTER_HOURS = 72;
const TIMEOUT_MS = 10_000;
const KEEP_BODY = 2000;

export interface DeliverOptions {
  /** Lets deliveries reach private and loopback addresses; for development and tests only. */
  allowPrivate?: boolean;
  /** Allows plain http:// URLs; for development and tests only. */
  allowHttp?: boolean;
}

export const deliverOptionsFromEnv = (): DeliverOptions => ({
  allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === "1",
  allowHttp: process.env.WEBHOOK_ALLOW_HTTP === "1",
});

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

/**
 * The POS-Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>`.
 * Receivers recompute it and reject old timestamps to stop replays.
 */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Addresses inside the hosting network (metadata services, databases) are never called. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Checks a URL an owner typed. Returns an error message, or null when it is fine. */
export function checkWebhookUrl(raw: string, opts: DeliverOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a full web address, starting with https://";
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) return "The address must start with https://";
  if (url.username || url.password) return "Put credentials in your receiver, not in the address";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!opts.allowPrivate && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))) {
    return "The address must be reachable on the internet, not a private or local address";
  }
  return null;
}

interface SendResult {
  status: number | null;
  body: string | null;
  error: string | null;
  ms: number;
}

/** POSTs once. Redirects are not followed, and the address is checked after DNS so a name cannot point inside. */
export function postWebhook(url: string, body: string, headers: Record<string, string>, opts: DeliverOptions = {}): Promise<SendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const done = (r: Omit<SendResult, "ms">) => resolve({ ...r, ms: Date.now() - started });
    const bad = checkWebhookUrl(url, opts);
    if (bad) return done({ status: null, body: null, error: bad });
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const lookup = (
      hostname: string,
      options: object,
      cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, []);
        const list = addresses as LookupAddress[];
        if (!opts.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
          const e = new Error("The address points to a private network") as NodeJS.ErrnoException;
          e.code = "EPRIVATE";
          return cb(e, []);
        }
        if ((options as { all?: boolean }).all) return cb(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      });
    };
    const req = lib.request(
      u,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        timeout: TIMEOUT_MS,
        lookup: lookup as never,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < KEEP_BODY) text += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? null, body: text.slice(0, KEEP_BODY), error: null }));
        res.on("error", (e) => done({ status: res.statusCode ?? null, body: text.slice(0, KEEP_BODY), error: e.message }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`No answer within ${TIMEOUT_MS / 1000} seconds`)));
    req.on("error", (e: NodeJS.ErrnoException) =>
      done({ status: null, body: null, error: e.code === "EPRIVATE" ? e.message : e.code ? `${e.code}: ${e.message}` : e.message }),
    );
    req.end(body);
  });
}

interface DueRow {
  id: string;
  attempts: number;
  event_id: string;
  type: string;
  data: unknown;
  event_created_at: Date;
  endpoint_id: string;
  url: string;
  secret: string;
  active: boolean;
  failing_since: Date | null;
}

/** The JSON body a receiver gets. */
export function eventBody(e: { id: string; type: string; createdAt: Date; data: unknown }) {
  return JSON.stringify({ id: e.id, type: e.type, apiVersion: API_VERSION, createdAt: e.createdAt.toISOString(), data: e.data });
}

/** Sends one delivery now and records the try. Returns the delivery's new status. */
async function attempt(db: Db, row: DueRow, opts: DeliverOptions): Promise<"succeeded" | "failed" | "pending"> {
  if (!row.active) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL, error = 'The endpoint is turned off' WHERE id = $1`,
      [row.id],
    );
    return "failed";
  }
  const body = eventBody({ id: row.event_id, type: row.type, createdAt: row.event_created_at, data: row.data });
  const headers = {
    "content-type": "application/json",
    "user-agent": "POS-Webhooks/1.0",
    "pos-event-id": row.event_id,
    "pos-event-type": row.type,
    "pos-delivery-id": row.id,
    "pos-signature": signPayload(row.secret, body),
  };
  const r = await postWebhook(row.url, body, headers, opts);
  const ok = r.status !== null && r.status >= 200 && r.status < 300;
  const attempts = row.attempts + 1;
  const error = ok ? null : (r.error ?? `The receiver answered HTTP ${r.status}`);
  const status = ok ? "succeeded" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  const next = status === "pending" ? RETRY_DELAYS_S[attempts - 1]! : null;
  await db.query(
    `INSERT INTO webhook_attempts (delivery_id, response_status, response_body, error, duration_ms) VALUES ($1, $2, $3, $4, $5)`,
    [row.id, r.status, r.body, error, r.ms],
  );
  await db.query(
    `UPDATE webhook_deliveries SET status = $2, attempts = $3, last_attempt_at = now(), response_status = $4, error = $5,
            next_attempt_at = CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(secs => $6::int) END,
            delivered_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE delivered_at END
      WHERE id = $1`,
    [row.id, status, attempts, r.status, error, next],
  );
  if (ok) {
    await db.query("UPDATE webhook_endpoints SET failing_since = NULL, last_success_at = now() WHERE id = $1", [row.endpoint_id]);
  } else {
    // Keeps failing for days with nothing getting through: turn it off so the owner notices and fixes it.
    const { rows } = await db.query(
      `UPDATE webhook_endpoints SET failing_since = COALESCE(failing_since, now()) WHERE id = $1 RETURNING failing_since`,
      [row.endpoint_id],
    );
    const since = rows[0]?.failing_since as Date | undefined;
    if (since && Date.now() - since.getTime() > DISABLE_AFTER_HOURS * 3_600_000) {
      await db.query(
        `UPDATE webhook_endpoints SET active = false, updated_at = now(),
                disabled_reason = 'Turned off after failing for ' || $2 || ' hours with no successful delivery'
          WHERE id = $1 AND active`,
        [row.endpoint_id, DISABLE_AFTER_HOURS],
      );
    }
  }
  return status;
}

const DUE_SELECT = `
  SELECT d.id, d.attempts, e.id AS event_id, e.type, e.data, e.created_at AS event_created_at,
         w.id AS endpoint_id, w.url, w.secret, w.active, w.failing_since
    FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id`;

/**
 * Sends every delivery that is due, oldest first. Rows are claimed by moving their next try a
 * few minutes ahead, so two API servers never send the same delivery at the same time, and a
 * server that dies mid-send leaves the delivery to be tried again.
 */
export async function deliverDue(db: Db, opts: DeliverOptions = {}, limit = 50): Promise<number> {
  const { rows } = await db.query<DueRow>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '5 minutes' FROM due WHERE d.id = due.id RETURNING d.id
     )
     ${DUE_SELECT} WHERE d.id IN (SELECT id FROM claimed) ORDER BY d.created_at`,
    [limit],
  );
  // Different endpoints in parallel; one endpoint's events in order.
  const byEndpoint = new Map<string, DueRow[]>();
  for (const r of rows) byEndpoint.set(r.endpoint_id, [...(byEndpoint.get(r.endpoint_id) ?? []), r]);
  await Promise.all(
    [...byEndpoint.values()].map(async (list) => {
      for (const r of list) await attempt(db, r, opts);
    }),
  );
  return rows.length;
}

/** Sends one delivery straight away (test events and the owner's "Send again"), whatever its state. */
export async function deliverNow(db: Db, deliveryId: string, opts: DeliverOptions = {}) {
  const { rows } = await db.query<DueRow>(`${DUE_SELECT} WHERE d.id = $1`, [deliveryId]);
  const row = rows[0];
  if (!row) return null;
  // A manual resend starts a fresh round of retries.
  if (row.attempts >= MAX_ATTEMPTS) row.attempts = 0;
  await db.query("UPDATE webhook_deliveries SET status = 'pending', attempts = $2 WHERE id = $1", [deliveryId, row.attempts]);
  return attempt(db, row, opts);
}

/** Removes old rate-limit windows, idempotency answers and delivered events past their keep time. */
export async function housekeeping(db: Db) {
  await db.query("DELETE FROM api_rate_windows WHERE window_start < now() - interval '1 hour'");
  await db.query("DELETE FROM api_idempotency WHERE created_at < now() - interval '24 hours'");
  await db.query(
    `DELETE FROM webhook_events e WHERE e.created_at < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = e.id AND d.status = 'pending')`,
  );
}

/** Runs in the API process: sends due webhooks every few seconds and tidies up hourly. */
export function startWebhookWorker(db: Db, log: FastifyBaseLogger, opts: DeliverOptions = deliverOptionsFromEnv(), everyMs = 3000) {
  let stopped = false;
  let running = false;
  let lastClean = 0;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && (await deliverDue(db, opts)) > 0);
      if (Date.now() - lastClean > 3_600_000) {
        lastClean = Date.now();
        await housekeeping(db);
      }
    } catch (err) {
      log.error({ err }, "webhook worker failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}
