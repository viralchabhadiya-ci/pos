import type { FastifyInstance } from "fastify";
import { z } from "zod";

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
      `SELECT id, name, phone, email, trn FROM customers
        WHERE tenant_id = $1 AND (name ILIKE $2 OR ($3 <> '' AND phone LIKE $4))
        ORDER BY name LIMIT 20`,
      [device.tenantId, `%${q}%`, digits, `%${digits}`],
    );
    return { customers: rows };
  });

  /** Created on the till (client id), so it is idempotent. */
  app.post("/customers", async (req) => {
    const device = await app.authenticate(req);
    const c = CustomerSchema.parse(req.body);
    await app.db.query(
      `INSERT INTO customers (id, tenant_id, name, phone, email, trn) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, device.tenantId, c.name, c.phone ?? null, c.email ?? null, c.trn ?? null],
    );
    return { id: c.id };
  });
}
