import { roundCash } from "./money.js";

/** delivery: paid to a delivery platform (Talabat, Deliveroo, ...), which pays the store later. */
export type PaymentMethodKind = "cash" | "card" | "card_manual" | "gift_card" | "points" | "delivery";

export interface PaymentInput {
  id: string;
  methodId: string;
  kind: PaymentMethodKind;
  /** Amount applied to the order, in minor units. */
  amount: number;
  /** Cash handed over by the customer; change is tendered - amount. */
  tendered?: number;
  reference?: string;
  /** The integrated terminal's card payment behind this payment. */
  cardTransactionId?: string;
  /** The gift card paid with (or refunded onto) on a gift_card payment. */
  giftCardCode?: string;
  /** Points spent (or given back on a refund) on a points payment. Always positive. */
  points?: number;
}

export interface PaymentCheck {
  /** Total due after cash rounding (only applied when the whole order is paid in cash). */
  due: number;
  cashRounding: number;
  paid: number;
  remaining: number;
  change: number;
  complete: boolean;
}

/**
 * Checks payments against an order total. Cash rounding applies only when every payment
 * is cash, because card payments settle to the fil.
 */
export function checkPayments(total: number, payments: PaymentInput[], cashStep = 25): PaymentCheck {
  const allCash = payments.length > 0 && payments.every((p) => p.kind === "cash");
  const { rounded, adjustment } = allCash ? roundCash(total, cashStep) : { rounded: total, adjustment: 0 };
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const change = payments.reduce((s, p) => s + Math.max(0, (p.tendered ?? p.amount) - p.amount), 0);
  const remaining = rounded - paid;
  const complete = rounded >= 0 ? remaining <= 0 : remaining >= 0;
  return { due: rounded, cashRounding: adjustment, paid, remaining, change, complete };
}
