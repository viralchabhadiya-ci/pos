import { GiftCardCodeSchema } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { cannotSpend, lockGiftCard, moveGiftCard } from "../loyalty.js";
import { audit } from "./audit.js";

const RedeemSchema = z.object({
  /** The till's payment id; the same id again returns the first answer. */
  paymentId: z.string().uuid(),
  code: GiftCardCodeSchema,
  amount: z.number().int().positive().max(100_000_000),
  userId: z.string().uuid(),
});

const parseCode = (raw: string) => {
  const code = GiftCardCodeSchema.safeParse(raw);
  if (!code.success) throw new HttpError(400, "bad_code", code.error.issues[0]!.message);
  return code.data;
};

/**
 * Gift cards at the till. Spending needs the internet: the amount is taken from the card the
 * moment the cashier adds the payment, so two tills can never spend the same money. The sale
 * links to it when it syncs; if the sale does not go ahead, the till gives it back.
 */
export async function giftCardRoutes(app: FastifyInstance) {
  app.get<{ Params: { code: string } }>("/gift-cards/:code", async (req) => {
    const device = await app.authenticate(req);
    const code = parseCode(req.params.code);
    const { rows } = await app.db.query(
      `SELECT code, status, balance, expires_at AS "expiresAt" FROM gift_cards WHERE tenant_id = $1 AND code = $2`,
      [device.tenantId, code],
    );
    if (!rows[0]) throw new HttpError(404, "gift_card_not_found", "No gift card with that number");
    return rows[0];
  });

  app.post("/gift-cards/redeem", async (req) => {
    const device = await app.authenticate(req);
    const body = RedeemSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const user = await tx.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2", [body.userId, device.tenantId]);
      if (!user.rowCount) throw new HttpError(400, "unknown_user", "Unknown cashier");
      const card = await lockGiftCard(tx, device.tenantId, body.code);
      const done = await tx.query(
        "SELECT amount, gift_card_id FROM gift_card_moves WHERE payment_id = $1 AND kind = 'redeem' AND tenant_id = $2",
        [body.paymentId, device.tenantId],
      );
      if (done.rows[0]) {
        if (done.rows[0].gift_card_id !== card?.id || -done.rows[0].amount !== body.amount) {
          throw new HttpError(409, "payment_reused", "This payment id was already used for another gift card spend");
        }
        return { paymentId: body.paymentId, code: card!.code, amount: body.amount, balance: card!.balance };
      }
      const problem = cannotSpend(card);
      if (problem) throw problem;
      if (card!.balance < body.amount) {
        throw new HttpError(409, "gift_card_balance", `Only AED ${(card!.balance / 100).toFixed(2)} is left on this gift card`);
      }
      const balance = await moveGiftCard(tx, {
        tenantId: device.tenantId,
        cardId: card!.id,
        amount: -body.amount,
        kind: "redeem",
        paymentId: body.paymentId,
        storeId: device.storeId,
        userId: body.userId,
      });
      return { paymentId: body.paymentId, code: card!.code, amount: body.amount, balance };
    });
  });

  /** Gives a spend back when the cashier removes the payment or the sale is abandoned. */
  app.post<{ Params: { paymentId: string } }>("/gift-cards/redeem/:paymentId/void", async (req) => {
    const device = await app.authenticate(req);
    const paymentId = z.string().uuid().parse(req.params.paymentId);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    return withTx(app.db, async (tx) => {
      const find = () =>
        tx.query("SELECT gift_card_id, amount, order_id FROM gift_card_moves WHERE payment_id = $1 AND kind = 'redeem' AND tenant_id = $2", [
          paymentId,
          device.tenantId,
        ]);
      const first = (await find()).rows[0];
      // Nothing was taken (the spend never reached the server): nothing to give back.
      if (!first) return { paymentId, voided: false };
      // Lock the card, then read again: a sale syncing at the same moment locks it first too.
      await tx.query("SELECT 1 FROM gift_cards WHERE id = $1 FOR UPDATE", [first.gift_card_id]);
      const m = (await find()).rows[0];
      if (m.order_id) throw new HttpError(409, "gift_card_used", "This gift card payment is on a completed sale; refund the sale instead");
      const again = await tx.query("SELECT 1 FROM gift_card_moves WHERE payment_id = $1 AND kind = 'redeem_void'", [paymentId]);
      if (again.rowCount) return { paymentId, voided: true };
      const balance = await moveGiftCard(tx, {
        tenantId: device.tenantId,
        cardId: m.gift_card_id,
        amount: -m.amount,
        kind: "redeem_void",
        paymentId,
        storeId: device.storeId,
        userId,
      });
      await audit(tx, device, userId, "gift_card.redeem_void", "gift_card", m.gift_card_id, { amount: -m.amount });
      return { paymentId, voided: true, balance };
    });
  });
}
