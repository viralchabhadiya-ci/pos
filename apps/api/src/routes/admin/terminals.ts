import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, notFound } from "../../errors.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const TerminalSchema = z.object({
  registerId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(40),
  terminalRef: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
});

const ListSchema = z.object({
  status: z.enum(["all", "approved", "problem"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Card payments to look at, for a card_transactions row aliased c. A charge refunded back to
 * the card in full, or marked sorted by a manager, needs nothing more. A card refund that is
 * not on a bill is a problem only when the sale it refunds is on one (the money went back but
 * the return was never rung up).
 */
export const CARD_PROBLEM_SQL = `c.resolved_at IS NULL AND c.created_at < now() - interval '10 minutes' AND (
                    c.status IN ('pending', 'unknown')
                    OR (c.status = 'approved' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.card_transaction_id = c.id) AND (
                      (c.kind = 'sale' AND c.amount > (SELECT COALESCE(SUM(r.amount), 0) FROM card_transactions r
                                                        WHERE r.refund_of = c.id AND r.status = 'approved'))
                      OR (c.kind = 'refund' AND EXISTS (SELECT 1 FROM payments p WHERE p.card_transaction_id = c.refund_of)))))`;

export async function terminalRoutes(app: FastifyInstance) {
  app.get("/terminal-providers", async (req) => {
    await app.authAdmin(req);
    return { providers: [...app.paymentProviders].map(([id, p]) => ({ id, label: p.label })) };
  });

  app.get("/terminals", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT t.id, t.name, t.provider, t.terminal_ref AS "terminalRef", t.active, t.register_id AS "registerId",
              r.name AS "registerName", s.name AS "storeName"
         FROM payment_terminals t JOIN registers r ON r.id = t.register_id JOIN stores s ON s.id = r.store_id
        WHERE t.tenant_id = $1 ORDER BY s.code, r.code, t.created_at`,
      [ctx.tenantId],
    );
    return { terminals: rows };
  });

  async function check(tenantId: string, body: z.infer<typeof TerminalSchema>) {
    if (!app.paymentProviders.has(body.provider)) throw new HttpError(400, "bad_request", "Unknown card provider");
    const reg = await app.db.query(
      "SELECT 1 FROM registers r JOIN stores s ON s.id = r.store_id WHERE r.id = $1 AND s.tenant_id = $2",
      [body.registerId, tenantId],
    );
    if (!reg.rowCount) throw notFound("Register");
  }
  const taken = () => new HttpError(409, "terminal_taken", "That till already has a card terminal. Switch the old one off first.");

  app.post("/terminals", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = TerminalSchema.parse(req.body);
    await check(ctx.tenantId, body);
    const id = randomUUID();
    try {
      await app.db.query(
        `INSERT INTO payment_terminals (id, tenant_id, register_id, name, provider, terminal_ref, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.tenantId, body.registerId, body.name, body.provider, body.terminalRef, body.active],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    }
    await adminAudit(app.db, ctx, "terminal.create", "terminal", id, { name: body.name, provider: body.provider });
    return { id };
  });

  app.put<{ Params: { id: string } }>("/terminals/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = TerminalSchema.parse(req.body);
    await check(ctx.tenantId, body);
    try {
      const res = await app.db.query(
        `UPDATE payment_terminals SET register_id = $3, name = $4, provider = $5, terminal_ref = $6, active = $7, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, ctx.tenantId, body.registerId, body.name, body.provider, body.terminalRef, body.active],
      );
      if (!res.rowCount) throw notFound("Card terminal");
    } catch (err) {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    }
    await adminAudit(app.db, ctx, "terminal.update", "terminal", req.params.id, { name: body.name, active: body.active });
    return { id: req.params.id };
  });

  /**
   * Card payments for reconciliation. "problem" lists the ones to look at: approved but not
   * on any bill (the sale was abandoned after the card was charged), or never answered.
   */
  app.get("/card-transactions", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = ListSchema.parse(req.query);
    const where = ["c.tenant_id = $1"];
    if (f.status === "approved") where.push("c.status = 'approved'");
    if (f.status === "problem") {
      where.push(CARD_PROBLEM_SQL);
    }
    const sql = where.join(" AND ");
    const count = await app.db.query(`SELECT COUNT(*)::int AS n FROM card_transactions c WHERE ${sql}`, [ctx.tenantId]);
    const { rows } = await app.db.query(
      `SELECT c.id, c.kind, c.amount, c.status, c.auth_code AS "authCode", c.card_brand AS "cardBrand", c.card_last4 AS "cardLast4",
              c.message, c.created_at AS "createdAt", t.name AS "terminalName", r.name AS "registerName",
              o.id AS "orderId", o.number AS "orderNumber"
         FROM card_transactions c JOIN payment_terminals t ON t.id = c.terminal_id JOIN registers r ON r.id = c.register_id
         LEFT JOIN payments p ON p.card_transaction_id = c.id LEFT JOIN orders o ON o.id = p.order_id
        WHERE ${sql} ORDER BY c.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      [ctx.tenantId],
    );
    return { transactions: rows, count: count.rows[0].n };
  });
}
