import type { AdminContext } from "./app.js";
import type { Db, Tx } from "./db.js";
import { HttpError, notFound } from "./errors.js";

/**
 * Store scope for back office users. Owners and managers without assigned stores see the
 * whole business (storeIds null). A store manager has a list and only sees those stores.
 */

const forbidden = (message: string) => new HttpError(403, "forbidden", message);

export const allStores = (ctx: Pick<AdminContext, "storeIds">) => ctx.storeIds === null;

export function canSeeStore(ctx: Pick<AdminContext, "storeIds">, storeId: string | null | undefined): boolean {
  return ctx.storeIds === null || (!!storeId && ctx.storeIds.includes(storeId));
}

/** Throws unless the user may work on this store. */
export function assertStore(ctx: Pick<AdminContext, "storeIds">, storeId: string) {
  if (!canSeeStore(ctx, storeId)) throw forbidden("You do not have access to this store");
}

/**
 * The stores a list or report covers, as a uuid[] query parameter: null for every store,
 * otherwise the requested store (checked) or all of the user's own stores.
 */
export function storeParam(ctx: Pick<AdminContext, "storeIds">, requested?: string | null): string[] | null {
  if (requested) {
    assertStore(ctx, requested);
    return [requested];
  }
  return ctx.storeIds;
}

/** For a single record: hide records of other stores as if they did not exist. */
export function assertRecordStore(ctx: Pick<AdminContext, "storeIds">, storeIds: (string | null)[], what: string) {
  if (ctx.storeIds === null) return;
  if (!storeIds.some((id) => id && ctx.storeIds!.includes(id))) throw notFound(what);
}

const HQ_ANY = [/^\/accounting(\/|$)/, /^\/einvoic/, /^\/orders\/[^/]+\/einvoice$/, /^\/audit$/, /^\/reports\/royalties$/, /^\/reports\/daily-summary/, /^\/report-schedules/, /^\/developers/, /^\/api-keys/, /^\/webhooks/];
const HQ_WRITE = [
  /^\/stores(\/|$)/,
  /^\/products$/,
  /^\/products\/import$/,
  /^\/products\/[^/]+$/,
  /^\/products\/[^/]+\/stores$/,
  /^\/categories(\/|$)/,
  /^\/taxes(\/|$)/,
  /^\/price-lists(\/|$)/,
  /^\/promotions(\/|$)/,
  /^\/loyalty$/,
  /^\/scales$/,
  /^\/report-settings$/,
  /^\/terminals(\/|$)/,
  /^\/gift-cards\/[^/]+(\/|$)/,
  // Marketing reaches customers of every store.
  /^\/segments(\/|$)/,
  /^\/campaigns(\/|$)/,
];

/**
 * The central catalog, prices, offers, accounting and business settings belong to HQ. A
 * store manager can read the catalog but not change it.
 */
export function isHqOnly(method: string, url: string): boolean {
  const path = url.replace(/^\/admin/, "").split("?")[0] ?? "";
  if (HQ_ANY.some((r) => r.test(path))) return true;
  return method !== "GET" && method !== "HEAD" && HQ_WRITE.some((r) => r.test(path));
}

/** The stores a user is limited to, or null when they work at every store. */
export async function userStoreIds(db: Db | Tx, userId: string): Promise<string[] | null> {
  const { rows } = await db.query<{ store_id: string }>("SELECT store_id FROM user_stores WHERE user_id = $1 ORDER BY store_id", [userId]);
  return rows.length ? rows.map((r) => r.store_id) : null;
}
