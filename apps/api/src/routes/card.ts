import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceContext } from "../app.js";
import { HttpError } from "../errors.js";
import { ProviderUnreachable, type PaymentProvider, type ProviderResult, type TerminalRequest } from "../payments/index.js";
import { audit } from "./audit.js";
import { withTx } from "../db.js";

const StartSchema = z.object({
  /** Made on the till before the request is sent, so a retry is the same payment. */
  id: z.string().uuid(),
  kind: z.enum(["sale", "refund"]).default("sale"),
  amount: z.number().int().positive().max(100_000_000),
  orderId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  /** For a refund to the card: the card payment being refunded. */
  refundOf: z.string().uuid().optional(),
});

const FINAL = new Set(["approved", "declined", "cancelled", "failed"]);

/** What the till sees about a card payment. */
function view(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    amount: row.amount,
    status: row.status,
    authCode: row.auth_code ?? null,
    cardBrand: row.card_brand ?? null,
    cardLast4: row.card_last4 ?? null,
    message: row.message ?? null,
    terminalName: row.terminal_name ?? null,
  };
}

export async function cardRoutes(app: FastifyInstance) {
  async function terminalFor(device: DeviceContext) {
    const { rows } = await app.db.query(
      "SELECT id, name, provider, terminal_ref FROM payment_terminals WHERE register_id = $1 AND tenant_id = $2 AND active",
      [device.registerId, device.tenantId],
    );
    return rows[0] as { id: string; name: string; provider: string; terminal_ref: string } | undefined;
  }

  function providerOf(name: string): PaymentProvider {
    const p = app.paymentProviders.get(name);
    if (!p) throw new HttpError(503, "provider_unavailable", `Card provider "${name}" is not set up on this server`);
    return p;
  }

  async function load(id: string, device: DeviceContext) {
    const { rows } = await app.db.query(
      `SELECT c.*, t.name AS terminal_name, t.provider, t.terminal_ref, o.provider_ref AS original_ref
         FROM card_transactions c JOIN payment_terminals t ON t.id = c.terminal_id
         LEFT JOIN card_transactions o ON o.id = c.refund_of
        WHERE c.id = $1 AND c.tenant_id = $2 AND c.register_id = $3`,
      [id, device.tenantId, device.registerId],
    );
    if (!rows[0]) throw new HttpError(404, "not_found", "Card payment not found");
    return rows[0];
  }

  const request = (row: Record<string, unknown>): TerminalRequest => ({
    id: row.id as string,
    kind: row.kind as "sale" | "refund",
    amount: row.amount as number,
    currency: row.currency as string,
    terminalRef: row.terminal_ref as string,
    originalRef: (row.original_ref as string | null) ?? null,
  });

  /**
   * Stores what the provider said. A final answer is never overwritten, so a late or
   * repeated status call cannot turn an approved payment back into something else.
   */
  async function save(id: string, result: ProviderResult | { status: "unknown"; message: string }) {
    const r = result as ProviderResult;
    const { rows } = await app.db.query(
      `UPDATE card_transactions SET status = $2, provider_ref = COALESCE($3, provider_ref), auth_code = COALESCE($4, auth_code),
              card_brand = COALESCE($5, card_brand), card_last4 = COALESCE($6, card_last4), message = $7, updated_at = now()
        WHERE id = $1 AND status NOT IN ('approved', 'declined', 'cancelled', 'failed')
        RETURNING *`,
      [id, r.status, r.providerRef ?? null, r.authCode ?? null, r.cardBrand ?? null, r.cardLast4 ?? null, r.message ?? null],
    );
    return rows[0];
  }

  async function ask(row: Record<string, unknown>, how: "start" | "status" | "cancel") {
    const provider = providerOf(row.provider as string);
    try {
      const req = request(row);
      const result =
        how === "start"
          ? await provider.start(req)
          : how === "status"
            ? await provider.status(req, (row.provider_ref as string) ?? null)
            : await provider.cancel(req, (row.provider_ref as string) ?? null);
      return await save(row.id as string, result);
    } catch (err) {
      if (!(err instanceof ProviderUnreachable)) throw err;
      // The request may or may not have reached the terminal: the till must check again, never retry blind.
      return await save(row.id as string, { status: "unknown", message: err.message });
    }
  }

  async function current(id: string, device: DeviceContext) {
    const row = await load(id, device);
    return view({ ...row, ...(await app.db.query("SELECT * FROM card_transactions WHERE id = $1", [id])).rows[0] });
  }

  /** How long a start call may still be on its way to the terminal before a status check is worth asking. */
  const START_GRACE_MS = 60_000;

  /**
   * Refreshes a payment that is not final. While the first request is still starting the
   * terminal (nothing saved since the row was made), the provider is not asked yet: it may
   * not know the payment, and the answer would be wrong.
   */
  async function recheck(id: string, device: DeviceContext) {
    const row = await load(id, device);
    const starting =
      (row.updated_at as Date).getTime() === (row.created_at as Date).getTime() &&
      Date.now() - (row.created_at as Date).getTime() < START_GRACE_MS;
    if (!FINAL.has(row.status) && !starting) await ask(row, "status");
    return current(id, device);
  }

  /** Whether this register has a terminal, so the till can offer integrated card. */
  app.get("/card/terminal", async (req) => {
    const device = await app.authenticate(req);
    const t = await terminalFor(device);
    return { terminal: t ? { id: t.id, name: t.name, provider: t.provider } : null };
  });

  app.post("/card/payments", async (req) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can take payments");
    const body = StartSchema.parse(req.body);

    // The same id again (a retry after a lost answer) is a status check, never a new charge.
    const existing = await app.db.query("SELECT 1 FROM card_transactions WHERE id = $1", [body.id]);
    if (existing.rowCount) return recheck(body.id, device);

    const terminal = await terminalFor(device);
    if (!terminal) throw new HttpError(409, "no_terminal", "This till has no card terminal set up. Use manual card instead.");
    if (body.kind === "refund") {
      if (!body.refundOf) throw new HttpError(400, "bad_request", "A card refund needs the original card payment");
      const orig = await app.db.query(
        `SELECT amount, COALESCE((SELECT SUM(r.amount) FROM card_transactions r
                                   WHERE r.refund_of = c.id AND r.status IN ('approved', 'pending', 'unknown')), 0) AS refunded
           FROM card_transactions c WHERE c.id = $1 AND c.tenant_id = $2 AND c.kind = 'sale' AND c.status = 'approved'`,
        [body.refundOf, device.tenantId],
      );
      if (!orig.rows[0]) throw new HttpError(422, "unknown_original", "The original card payment was not found or was not approved");
      if (body.amount > orig.rows[0].amount - Number(orig.rows[0].refunded)) {
        throw new HttpError(422, "over_refund", "That is more than is left to refund on this card payment");
      }
    }

    const inserted = await withTx(app.db, async (tx) => {
      const ins = await tx.query(
        `INSERT INTO card_transactions (id, tenant_id, register_id, terminal_id, kind, amount, order_id, refund_of, status, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) ON CONFLICT (id) DO NOTHING`,
        [body.id, device.tenantId, device.registerId, terminal.id, body.kind, body.amount, body.orderId, body.refundOf ?? null,
          body.userId ?? null],
      );
      if (ins.rowCount) {
        await audit(tx, device, body.userId ?? null, `card.${body.kind}_start`, "card_transaction", body.id, { amount: body.amount });
      }
      return ins.rowCount === 1;
    });
    // Two requests with the same id can race here; only the one that created the row starts the terminal.
    if (!inserted) return recheck(body.id, device);
    await ask(await load(body.id, device), "start");
    return current(body.id, device);
  });

  /** The till polls this while the customer pays, and again after a timeout or a restart. */
  app.get<{ Params: { id: string } }>("/card/payments/:id", async (req) => {
    const device = await app.authenticate(req);
    return recheck(req.params.id, device);
  });

  /**
   * A manager confirms that a charge which never reached a bill was dealt with another way
   * (e.g. the sale was rung up again by hand), so reconciliation stops flagging it.
   */
  app.post<{ Params: { id: string } }>("/card/payments/:id/resolve", async (req) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can do this");
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const row = await load(req.params.id, device);
    const mgr = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND role IN ('owner', 'manager') AND active",
      [userId, device.tenantId]);
    if (!mgr.rowCount) throw new HttpError(403, "forbidden", "Only a manager can mark a card payment as sorted");
    await withTx(app.db, async (tx) => {
      await tx.query("UPDATE card_transactions SET resolved_at = COALESCE(resolved_at, now()), resolved_by = COALESCE(resolved_by, $2) WHERE id = $1",
        [row.id, userId]);
      await audit(tx, device, userId, "card.resolved", "card_transaction", row.id, { amount: row.amount });
    });
    return current(req.params.id, device);
  });

  /** Stops a payment still waiting on the terminal. If it went through, the answer says approved. */
  app.post<{ Params: { id: string } }>("/card/payments/:id/cancel", async (req) => {
    const device = await app.authenticate(req);
    const row = await load(req.params.id, device);
    if (!FINAL.has(row.status)) {
      await ask(row, "cancel");
      await audit(app.db, device, null, "card.cancel", "card_transaction", row.id, { amount: row.amount });
    }
    return current(req.params.id, device);
  });
}
