import { allocate, mulDiv } from "./money.js";

/** A tax rate. `rateBp` is in basis points: 500 = 5%. */
export interface TaxRate {
  id: string;
  name: string;
  rateBp: number;
  /** True when product prices already include this tax (usual for UAE retail shelf prices). */
  priceIncluded: boolean;
}

export interface LineInput {
  id: string;
  variantId: string;
  name: string;
  /** Unit price in minor units, as stored on the product (tax-inclusive or not, per its tax). */
  unitPrice: number;
  /** Quantity; up to 3 decimals for weighed items. Negative for returns. */
  qty: number;
  /** Line discount in basis points: 1000 = 10%. */
  discountBp?: number;
  /** Tax applied to the line; null for out-of-scope items. */
  taxId: string | null;
}

export interface PricingContext {
  taxes: Record<string, TaxRate>;
  /** Order-level discount in basis points, spread across lines before tax. */
  orderDiscountBp?: number;
}

export interface PricedLine extends LineInput {
  /** unitPrice x qty before any discount. */
  amount: number;
  lineDiscount: number;
  orderDiscount: number;
  net: number;
  tax: number;
  gross: number;
}

export interface TaxSummary {
  taxId: string;
  name: string;
  rateBp: number;
  net: number;
  tax: number;
}

export interface OrderTotals {
  lines: PricedLine[];
  /** Sum of line amounts before discounts, in each line's price basis. */
  amountTotal: number;
  discountTotal: number;
  subtotalNet: number;
  taxTotal: number;
  total: number;
  taxes: TaxSummary[];
}

const QTY_SCALE = 1000;

/** Quantity is held to 3 decimals so weighed items (kg) price exactly. */
export function normalizeQty(qty: number): number {
  return Math.round(qty * QTY_SCALE) / QTY_SCALE;
}

/**
 * Prices an order. Rounding is per line, half away from zero, so a refund of a line
 * reverses exactly what the sale charged. The same function runs on the till and the
 * server; the server's result is the one that is stored.
 */
export function priceOrder(inputs: LineInput[], ctx: PricingContext): OrderTotals {
  const amounts = inputs.map((l) => mulDiv(l.unitPrice, Math.round(normalizeQty(l.qty) * QTY_SCALE), QTY_SCALE));
  const lineDiscounts = inputs.map((l, i) => mulDiv(amounts[i]!, l.discountBp ?? 0, 10_000));
  const afterLine = amounts.map((a, i) => a - lineDiscounts[i]!);

  const orderDiscountTotal = mulDiv(
    afterLine.reduce((s, a) => s + a, 0),
    ctx.orderDiscountBp ?? 0,
    10_000,
  );
  const orderDiscounts = allocate(orderDiscountTotal, afterLine);

  const lines: PricedLine[] = inputs.map((l, i) => {
    const priced = afterLine[i]! - orderDiscounts[i]!;
    const tax = l.taxId ? ctx.taxes[l.taxId] : undefined;
    if (l.taxId && !tax) throw new Error(`Unknown tax ${l.taxId} on line ${l.id}`);
    let net: number;
    let taxAmount: number;
    if (!tax) {
      net = priced;
      taxAmount = 0;
    } else if (tax.priceIncluded) {
      net = mulDiv(priced, 10_000, 10_000 + tax.rateBp);
      taxAmount = priced - net;
    } else {
      net = priced;
      taxAmount = mulDiv(priced, tax.rateBp, 10_000);
    }
    return {
      ...l,
      qty: normalizeQty(l.qty),
      amount: amounts[i]!,
      lineDiscount: lineDiscounts[i]!,
      orderDiscount: orderDiscounts[i]!,
      net,
      tax: taxAmount,
      gross: net + taxAmount,
    };
  });

  const byTax = new Map<string, TaxSummary>();
  for (const line of lines) {
    if (!line.taxId) continue;
    const rate = ctx.taxes[line.taxId]!;
    const entry = byTax.get(rate.id) ?? { taxId: rate.id, name: rate.name, rateBp: rate.rateBp, net: 0, tax: 0 };
    entry.net += line.net;
    entry.tax += line.tax;
    byTax.set(rate.id, entry);
  }

  const sum = (f: (l: PricedLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  return {
    lines,
    amountTotal: sum((l) => l.amount),
    discountTotal: sum((l) => l.lineDiscount + l.orderDiscount),
    subtotalNet: sum((l) => l.net),
    taxTotal: sum((l) => l.tax),
    total: sum((l) => l.gross),
    taxes: [...byTax.values()],
  };
}
