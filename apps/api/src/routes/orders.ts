import { checkPayments, OrderBatchSchema, pointsEarned, pointsEligible, priceOrder, type OrderSync, type PricedLine, type TaxRate } from "@pos/core";
import type { FastifyInstance } from "fastify";
import type { DeviceContext } from "../app.js";
import { withTx, type Tx } from "../db.js";
import { HttpError } from "../errors.js";
import { lockGiftCard, lockOrCreateGiftCard, loyaltySettings, moveGiftCard, movePoints } from "../loyalty.js";
import { loadOrder } from "../public/serialize.js";
import { emitEvent, emitLowStock } from "../webhooks/events.js";
import { audit } from "./audit.js";

type Result =
  | { id: string; status: "created"; totalsMismatch: boolean }
  | { id: string; status: "duplicate" }
  | { id: string; status: "rejected"; error: string; message: string };

const reject = (code: string, message: string) => new HttpError(422, code, message);

/**
 * Stores one order sent by a till. The server recomputes every total with the shared
 * pricing engine and stores its own numbers. A mismatch with the till's totals is
 * accepted (the customer has already paid) but flagged for review.
 */
async function storeOrder(tx: Tx, device: DeviceContext, order: OrderSync): Promise<Result> {
  const existing = await tx.query("SELECT id FROM orders WHERE id = $1", [order.id]);
  if (existing.rows[0]) return { id: order.id, status: "duplicate" };

  if (order.registerId !== device.registerId) throw reject("wrong_register", "Order belongs to another register");
  const session = await tx.query("SELECT id FROM sessions WHERE id = $1 AND register_id = $2", [
    order.sessionId,
    device.registerId,
  ]);
  if (!session.rows[0]) throw reject("unknown_session", "Session not found for this register");

  const store = (await tx.query("SELECT cash_rounding_step FROM stores WHERE id = $1", [device.storeId])).rows[0];

  for (const l of order.lines) {
    if ((l.variantId === null) === !l.giftCardCode) throw reject("bad_line", "A line sells either a product or a gift card");
    if (l.giftCardCode && (l.taxId || l.discountBp || l.promoDiscount || l.promotionId || l.unitPrice <= 0)) {
      throw reject("bad_gift_card_line", "A gift card line has no VAT and no discount");
    }
  }
  const variantIds = [...new Set(order.lines.map((l) => l.variantId).filter((v): v is string => !!v))];
  const variants = await tx.query("SELECT id FROM variants WHERE tenant_id = $1 AND id = ANY($2)", [
    device.tenantId,
    variantIds,
  ]);
  if (variants.rowCount !== variantIds.length) throw reject("unknown_variant", "Order has an unknown product");

  const taxIds = [...new Set(order.lines.map((l) => l.taxId).filter((t): t is string => !!t))];
  const taxRows = (
    await tx.query(
      `SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded"
         FROM taxes WHERE tenant_id = $1 AND id = ANY($2)`,
      [device.tenantId, taxIds],
    )
  ).rows as TaxRate[];
  if (taxRows.length !== taxIds.length) throw reject("unknown_tax", "Order has an unknown tax");
  const taxes = Object.fromEntries(taxRows.map((t) => [t.id, t]));

  const methodIds = [...new Set(order.payments.map((p) => p.methodId))];
  const methods = await tx.query("SELECT id, kind FROM payment_methods WHERE tenant_id = $1 AND id = ANY($2)", [
    device.tenantId,
    methodIds,
  ]);
  const methodKind = new Map(methods.rows.map((m) => [m.id as string, m.kind as string]));
  for (const p of order.payments) {
    if (methodKind.get(p.methodId) !== p.kind) throw reject("bad_payment_method", "Unknown payment method");
    if (p.kind === "gift_card" && !p.giftCardCode) throw reject("bad_payment", "A gift card payment needs the card number");
    if (p.kind === "points" && !p.points) throw reject("bad_payment", "A points payment needs the number of points");
  }
  if (order.payments.some((p) => p.kind === "delivery") && !order.webOrderId && !order.refundOfOrderId) {
    throw reject("bad_payment", "Only a delivery platform's order is paid by the platform");
  }

  const promoIds = [
    ...new Set([...order.lines.map((l) => l.promotionId), ...order.promotions.map((p) => p.promotionId)].filter((id): id is string => !!id)),
  ];
  if (promoIds.length) {
    const known = await tx.query("SELECT id FROM promotions WHERE tenant_id = $1 AND id = ANY($2)", [device.tenantId, promoIds]);
    if (known.rowCount !== promoIds.length) throw reject("unknown_promotion", "Order has an unknown promotion");
  }

  const isRefund = order.refundOfOrderId !== null;
  // A refund belongs to the customer on the original sale: their points are what it changes.
  let customerId = order.customerId;
  if (isRefund) customerId = (await checkRefund(tx, device, order)) ?? customerId;
  else if (order.lines.some((l) => l.qty < 0)) throw reject("negative_qty", "Sales cannot have negative quantities");
  else if (order.lines.some((l) => l.promoDiscount < 0)) throw reject("bad_promotion", "A promotion cannot add to the price");
  if (order.lines.some((l) => l.giftCardCode && (isRefund || l.qty !== 1))) {
    throw reject("gift_card_line", "A gift card is sold one at a time, and what is on it cannot be refunded as a product");
  }
  if (customerId) {
    const c = await tx.query("SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2", [customerId, device.tenantId]);
    if (!c.rowCount) throw reject("unknown_customer", "Customer not found (it may not have synced yet)");
  }
  if (order.payments.some((p) => p.kind === "points") && !customerId) {
    throw reject("points_without_customer", "Points can only be used with a customer on the bill");
  }

  const totals = priceOrder(order.lines, { taxes, orderDiscountBp: order.orderDiscountBp });
  const pay = checkPayments(totals.total, order.payments, store.cash_rounding_step);
  if (!pay.complete) throw reject("unpaid", `Payments do not cover the total (remaining ${pay.remaining})`);
  const mismatch =
    totals.total !== order.clientTotals.total ||
    totals.taxTotal !== order.clientTotals.taxTotal ||
    totals.subtotalNet !== order.clientTotals.subtotalNet;

  await tx.query(
    `INSERT INTO orders (id, tenant_id, store_id, register_id, session_id, number, cashier_id, customer_id,
       refund_of_order_id, order_discount_bp, amount_total, discount_total, subtotal_net, tax_total, total,
       cash_rounding, client_total, totals_mismatch, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      order.id, device.tenantId, device.storeId, device.registerId, order.sessionId, order.number,
      order.cashierId, customerId, order.refundOfOrderId, order.orderDiscountBp, totals.amountTotal,
      totals.discountTotal, totals.subtotalNet, totals.taxTotal, totals.total, pay.cashRounding,
      order.clientTotals.total, mismatch, order.createdAt,
    ],
  );

  for (const [i, l] of totals.lines.entries()) {
    const src = order.lines[i]!;
    await tx.query(
      `INSERT INTO order_lines (id, order_id, line_no, variant_id, name, qty, unit_price, discount_bp,
         line_discount, order_discount, tax_id, tax_rate_bp, net, tax, gross, note, promo_discount, promotion_id, gift_card_code, modifiers, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               (SELECT cost FROM variants WHERE id = $4))`,
      [
        l.id, order.id, i + 1, l.variantId, l.name, l.qty, l.unitPrice, l.discountBp ?? 0, l.lineDiscount,
        l.orderDiscount, l.taxId, l.taxId ? taxes[l.taxId]!.rateBp : null, l.net, l.tax, l.gross, src.note ?? null,
        l.promoDiscount, l.promotionId ?? null, src.giftCardCode ?? null, src.modifiers?.length ? JSON.stringify(src.modifiers) : null,
      ],
    );
    if (src.giftCardCode) {
      await loadGiftCard(tx, device, order, customerId, src.giftCardCode, l.gross);
      continue;
    }
    await tx.query(
      `INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason, ref_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [device.tenantId, device.storeId, l.variantId, -l.qty, isRefund ? "refund" : "sale", order.id, order.createdAt],
    );
  }

  for (const p of order.payments) {
    const change = Math.max(0, (p.tendered ?? p.amount) - p.amount);
    const cardTx = p.cardTransactionId ? await linkCardPayment(tx, device, order, p) : null;
    const giftCard = p.kind === "gift_card" ? await giftCardPayment(tx, device, order, customerId, p) : null;
    await tx.query(
      `INSERT INTO payments (id, order_id, method_id, kind, amount, tendered, change, reference, card_transaction_id,
         gift_card_id, points)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        p.id, order.id, p.methodId, p.kind, p.amount, p.tendered ?? null, change, p.reference ?? null, cardTx,
        giftCard, p.kind === "points" ? p.points : null,
      ],
    );
  }

  if (customerId) await bookPoints(tx, device, order, customerId, totals.lines);

  if (mismatch) {
    await audit(tx, device, order.cashierId, "order.totals_mismatch", "order", order.id, {
      client: order.clientTotals,
      server: { subtotalNet: totals.subtotalNet, taxTotal: totals.taxTotal, total: totals.total },
    });
  }
  // Discounts the cashier gave by hand; promotions are the owner's own and are logged below.
  const manualDiscount = totals.lines.reduce((s, l) => s + l.lineDiscount + l.orderDiscount, 0);
  if (manualDiscount > 0) {
    await audit(tx, device, order.cashierId, "order.discount", "order", order.id, { discount: manualDiscount });
  }
  if (!isRefund) await recordPromotions(tx, device, order, totals.lines.reduce((s, l) => s + l.promoDiscount, 0));

  if (order.webOrderId && !isRefund) await handOverWebOrder(tx, device, order.id, order.webOrderId, order.cashierId);
  if (order.tabId && !isRefund) await closeTabForOrder(tx, device, order.id, order.tabId, order.cashierId);

  // Webhooks go out once the order is saved; the payload is the same one GET /v1/orders/:id returns.
  await emitEvent(tx, device.tenantId, isRefund ? "order.refunded" : "order.created", async () => loadOrder(tx, device.tenantId, order.id));
  if (!isRefund) {
    const moved = new Map<string, number>();
    for (const l of order.lines) if (l.variantId) moved.set(l.variantId, (moved.get(l.variantId) ?? 0) - l.qty);
    await emitLowStock(tx, device.tenantId, device.storeId, moved);
  }
  return { id: order.id, status: "created", totalsMismatch: mismatch };
}

/**
 * Counts each promotion used on a sale, for the owner's redemption figures and coupon use
 * limits. The till may have priced with a promotion that has since ended (it was offline);
 * the customer has paid, so that is accepted. Line discounts that do not add up to the
 * promotions listed are written to the audit log.
 */
async function recordPromotions(tx: Tx, device: DeviceContext, order: OrderSync, lineTotal: number) {
  const listed = order.promotions.reduce((s, p) => s + p.amount, 0);
  if (listed !== lineTotal) {
    await audit(tx, device, order.cashierId, "order.promo_mismatch", "order", order.id, { lines: lineTotal, promotions: listed });
  }
  for (const p of order.promotions) {
    if (p.amount <= 0) continue;
    await tx.query(
      `INSERT INTO order_promotions (order_id, promotion_id, tenant_id, code, amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [order.id, p.promotionId, device.tenantId, p.code ? p.code.trim().toUpperCase() : null, p.amount, order.createdAt],
    );
    // Once a coupon reaches its limit its change time moves, so tills drop it on their next sync.
    await tx.query(
      `UPDATE promotions SET uses = uses + 1,
              updated_at = CASE WHEN max_uses IS NOT NULL AND uses + 1 >= max_uses THEN now() ELSE updated_at END
        WHERE id = $1`,
      [p.promotionId],
    );
  }
}

