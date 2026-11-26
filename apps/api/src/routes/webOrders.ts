import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { audit } from "./audit.js";
import { moveWebOrder } from "./admin/onlineStore.js";
import { acceptOrder, readyOrder, rejectOrder } from "../delivery/platform.js";

/**
 * Online orders on the till: the list for this store, marking them ready, and loading one
 * into a sale when the customer comes to collect. The sale itself hands the order over.
 */
export async function webOrderTillRoutes(app: FastifyInstance) {
  app.get("/web-orders", async (req) => {
    const device = await app.authenticate(req);
    const { rows } = await app.db.query(
      `SELECT w.id, w.number, w.status, w.name, w.phone, w.note, w.lines, w.total, w.pickup_code AS "pickupCode", w.customer_id AS "customerId",
              w.created_at AS "createdAt", w.ready_at AS "readyAt", w.channel, w.table_id AS "tableId", d.name AS "tableName", k.name AS "kioskName",
              dc.name AS "platformName", dc.provider, w.external_code AS "externalCode", w.accept_by AS "acceptBy", w.prep_minutes AS "prepMinutes",
              w.accepted_at AS "acceptedAt", w.rider_name AS "riderName", w.rider_at AS "riderAt"
         FROM web_orders w LEFT JOIN dining_tables d ON d.id = w.table_id LEFT JOIN kiosks k ON k.id = w.kiosk_id
         LEFT JOIN delivery_channels dc ON dc.id = w.delivery_channel_id
        WHERE w.tenant_id = $1 AND w.store_id = $2 AND w.status IN ('new', 'accepted', 'ready')
        ORDER BY w.created_at LIMIT 100`,
      [device.tenantId, device.storeId],
    );
    // The store is on a delivery platform: the till shows Busy and Sold out even with no orders.
    const delivery = await app.db.query("SELECT 1 FROM delivery_channels WHERE store_id = $1 AND active LIMIT 1", [device.storeId]);
    return { orders: rows, delivery: !!delivery.rowCount, serverTime: new Date().toISOString() };
  });

  /** A guest's order from the table QR code, added to that table's bill by the till. */
  app.post<{ Params: { id: string } }>("/web-orders/:id/to-tab", async (req) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can do this");
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ userId: z.string().uuid(), tabId: z.string().uuid() }).parse(req.body);
    const user = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND active", [b.userId, device.tenantId]);
    if (!user.rowCount) throw new HttpError(400, "bad_request", "Unknown cashier");
    const tab = await app.db.query("SELECT 1 FROM tabs WHERE id = $1 AND store_id = $2 AND status = 'open'", [b.tabId, device.storeId]);
    if (!tab.rowCount) throw new HttpError(409, "closed", "That bill is closed");
    const { rows } = await app.db.query(
      `UPDATE web_orders SET status = 'collected', collected_at = now(), accepted_at = COALESCE(accepted_at, now()), tab_id = $3
        WHERE id = $1 AND store_id = $2 AND channel = 'table' AND status IN ('new', 'accepted') RETURNING number`,
      [id, device.storeId, b.tabId],
    );
    if (!rows[0]) throw new HttpError(409, "wrong_state", "This order was already taken care of");
    await audit(app.db, device, b.userId, "web_order.to_tab", "web_order", id, { number: rows[0].number, tabId: b.tabId });
    return { status: "collected" };
  });

  for (const step of ["accept", "ready", "cancel"] as const) {
    app.post<{ Params: { id: string } }>(`/web-orders/:id/${step}`, async (req) => {
      const device = await app.authenticate(req);
      const id = z.string().uuid().parse(req.params.id);
      const b = z.object({ userId: z.string().uuid(), reason: z.string().trim().max(200).nullish() }).parse(req.body);
      const user = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND active", [b.userId, device.tenantId]);
      if (!user.rowCount) throw new HttpError(400, "bad_request", "Unknown cashier");
      // A platform's order moves through the platform, which must hear about it.
      const ch = await app.db.query("SELECT channel FROM web_orders WHERE id = $1 AND store_id = $2", [id, device.storeId]);
      if (ch.rows[0]?.channel === "delivery") {
        const who = { tenantId: device.tenantId, storeIds: [device.storeId], userId: b.userId };
        if (step === "accept") return acceptOrder(app.db, who, id);
        if (step === "ready") return readyOrder(app.db, who, id);
        return rejectOrder(app.db, who, id, b.reason || "The store can't take this order");
      }
      return moveWebOrder(
        app,
        app.db,
        { tenantId: device.tenantId, storeIds: [device.storeId], audit: (tx, data) => audit(tx, device, b.userId, `web_order.${step}`, "web_order", id, data) },
        id,
        step,
        step === "cancel" ? b.reason : null,
      );
    });
  }
}
