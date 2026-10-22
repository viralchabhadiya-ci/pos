import { CashMoveSchema, SessionCloseSchema, SessionOpenSchema } from "@pos/core";
import type { FastifyInstance } from "fastify";
import type { DeviceContext } from "../app.js";
import { withTx, type Db, type Tx } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { audit } from "./audit.js";

async function getSession(db: Db | Tx, id: string, device: DeviceContext) {
  const { rows } = await db.query("SELECT * FROM sessions WHERE id = $1 AND register_id = $2", [id, device.registerId]);
  if (!rows[0]) throw notFound("Session");
  return rows[0];
}

/** Shift summary: what the drawer should hold and what was sold, by payment kind and tax. */
export async function sessionSummary(db: Db | Tx, sessionId: string) {
  const { rows: s } = await db.query("SELECT * FROM sessions WHERE id = $1", [sessionId]);
  const session = s[0];
  const { rows: byKind } = await db.query(
    `SELECT p.kind, SUM(p.amount)::int AS amount, COUNT(*)::int AS count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.session_id = $1 GROUP BY p.kind ORDER BY p.kind`,
    [sessionId],
  );
  const { rows: totals } = await db.query(
    `SELECT COUNT(*)::int AS order_count,
            COUNT(*) FILTER (WHERE refund_of_order_id IS NOT NULL)::int AS refund_count,
            COALESCE(SUM(total), 0)::int AS total, COALESCE(SUM(tax_total), 0)::int AS tax_total,
            COALESCE(SUM(discount_total), 0)::int AS discount_total,
            COUNT(*) FILTER (WHERE totals_mismatch)::int AS mismatches
       FROM orders WHERE session_id = $1`,
    [sessionId],
  );
  const { rows: moves } = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'in'), 0)::int AS cash_in,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'out'), 0)::int AS cash_out
       FROM cash_moves WHERE session_id = $1`,
    [sessionId],
  );
  const cashSales = byKind.find((k) => k.kind === "cash")?.amount ?? 0;
  const expectedCash = session.opening_cash + cashSales + moves[0].cash_in - moves[0].cash_out;
  return {
    sessionId,
    seq: session.seq,
    state: session.state,
    openedAt: session.opened_at,
    closedAt: session.closed_at,
    openingCash: session.opening_cash,
    cashIn: moves[0].cash_in,
    cashOut: moves[0].cash_out,
    expectedCash,
    closingCashCounted: session.closing_cash_counted,
    difference: session.closing_cash_counted == null ? null : session.closing_cash_counted - expectedCash,
    orderCount: totals[0].order_count,
    refundCount: totals[0].refund_count,
    total: totals[0].total,
    taxTotal: totals[0].tax_total,
    discountTotal: totals[0].discount_total,
    totalsMismatches: totals[0].mismatches,
    payments: byKind,
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  /** Opening is idempotent on the session id, so a till can retry after a timeout. */
  app.post("/sessions/open", async (req) => {
    const device = await app.authenticate(req);
    const body = SessionOpenSchema.parse(req.body);
    if (body.registerId !== device.registerId) throw badRequest("Session belongs to another register");
    return withTx(app.db, async (tx) => {
      const existing = await tx.query("SELECT id FROM sessions WHERE id = $1", [body.id]);
      if (existing.rows[0]) return sessionSummary(tx, body.id);
      const open = await tx.query("SELECT id FROM sessions WHERE register_id = $1 AND state = 'open' FOR UPDATE", [
        device.registerId,
      ]);
      if (open.rows[0]) throw conflict("This register already has an open session");
      await tx.query(
        `INSERT INTO sessions (id, register_id, seq, state, opened_by, opened_at, opening_cash)
         VALUES ($1, $2, $3, 'open', $4, $5, $6)`,
        [body.id, body.registerId, body.seq, body.openedBy, body.openedAt, body.openingCash],
      );
      await audit(tx, device, body.openedBy, "session.open", "session", body.id, { openingCash: body.openingCash });
      return sessionSummary(tx, body.id);
    });
  });

  app.post("/cash-moves", async (req) => {
    const device = await app.authenticate(req);
    const body = CashMoveSchema.parse(req.body);
    await getSession(app.db, body.sessionId, device);
    await withTx(app.db, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO cash_moves (id, session_id, kind, amount, reason, user_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [body.id, body.sessionId, body.kind, body.amount, body.reason, body.userId, body.at],
      );
      if (inserted.rowCount) {
        await audit(tx, device, body.userId, `cash.${body.kind}`, "session", body.sessionId, {
          amount: body.amount,
          reason: body.reason,
        });
      }
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/close", async (req) => {
    const device = await app.authenticate(req);
    const body = SessionCloseSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const session = await getSession(tx, req.params.id, device);
      if (session.state === "closed") return sessionSummary(tx, session.id);
      const summary = await sessionSummary(tx, session.id);
      await tx.query(
        `UPDATE sessions SET state = 'closed', closed_by = $2, closed_at = $3, closing_cash_counted = $4,
                expected_cash = $5, note = $6 WHERE id = $1`,
        [session.id, body.closedBy, body.closedAt, body.closingCashCounted, summary.expectedCash, body.note ?? null],
      );
      await audit(tx, device, body.closedBy, "session.close", "session", session.id, {
        expectedCash: summary.expectedCash,
        counted: body.closingCashCounted,
        difference: body.closingCashCounted - summary.expectedCash,
      });
      return sessionSummary(tx, session.id);
    });
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/summary", async (req) => {
    const device = await app.authenticate(req);
    const session = await getSession(app.db, req.params.id, device);
    return sessionSummary(app.db, session.id);
  });
}