/**
 * Ties a terminal payment to the order. The customer has already paid, so a problem never
 * rejects the order; it is written to the audit log for the owner to look at.
 */
async function linkCardPayment(tx: Tx, device: DeviceContext, order: OrderSync, p: OrderSync["payments"][number]) {
  const { rows } = await tx.query(
    "SELECT id, kind, amount, status, order_id FROM card_transactions WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [p.cardTransactionId, device.tenantId],
  );
  const c = rows[0];
  if (!c) {
    await audit(tx, device, order.cashierId, "order.card_mismatch", "order", order.id, { reason: "unknown card payment", amount: p.amount });
    return null;
  }
  const expected = c.kind === "refund" ? -c.amount : c.amount;
  if (c.status !== "approved" || expected !== p.amount || (c.order_id && c.order_id !== order.id)) {
    await audit(tx, device, order.cashierId, "order.card_mismatch", "order", order.id, {
      cardTransactionId: c.id,
      status: c.status,
      cardAmount: expected,
      paid: p.amount,
    });
  }
  await tx.query("UPDATE card_transactions SET order_id = $2, updated_at = now() WHERE id = $1", [c.id, order.id]);
  return c.id as string;
}

/**
 * Loads a gift card sold on this bill: a new number becomes a new card, a number that exists is
 * topped up. The customer has paid either way, so a switched-off card is still loaded and the
 * owner is told.
 */
