import { z } from "zod";

/** Wire format shared by the till and the API. Amounts are integer minor units. */

/** A gift card number: what a printed card's barcode holds, or one the till made up. Upper case. */
export const GiftCardCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{6,40}$/, "Gift card numbers are 6 to 40 letters, digits or dashes");

export const OrderLineSchema = z.object({
  id: z.string().uuid(),
  /** The product sold; null only on a line that sells or tops up a gift card. */
  variantId: z.string().uuid().nullable(),
  /** Set on a line that loads a gift card: no VAT, no discount, no stock. */
  giftCardCode: GiftCardCodeSchema.optional(),
  name: z.string().min(1).max(200),
  qty: z.number().finite().refine((q) => q !== 0, "qty must not be zero"),
  unitPrice: z.number().int(),
  discountBp: z.number().int().min(0).max(10_000).default(0),
  /** Promotion discount for the line, same sign as the line; the engine caps it at the line amount. */
  promoDiscount: z.number().int().default(0),
  promotionId: z.string().uuid().nullable().default(null),
  taxId: z.string().uuid().nullable(),
  note: z.string().max(500).optional(),
  /** Choices made for the item (size, extras, "no onion"); their prices are in unitPrice. */
  modifiers: z
    .array(z.object({ name: z.string().min(1).max(100), price: z.number().int() }))
    .max(30)
    .optional(),
});

export const PaymentSchema = z.object({
  id: z.string().uuid(),
  methodId: z.string().uuid(),
  kind: z.enum(["cash", "card", "card_manual", "gift_card", "points", "delivery"]),
  amount: z.number().int(),
  tendered: z.number().int().optional(),
  reference: z.string().max(100).optional(),
  /** The integrated terminal's card payment that paid this, when there is one. */
  cardTransactionId: z.string().uuid().optional(),
  /** The gift card paid with, or refunded onto. */
  giftCardCode: GiftCardCodeSchema.optional(),
  /** Loyalty points spent (or given back by a refund) on a points payment. Always positive. */
  points: z.number().int().positive().optional(),
});

export const OrderSyncSchema = z.object({
  id: z.string().uuid(),
  number: z.string().min(1).max(40),
  registerId: z.string().uuid(),
  sessionId: z.string().uuid(),
  cashierId: z.string().uuid(),
  customerId: z.string().uuid().nullable().default(null),
  refundOfOrderId: z.string().uuid().nullable().default(null),
  /** The online order this sale hands over to the customer (click-and-collect). */
  webOrderId: z.string().uuid().nullish(),
  /** The restaurant tab (table bill) this sale pays off. */
  tabId: z.string().uuid().nullish(),
  orderDiscountBp: z.number().int().min(0).max(10_000).default(0),
  createdAt: z.string().datetime(),
  lines: z.array(OrderLineSchema).min(1).max(500),
  /** Promotions the till applied, with the coupon code that unlocked each one. */
  promotions: z
    .array(
      z.object({
        promotionId: z.string().uuid(),
        /** As the till showed it, for receipts printed before the order syncs. */
        name: z.string().max(120).optional(),
        amount: z.number().int(),
        code: z.string().max(40).nullable().default(null),
      }),
    )
    .max(50)
    .default([]),
  payments: z.array(PaymentSchema).min(1).max(20),
  /** Totals as the till computed them; the server recomputes and flags any mismatch. */
  clientTotals: z.object({ subtotalNet: z.number().int(), taxTotal: z.number().int(), total: z.number().int() }),
});

export type OrderLine = z.infer<typeof OrderLineSchema>;
export type Payment = z.infer<typeof PaymentSchema>;
export type OrderSync = z.infer<typeof OrderSyncSchema>;

export const OrderBatchSchema = z.object({ orders: z.array(OrderSyncSchema).min(1).max(100) });

export const SessionOpenSchema = z.object({
  id: z.string().uuid(),
  registerId: z.string().uuid(),
  /** Per-register sequence, assigned on the device so receipt numbers work offline. */
  seq: z.number().int().positive(),
  openedBy: z.string().uuid(),
  openingCash: z.number().int().min(0),
  openedAt: z.string().datetime(),
});

export const SessionCloseSchema = z.object({
  closedBy: z.string().uuid(),
  closingCashCounted: z.number().int().min(0),
  closedAt: z.string().datetime(),
  note: z.string().max(500).optional(),
});

export const CashMoveSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kind: z.enum(["in", "out"]),
  amount: z.number().int().positive(),
  reason: z.string().min(1).max(200),
  userId: z.string().uuid(),
  at: z.string().datetime(),
});
export type CashMove = z.infer<typeof CashMoveSchema>;

/**
 * Something done at the till that leaves no bill behind (a voided sale, the drawer opened with
 * no sale) or that needed a manager (a price change, a big discount, a refund). Queued like a
 * sale so it reaches the audit log even after a day offline.
 */
export const TILL_EVENT_KINDS = ["void", "no_sale", "price_override", "discount", "refund"] as const;
export const TillEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(TILL_EVENT_KINDS),
  sessionId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid(),
  /** The manager whose PIN was entered, or the owner who approved from their phone. */
  approvedBy: z.string().uuid().nullable().optional(),
  /** Set when the approval came from the owner app. */
  approvalId: z.string().uuid().nullable().optional(),
  summary: z.string().trim().min(1).max(200),
  amount: z.number().int().min(0).max(100_000_000).nullable().optional(),
  details: z.record(z.unknown()).optional(),
  at: z.string().datetime(),
});
export type TillEvent = z.infer<typeof TillEventSchema>;
