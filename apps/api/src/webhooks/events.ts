import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../db.js";

/** Every event a webhook can subscribe to, with the line shown to the owner when choosing. */
export const EVENT_TYPES = {
  "order.created": "A sale was completed on a till and reached the server",
  "order.refunded": "A refund was completed on a till",
  "customer.created": "A customer was added, on a till, in the back office or through the API",
  "customer.updated": "A customer's details changed",
  "product.created": "A product was added",
  "product.updated": "A product changed, including its price or whether it is on sale",
  "stock.low": "A product's stock in a store fell to or below its reorder level",
  "session.closed": "A till shift was closed, with its cash count",
} as const;

export type EventType = keyof typeof EVENT_TYPES;
export const EVENT_NAMES = Object.keys(EVENT_TYPES) as EventType[];

/** The version of the event and API payload shape. Bumped only for changes that break receivers. */
export const API_VERSION = "2026-11-26";

/**
 * Records an event and queues a delivery to each active endpoint that wants it, in the caller's
 * transaction, so an event is sent exactly when the change it describes is saved. The payload
 * is built only when someone is listening, so businesses without webhooks pay one cheap query.
 */
export async function emitEvent(
  tx: Tx | Db,
  tenantId: string,
  type: EventType | "ping",
  data: unknown | (() => Promise<unknown>),
  onlyEndpointId?: string,
): Promise<string | null> {
  const { rows: endpoints } = await tx.query<{ id: string }>(
    onlyEndpointId
      ? "SELECT id FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2"
      : `SELECT id FROM webhook_endpoints WHERE tenant_id = $1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`,
    onlyEndpointId ? [tenantId, onlyEndpointId] : [tenantId, type],
  );
  if (!endpoints.length) return null;
  const payload = typeof data === "function" ? await (data as () => Promise<unknown>)() : data;
  const eventId = randomUUID();
  await tx.query("INSERT INTO webhook_events (id, tenant_id, type, data) VALUES ($1, $2, $3, $4)", [
    eventId,
    tenantId,
    type,
    JSON.stringify(payload),
  ]);
  for (const ep of endpoints) {
    await tx.query(
      `INSERT INTO webhook_deliveries (id, tenant_id, event_id, endpoint_id, next_attempt_at) VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), tenantId, eventId, ep.id],
    );
  }
  return eventId;
}

/** True when some active endpoint of the business listens for this event. */
export async function hasListeners(db: Tx | Db, tenantId: string, type: EventType): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM webhook_endpoints WHERE tenant_id = $1 AND active AND ($2 = ANY(events) OR '*' = ANY(events)) LIMIT 1`,
    [tenantId, type],
  );
  return !!rowCount;
}

/**
 * After stock left a store, sends stock.low for each product that just went from above its
 * reorder level to at or below it. `moved` is the change this document made, per variant.
 */
export async function emitLowStock(tx: Tx, tenantId: string, storeId: string, moved: Map<string, number>) {
  if (![...moved.values()].some((q) => q < 0)) return;
  if (!(await hasListeners(tx, tenantId, "stock.low"))) return;
  const ids = [...moved.entries()].filter(([, q]) => q < 0).map(([id]) => id);
  const { rows } = await tx.query(
    `SELECT v.id AS "variantId", p.id AS "productId", p.name, v.sku, v.barcode, v.reorder_level AS "reorderLevel",
            (SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = v.id AND m.store_id = $2) AS "onHand"
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1) AND v.tenant_id = $3 AND v.reorder_level IS NOT NULL AND p.active`,
    [ids, storeId, tenantId],
  );
  for (const r of rows) {
    const before = r.onHand - moved.get(r.variantId)!;
    if (r.onHand <= r.reorderLevel && before > r.reorderLevel) {
      await emitEvent(tx, tenantId, "stock.low", { ...r, storeId });
    }
  }
}