async function loadGiftCard(tx: Tx, device: DeviceContext, order: OrderSync, customerId: string | null, code: string, amount: number) {
  const existing = await lockGiftCard(tx, device.tenantId, code);
  const card = existing ?? (await lockOrCreateGiftCard(tx, device.tenantId, code, customerId));
  await moveGiftCard(tx, {
    tenantId: device.tenantId,
    cardId: card.id,
    amount,
    kind: existing ? "topup" : "sale",
    orderId: order.id,
    storeId: device.storeId,
    userId: order.cashierId,
  });
  if (existing && existing.status !== "active") {
    await audit(tx, device, order.cashierId, "gift_card.topup_disabled", "gift_card", card.id, { order: order.number, amount });
  }
}

/**
 * Ties a gift card payment to the bill. A spend is normally taken when the cashier adds the
 * payment (POST /gift-cards/redeem); this links it. If it was not (or was given back since),
 * the card is charged now, even below zero, because the customer has already left with the
 * goods; the owner sees it in the audit log. A refund onto a gift card loads it, making a new
 * card when the number is new: that is how store credit is given.
 */
async function giftCardPayment(tx: Tx, device: DeviceContext, order: OrderSync, customerId: string | null, p: OrderSync["payments"][number]) {
  const code = p.giftCardCode!;
  const base = { tenantId: device.tenantId, orderId: order.id, storeId: device.storeId, userId: order.cashierId };
  if (p.amount < 0) {
    const card = await lockOrCreateGiftCard(tx, device.tenantId, code, customerId);
    await moveGiftCard(tx, { ...base, cardId: card.id, amount: -p.amount, kind: "refund", paymentId: p.id });
    return card.id;
  }
  // Lock the card before reading its moves, so a give-back running at the same time is seen.
  const card = await lockGiftCard(tx, device.tenantId, code);
  const spent = await tx.query(
    `SELECT m.id, m.gift_card_id, m.amount, m.order_id,
            EXISTS (SELECT 1 FROM gift_card_moves v WHERE v.payment_id = m.payment_id AND v.kind = 'redeem_void') AS voided
       FROM gift_card_moves m WHERE m.payment_id = $1 AND m.kind = 'redeem' AND m.tenant_id = $2`,
    [p.id, device.tenantId],
  );
  const move = spent.rows[0];
  if (move && !move.voided) {
    await tx.query("UPDATE gift_card_moves SET order_id = $2 WHERE id = $1", [move.id, order.id]);
    if (-move.amount !== p.amount || move.gift_card_id !== card?.id) {
      await audit(tx, device, order.cashierId, "order.gift_card_mismatch", "order", order.id, { code, taken: -move.amount, paid: p.amount });
    }
    return move.gift_card_id as string;
  }
  if (!card) {
    await audit(tx, device, order.cashierId, "order.gift_card_mismatch", "order", order.id, { code, reason: "unknown gift card", paid: p.amount });
    return null;
  }
  const balance = await moveGiftCard(tx, {
    ...base,
    cardId: card.id,
    amount: -p.amount,
    kind: move ? "adjust" : "redeem",
    paymentId: move ? null : p.id,
    note: move ? `Spent on ${order.number} after it was given back` : null,
  });
  await audit(tx, device, order.cashierId, "order.gift_card_late", "order", order.id, { code, paid: p.amount, balance });
  return card.id;
}

