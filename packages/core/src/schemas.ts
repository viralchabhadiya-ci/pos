import { z } from "zod";

/** Wire format shared by the till and the API. Amounts are integer minor units. */

export const OrderLineSchema = z.object({
  id: z.string().uuid(),
  variantId: z.string().uuid(),
  name: z.string().min(1).max(200),
  qty: z.number().finite().refine((q) => q !== 0, "qty must not be zero"),
  unitPrice: z.number().int(),
  discountBp: z.number().int().min(0).max(10_000).default(0),
  taxId: z.string().uuid().nullable(),
  note: z.string().max(500).optional(),
});

export const PaymentSchema = z.object({
  id: z.string().uuid(),
  methodId: z.string().uuid(),
  kind: z.enum(["cash", "card", "card_manual"]),
  amount: z.number().int(),
  tendered: z.number().int().optional(),
  reference: z.string().max(100).optional(),
});

export const OrderSyncSchema = z.object({
  id: z.string().uuid(),
  number: z.string().min(1).max(40),
  registerId: z.string().uuid(),
  sessionId: z.string().uuid(),
  cashierId: z.string().uuid(),
  customerId: z.string().uuid().nullable().default(null),
  refundOfOrderId: z.string().uuid().nullable().default(null),
  orderDiscountBp: z.number().int().min(0).max(10_000).default(0),
  createdAt: z.string().datetime(),
  lines: z.array(OrderLineSchema).min(1).max(500),
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
