import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PRODUCT_SELECT } from "./catalog.js";
import { adminAudit } from "./common.js";

/** Labels staff asked for on their phones, waiting to be printed (Scales & labels). */
export async function labelRequestRoutes(app: FastifyInstance) {
  app.get("/label-requests", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT lr.id, lr.copies, lr.reason, lr.created_at AS "createdAt", u.name AS "requestedBy", s.name AS "storeName",
              v.product_id AS "productId"
         FROM label_requests lr JOIN variants v ON v.id = lr.variant_id JOIN stores s ON s.id = lr.store_id
         LEFT JOIN users u ON u.id = lr.requested_by
        WHERE lr.tenant_id = $1 AND lr.printed_at IS NULL ORDER BY lr.created_at LIMIT 500`,
      [ctx.tenantId],
    );
    const ids = [...new Set(rows.map((r) => r.productId as string))];
    const products = ids.length ? (await app.db.query(`${PRODUCT_SELECT} WHERE p.id = ANY($1) AND p.tenant_id = $2`, [ids, ctx.tenantId])).rows : [];
    return { requests: rows, products };
  });

  /** Marks requests as printed, so they leave the list. */
  app.post("/label-requests/printed", async (req) => {
    const ctx = await app.authAdmin(req);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body);
    const { rowCount } = await app.db.query(
      "UPDATE label_requests SET printed_at = now() WHERE tenant_id = $1 AND id = ANY($2) AND printed_at IS NULL",
      [ctx.tenantId, ids],
    );
    await adminAudit(app.db, ctx, "label.printed", "label_request", ids[0]!, { count: rowCount });
    return { printed: rowCount };
  });
}
