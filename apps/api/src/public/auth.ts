import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminContext } from "../app.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { hashToken } from "../security.js";

/** What a key may do. Read scopes never change anything; write scopes include reading the same data. */
export const SCOPES = {
  "stores:read": "See stores and registers",
  "products:read": "See products, prices and barcodes",
  "products:write": "Add and change products and prices",
  "customers:read": "See customers and their points",
  "customers:write": "Add and change customers",
  "orders:read": "See sales and refunds with their lines and payments",
  "inventory:read": "See stock on hand per store",
  "inventory:write": "Correct stock and write off goods",
  "reports:read": "See daily sales totals",
} as const;
export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];

export const DEFAULT_RATE_LIMIT = 120;

/** Keys look like pos_live_<43 random characters>; only their SHA-256 is stored. */
export function newApiKey() {
  const token = `pos_live_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 13) };
}

export interface ApiContext extends AdminContext {
  apiKey: { id: string; name: string; scopes: Scope[] };
}

const unauthorized = (message: string) => new HttpError(401, "unauthorized", message);

/**
 * Checks the API key and its rate limit, and sets the X-RateLimit headers. The context it
 * returns works with the back office helpers, acting as the owner who made the key, so changes
 * made through the API are checked and audited the same way (the audit entry names the key).
 */
export async function authApi(db: Db, req: FastifyRequest, reply: FastifyReply, scope: Scope | null): Promise<ApiContext> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token) throw unauthorized("Send your API key as: Authorization: Bearer <key>");
  const { rows } = await db.query(
    `UPDATE api_keys k SET last_used_at = now()
       FROM users u, tenants t
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND u.id = k.created_by AND t.id = k.tenant_id
      RETURNING k.id, k.name, k.scopes, k.rate_limit, k.tenant_id, k.created_by, u.name AS user_name, u.active AS user_active, t.status`,
    [hashToken(token)],
  );
  const key = rows[0];
  if (!key) throw unauthorized("This API key is not valid. It may have been revoked or have expired.");
  if (key.status === "suspended" || key.status === "cancelled") {
    throw new HttpError(403, "account_paused", "This business account is paused. Contact support.");
  }
  // A key stops working when the owner who made it leaves.
  if (!key.user_active) throw unauthorized("The person who created this API key no longer has access. Create a new key.");

  const { rows: win } = await db.query(
    `INSERT INTO api_rate_windows (key_id, window_start, count) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (key_id, window_start) DO UPDATE SET count = api_rate_windows.count + 1
     RETURNING count, EXTRACT(EPOCH FROM window_start)::bigint + 60 AS reset`,
    [key.id],
  );
  const used = win[0].count as number;
  const reset = Number(win[0].reset);
  reply.header("x-ratelimit-limit", key.rate_limit);
  reply.header("x-ratelimit-remaining", Math.max(0, key.rate_limit - used));
  reply.header("x-ratelimit-reset", reset);
  if (used > key.rate_limit) {
    reply.header("retry-after", Math.max(1, reset - Math.floor(Date.now() / 1000)));
    throw new HttpError(429, "rate_limited", `Too many requests. This key allows ${key.rate_limit} a minute.`);
  }

  const scopes = key.scopes as Scope[];
  if (scope && !hasScope(scopes, scope)) {
    throw new HttpError(403, "missing_scope", `This API key does not have the ${scope} permission`);
  }
  return {
    userId: key.created_by,
    tenantId: key.tenant_id,
    role: "owner",
    name: `API key "${key.name}"`,
    // An API key works for the whole business.
    storeIds: null,
    apiKey: { id: key.id, name: key.name, scopes },
  };
}

export function hasScope(scopes: Scope[], need: Scope) {
  if (scopes.includes(need)) return true;
  // Write includes read of the same data.
  const [area, kind] = need.split(":");
  return kind === "read" && scopes.includes(`${area}:write` as Scope);
}
