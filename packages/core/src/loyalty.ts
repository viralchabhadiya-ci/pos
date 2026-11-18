import type { PaymentInput } from "./payments.js";

/** A business's points programme. The same numbers run on the till (receipt) and the server (ledger). */
export interface LoyaltySettings {
  enabled: boolean;
  /** Points a customer earns for each AED 1 spent. */
  pointsPerAed: number;
  /** What one point is worth when spent, in fils (1 means 100 points pay AED 1). */
  pointValueFils: number;
  /** The fewest points a customer can spend at once. */
  minRedeemPoints: number;
}

export const DEFAULT_LOYALTY: LoyaltySettings = { enabled: false, pointsPerAed: 1, pointValueFils: 1, minRedeemPoints: 100 };

/**
 * The part of a bill that earns points: goods (not gift cards being bought) less whatever was
 * paid with points. Paying with a gift card still earns, because that money earned nothing when
 * the card was bought. Negative for refunds.
 */
export function pointsEligible(
  lines: { gross: number; giftCardCode?: string | null }[],
  payments: Pick<PaymentInput, "kind" | "amount">[],
): number {
  const goods = lines.reduce((s, l) => s + (l.giftCardCode ? 0 : l.gross), 0);
  const paidWithPoints = payments.reduce((s, p) => s + (p.kind === "points" ? p.amount : 0), 0);
  const eligible = goods - paidWithPoints;
  // A sale never earns negative points and a refund never gives points.
  return goods >= 0 ? Math.max(0, eligible) : Math.min(0, eligible);
}

/** Whole points earned for an eligible amount in fils, rounded toward zero. */
export function pointsEarned(eligibleFils: number, s: Pick<LoyaltySettings, "pointsPerAed">): number {
  return Math.trunc((eligibleFils * s.pointsPerAed) / 100);
}

/** What a number of points pays, in fils. */
export const pointsValue = (points: number, s: Pick<LoyaltySettings, "pointValueFils">) => points * s.pointValueFils;

/**
 * The most points a customer can spend on what is still due: limited by their balance and by
 * the amount due (points never pay more than the bill). 0 when below the programme's minimum.
 */
export function maxRedeemablePoints(balance: number, due: number, s: Pick<LoyaltySettings, "pointValueFils" | "minRedeemPoints">): number {
  if (s.pointValueFils <= 0 || due <= 0) return 0;
  const points = Math.min(Math.max(0, balance), Math.floor(due / s.pointValueFils));
  return points >= Math.max(1, s.minRedeemPoints) ? points : 0;
}

/** Points to give back when a refund goes to points: enough to cover the amount, rounded up. */
export function pointsForRefund(amount: number, s: Pick<LoyaltySettings, "pointValueFils">): number {
  return Math.ceil(Math.abs(amount) / Math.max(1, s.pointValueFils));
}

/** Shows only the end of a gift card number on receipts and screens. */
export function maskGiftCard(code: string): string {
  const plain = code.replace(/[^A-Za-z0-9]/g, "");
  return plain.length <= 4 ? plain : `•••• ${plain.slice(-4)}`;
}

/**
 * A new random 16-digit gift card number for a card sold or issued without a printed card.
 * Whoever holds the number can spend the card, so it comes from the secure random source.
 */
export function newGiftCardCode(): string {
  const bytes = new Uint32Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b, i) => (i === 0 ? 1 + (b % 9) : b % 10)).join("");
}
