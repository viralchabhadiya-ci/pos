import { normalizeQty, priceOrder, type LineInput, type OrderTotals, type TaxRate } from "@pos/core";

export interface CartLine extends LineInput {
  uom: "unit" | "kg";
  note?: string;
}

export interface Cart {
  lines: CartLine[];
  orderDiscountBp: number;
  customerId: string | null;
  /** Set when this cart returns items from an earlier sale. */
  refundOfOrderId: string | null;
}

export const emptyCart = (): Cart => ({ lines: [], orderDiscountBp: 0, customerId: null, refundOfOrderId: null });

export interface SellableItem {
  variantId: string;
  name: string;
  price: number;
  taxId: string | null;
  uom: "unit" | "kg";
}

/** Scanning the same unit item again adds to its line; weighed items always get a new line. */
export function addItem(cart: Cart, item: SellableItem, qty = 1, newId: () => string = () => crypto.randomUUID()): Cart {
  const existing =
    item.uom === "unit"
      ? cart.lines.find((l) => l.variantId === item.variantId && !l.discountBp && l.unitPrice === item.price && !l.note)
      : undefined;
  if (existing) return updateLine(cart, existing.id, { qty: normalizeQty(existing.qty + qty) });
  const line: CartLine = {
    id: newId(),
    variantId: item.variantId,
    name: item.name,
    unitPrice: item.price,
    qty: normalizeQty(qty),
    discountBp: 0,
    taxId: item.taxId,
    uom: item.uom,
  };
  return { ...cart, lines: [...cart.lines, line] };
}

export function updateLine(cart: Cart, id: string, patch: Partial<Pick<CartLine, "qty" | "unitPrice" | "discountBp" | "note">>): Cart {
  if (patch.qty !== undefined && normalizeQty(patch.qty) === 0) return removeLine(cart, id);
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.id === id ? { ...l, ...patch, qty: normalizeQty(patch.qty ?? l.qty) } : l)),
  };
}

export function removeLine(cart: Cart, id: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.id !== id) };
}

export function cartTotals(cart: Cart, taxes: Record<string, TaxRate>): OrderTotals {
  return priceOrder(cart.lines, { taxes, orderDiscountBp: cart.orderDiscountBp });
}

/** Price changes and discounts above this need a manager PIN. */
export const CASHIER_MAX_DISCOUNT_BP = 1000;

export function needsManager(change: { discountBp?: number; unitPrice?: number }, line?: CartLine): boolean {
  if (change.discountBp !== undefined && change.discountBp > CASHIER_MAX_DISCOUNT_BP) return true;
  if (change.unitPrice !== undefined && line && change.unitPrice !== line.unitPrice) return true;
  return false;
}
