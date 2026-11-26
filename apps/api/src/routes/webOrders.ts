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
              w.created_at AS "createdAt", w.ready_at AS "readyAt"
         FROM web_orders w WHERE w.tenant_id = $1 AND w.store_id = $2 AND w.status IN ('new', 'accepted', 'ready')
        ORDER BY w.created_at LIMIT 100`,
      [device.tenantId, device.storeId],
    );
    return { orders: rows };
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
