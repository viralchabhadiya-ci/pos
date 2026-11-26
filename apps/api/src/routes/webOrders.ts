import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { audit } from "./audit.js";
import { moveWebOrder } from "./admin/onlineStore.js";

/**
 * Online orders on the till: the list for this store, marking them ready, and loading one
 * into a sale when the customer comes to collect. The sale itself hands the order over.
 */
export async function webOrderTillRoutes(app: FastifyInstance) {
  app.get("/web-orders", async (req) => {
    const device = await app.authenticate(req);
    const { rows } = await app.db.query(
      `SELECT w.id, w.number, w.status, w.name, w.phone, w.note, w.lines, w.total, w.pickup_code AS "pickupCode", w.customer_id AS "customerId",
              w.created_at AS "createdAt", w.ready_at AS "readyAt", w.channel, w.table_id AS "tableId", d.name AS "tableName", k.name AS "kioskName"
         FROM web_orders w LEFT JOIN dining_tables d ON d.id = w.table_id LEFT JOIN kiosks k ON k.id = w.kiosk_id
        WHERE w.tenant_id = $1 AND w.store_id = $2 AND w.status IN ('new', 'accepted', 'ready')
        ORDER BY w.created_at LIMIT 100`,
      [device.tenantId, device.storeId],
    );
    return { orders: rows };
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
