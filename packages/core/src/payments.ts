import { roundCash } from "./money.js";

export type PaymentMethodKind = "cash" | "card" | "card_manual";

export interface PaymentInput {
  id: string;
  methodId: string;
  kind: PaymentMethodKind;
  /** Amount applied to the order, in minor units. */
  amount: number;
  /** Cash handed over by the customer; change is tendered - amount. */
  tendered?: number;
  reference?: string;
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