/**
 * Points for a bill with a customer: points paid or given back, then points earned on a sale
 * or taken back by a refund. The till checks the balance online before spending points, but two
 * tills could still spend the same points at the same moment; the balance then goes below zero
 * and the owner is told, rather than losing a sale the customer has already paid for.
 */
async function bookPoints(tx: Tx, device: DeviceContext, order: OrderSync, customerId: string, lines: PricedLine[]) {
  const settings = await loyaltySettings(tx, device.tenantId);
  const base = { tenantId: device.tenantId, customerId, orderId: order.id, userId: order.cashierId, at: order.createdAt };
  await tx.query("SELECT 1 FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
  let balance: number | null = null;
  for (const p of order.payments) {
    if (p.kind !== "points") continue;
    const points = p.points!;
    balance = await movePoints(tx, { ...base, points: p.amount >= 0 ? -points : points, kind: p.amount >= 0 ? "redeem" : "refund_redeem" });
    if (p.amount >= 0 && points * settings.pointValueFils !== p.amount) {
      await audit(tx, device, order.cashierId, "loyalty.value_mismatch", "order", order.id, {
        points,
        paid: p.amount,
        pointValueFils: settings.pointValueFils,
      });
    }
  }
  if (balance !== null && balance < 0) {
    await audit(tx, device, order.cashierId, "loyalty.overdrawn", "customer", customerId, { order: order.number, balance });
  }

  if (order.refundOfOrderId) {
    // Take back the share of what the sale earned that this refund returns.
    const { rows } = await tx.query(
      `SELECT o.points_earned AS earned,
              (SELECT COALESCE(SUM(gross), 0) FROM order_lines WHERE order_id = o.id AND gift_card_code IS NULL)::int AS goods,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND kind = 'points')::int AS "paidPoints",
              (SELECT COALESCE(-SUM(p.amount), 0) FROM payments p JOIN orders x ON x.id = p.order_id
                WHERE x.refund_of_order_id = o.id AND p.kind = 'points' AND x.id <> $2)::int AS "refundedPoints",
              (SELECT COALESCE(-SUM(points), 0) FROM loyalty_moves WHERE kind = 'refund_earn'
                  AND order_id IN (SELECT id FROM orders WHERE refund_of_order_id = o.id))::int AS taken
         FROM orders o WHERE o.id = $1`,
      [order.refundOfOrderId, order.id],
    );
    const r = rows[0];
    if (!r) return;
    // More given back in points than the sale took in points turns cash into points: allowed
    // (the cashier may have had a reason) but the owner is told.
    const toPoints = -order.payments.reduce((s, p) => s + (p.kind === "points" ? p.amount : 0), 0);
    if (toPoints > r.paidPoints - r.refundedPoints) {
      await audit(tx, device, order.cashierId, "refund.points_over", "order", order.id, {
        refundedInPoints: toPoints,
        paidInPoints: r.paidPoints - r.refundedPoints,
      });
    }
    if (r.earned <= 0 || r.goods <= 0) return;
    // Earned points come back in proportion to the goods returned.
    const goods = -lines.reduce((s, l) => s + (l.giftCardCode ? 0 : l.gross), 0);
    const share = Math.min(r.earned - r.taken, Math.round((r.earned * Math.min(goods, r.goods)) / r.goods));
    if (share <= 0) return;
    const left = await movePoints(tx, { ...base, points: -share, kind: "refund_earn" });
    // The customer already spent the points this refund takes back: the balance owes them.
    if (left < 0) await audit(tx, device, order.cashierId, "loyalty.overdrawn", "customer", customerId, { order: order.number, balance: left });
    return;
  }
  if (!settings.enabled) return;
  const earned = pointsEarned(pointsEligible(lines, order.payments), settings);
  if (earned <= 0) return;
  await movePoints(tx, { ...base, points: earned, kind: "earn" });
  await tx.query("UPDATE orders SET points_earned = $2 WHERE id = $1", [order.id, earned]);
}

/**
 * A refund must point at a sale from this tenant and cannot return more than was sold.
 * Returns the sale's customer.
 */
async function checkRefund(tx: Tx, device: DeviceContext, order: OrderSync): Promise<string | null> {
  const original = await tx.query("SELECT id, customer_id FROM orders WHERE id = $1 AND tenant_id = $2 AND refund_of_order_id IS NULL", [
    order.refundOfOrderId,
    device.tenantId,
  ]);
  if (!original.rows[0]) throw reject("unknown_original", "Original sale not found (it may not have synced yet)");
  if (order.lines.some((l) => l.qty > 0)) throw reject("positive_qty", "Refund lines must have negative quantities");

  const { rows } = await tx.query(
    `SELECT ol.variant_id,
            SUM(ol.qty) FILTER (WHERE o.id = $1) AS sold,
            COALESCE(SUM(-ol.qty) FILTER (WHERE o.refund_of_order_id = $1), 0) AS refunded
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE o.id = $1 OR o.refund_of_order_id = $1
      GROUP BY ol.variant_id`,
    [order.refundOfOrderId],
  );
  const room = new Map(rows.map((r) => [r.variant_id as string, (r.sold ?? 0) - r.refunded]));
  const asked = new Map<string, number>();
  for (const l of order.lines) if (l.variantId) asked.set(l.variantId, (asked.get(l.variantId) ?? 0) - l.qty);
  for (const [variantId, qty] of asked) {
    if (qty > (room.get(variantId) ?? 0) + 1e-9) throw reject("over_refund", "Refund is more than what was sold");
  }

  // Items bought on a promotion come back at what was paid for them: the refund carries its
  // share of the promotion. Less than that would hand back more than the customer paid.
  const promo = await tx.query(
    `SELECT variant_id, SUM(qty)::float AS qty, SUM(promo_discount)::int AS promo
       FROM order_lines WHERE order_id = $1 GROUP BY variant_id HAVING SUM(promo_discount) <> 0`,
    [order.refundOfOrderId],
  );
  const short: { variantId: string; expected: number; given: number }[] = [];
  for (const r of promo.rows) {
    const lines = order.lines.filter((l) => l.variantId === r.variant_id);
    if (!lines.length) continue;
    const qty = -lines.reduce((s, l) => s + l.qty, 0);
    const given = -lines.reduce((s, l) => s + l.promoDiscount, 0);
    const expected = Math.round((r.promo * qty) / r.qty);
    if (given < expected - lines.length) short.push({ variantId: r.variant_id, expected, given });
  }
  if (short.length) await audit(tx, device, order.cashierId, "refund.promo_short", "order", order.id, { lines: short });
  return original.rows[0].customer_id as string | null;
}

export async function orderRoutes(app: FastifyInstance) {
  /**
   * The till's outbox posts orders in batches. Each order is stored in its own
   * transaction and keyed by its client UUID, so retries are always safe.
   */
  app.post("/orders/batch", async (req) => {
    const device = await app.authenticate(req);
    const { orders } = OrderBatchSchema.parse(req.body);
    const results: Result[] = [];
    for (const order of orders) {
      try {
        results.push(await withTx(app.db, (tx) => storeOrder(tx, device, order)));
      } catch (err) {
        if (err instanceof HttpError) {
          results.push({ id: order.id, status: "rejected", error: err.code, message: err.message });
        } else if ((err as { code?: string }).code === "23505") {
          // A parallel request stored the same order first.
          results.push({ id: order.id, status: "duplicate" });
        } else {
          throw err;
        }
      }
    }
    return { results };
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (req) => {
    const device = await app.authenticate(req);
    const { rows } = await app.db.query("SELECT * FROM orders WHERE id = $1 AND tenant_id = $2", [
      req.params.id,
      device.tenantId,
    ]);
    if (!rows[0]) throw new HttpError(404, "not_found", "Order not found");
    const lines = await app.db.query("SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no", [req.params.id]);
    const payments = await app.db.query("SELECT * FROM payments WHERE order_id = $1", [req.params.id]);
    return { ...rows[0], lines: lines.rows, payments: payments.rows };
  });

  /** Finds a sale by receipt number for refunds. */
  app.get<{ Querystring: { number?: string } }>("/orders", async (req) => {
    const device = await app.authenticate(req);
    const number = String(req.query.number ?? "").trim();
    if (!number) return { orders: [] };
    const { rows } = await app.db.query(
      `SELECT id, number, total, created_at FROM orders
        WHERE tenant_id = $1 AND number = $2 AND refund_of_order_id IS NULL`,
      [device.tenantId, number],
    );
    return { orders: rows };
  });
}

/**
 * The table's bill was paid. The till closes the tab as soon as it can; this catches sales
 * that synced later, and logs a tab paid twice instead of refusing the sale.
 */
async function closeTabForOrder(tx: Tx, device: DeviceContext, orderId: string, tabId: string, cashierId: string) {
  const { rows } = await tx.query("SELECT id, status, order_id FROM tabs WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [tabId, device.tenantId]);
  const tab = rows[0];
  if (!tab) return;
  await tx.query("UPDATE orders SET tab_id = $2 WHERE id = $1", [orderId, tab.id]);
  if (tab.order_id && tab.order_id !== orderId) {
    await audit(tx, device, cashierId, "tab.paid_twice", "tab", tab.id, { orderId, earlier: tab.order_id });
    return;
  }
  await tx.query(
    "UPDATE tabs SET status = 'paid', order_id = $2, closed_at = COALESCE(closed_at, now()), updated_by = $3, updated_at = now() WHERE id = $1",
    [tab.id, orderId, cashierId],
  );
}

/**
 * A click-and-collect order paid for at the till. The sale is already final, so problems
 * (an order cancelled meanwhile, or one already handed over) are logged rather than refused.
 */
async function handOverWebOrder(tx: Tx, device: DeviceContext, orderId: string, webOrderId: string, cashierId: string) {
  const { rows } = await tx.query("SELECT id, number, status, order_id FROM web_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [
    webOrderId,
    device.tenantId,
  ]);
  const w = rows[0];
  if (!w) return;
  if (w.order_id && w.order_id !== orderId) {
    await audit(tx, device, cashierId, "web_order.collected_twice", "web_order", w.id, { number: w.number, orderId });
    return;
  }
  if (w.status === "cancelled") await audit(tx, device, cashierId, "web_order.collected_after_cancel", "web_order", w.id, { number: w.number });
  await tx.query("UPDATE orders SET web_order_id = $2 WHERE id = $1", [orderId, w.id]);
  await tx.query("UPDATE web_orders SET status = 'collected', collected_at = now(), order_id = $2 WHERE id = $1", [w.id, orderId]);
}
