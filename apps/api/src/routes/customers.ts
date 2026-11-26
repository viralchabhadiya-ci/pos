import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { loadCustomer } from "../public/serialize.js";
import { emitEvent } from "../webhooks/events.js";

const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional(),
  trn: z.string().max(20).optional(),
});

export async function customerRoutes(app: FastifyInstance) {
  /** Search by name or by the end of a phone number (cashiers usually ask for the last digits). */
  app.get<{ Querystring: { q?: string } }>("/customers", async (req) => {
    const device = await app.authenticate(req);
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return { customers: [] };
    const digits = q.replace(/\D/g, "");
    const { rows } = await app.db.query(
      `SELECT id, name, phone, email, trn, price_list_id AS "priceListId", points FROM customers
        WHERE tenant_id = $1 AND (name ILIKE $2 OR ($3 <> '' AND phone LIKE $4))
        ORDER BY name LIMIT 20`,
      [device.tenantId, `%${q}%`, digits, `%${digits}`],
    );
    return { customers: rows };
  });

  /** One customer as they are now (points included), for the till before it spends points. */
  app.get<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const device = await app.authenticate(req);
    const id = z.string().uuid().safeParse(req.params.id);
    const { rows } = id.success
      ? await app.db.query(
          `SELECT id, name, phone, email, trn, price_list_id AS "priceListId", points FROM customers WHERE id = $1 AND tenant_id = $2`,
          [id.data, device.tenantId],
        )
      : { rows: [] };
    if (!rows[0]) throw new HttpError(404, "not_found", "Customer not found");
    return rows[0];
  });

  /** Created on the till (client id), so it is idempotent. */
  app.post("/customers", async (req) => {
    const device = await app.authenticate(req);
    const c = CustomerSchema.parse(req.body);
    await withTx(app.db, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO customers (id, tenant_id, name, phone, email, trn) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, device.tenantId, c.name, c.phone ?? null, c.email ?? null, c.trn ?? null],
      );
      if (inserted.rowCount) await emitEvent(tx, device.tenantId, "customer.created", async () => loadCustomer(tx, device.tenantId, c.id));
    });
    return { id: c.id };
  });
}
