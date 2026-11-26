import {
  applyPromotions,
  normalizeQty,
  priceOrder,
  scaleLine,
  type ScaleBarcode,
  type AppliedPromotion,
  type LineInput,
  type OrderTotals,
  type Promotion,
  type TaxRate,
} from "@pos/core";

/** A choice made for an item (size, extra, "no onion"); its price is in the line's unit price. */
export interface LineModifier {
  groupId?: string;
  optionId?: string;
  name: string;
  price: number;
}

export interface CartLine extends LineInput {
  uom: "unit" | "kg";
  note?: string;
  modifiers?: LineModifier[];
  /** Restaurants: how much of the line the kitchen has already been sent. */
  sentQty?: number;
  /**
   * The price the till picked (the product's, or from a price list). A unitPrice that differs
   * was changed by hand: such a line keeps its price and takes no promotion.
   */
  listPrice?: number;
  /** Set when the line came from a scale label: the label's barcode. */
  scaleLabel?: string;
}

export interface CartCustomer {
  id: string;
  name: string;
  phone: string | null;
  priceListId: string | null;
  /** Points balance when the customer was picked (the till checks again before spending). */
  points?: number;
}

export interface Cart {
  lines: CartLine[];
  orderDiscountBp: number;
  customerId: string | null;
  customer?: CartCustomer | null;
  /** Coupon codes the cashier entered, upper case. */
  codes?: string[];
  /** Set when this cart returns items from an earlier sale. */
  refundOfOrderId: string | null;
  /** On a refund: the original bill's number, for the manager approval and the audit log. */
  refundOfNumber?: string;
  /** On a refund: what the original sale took in points, the most that goes back as points. */
  refundPointsRoom?: number;
  /** An online (click-and-collect) order this sale hands over. */
  webOrderId?: string | null;
  webOrderNumber?: string;
  /** Restaurants: the open bill (tab) this sale is, and its table. */
  tabId?: string | null;
  tableId?: string | null;
  tableName?: string;
  guests?: number;
  /** The tab's version on the server when the till last loaded or saved it; 0 until first saved. */
  tabVersion?: number;
  /** Items taken off after the kitchen had them; the next kitchen ticket cancels them. */
  kitchenVoids?: { name: string; qty: number; modifiers: string[] }[];
}

export const modifiersTotal = (mods: LineModifier[] | undefined) => (mods ?? []).reduce((s, m) => s + m.price, 0);

export const emptyCart = (): Cart => ({ lines: [], orderDiscountBp: 0, customerId: null, refundOfOrderId: null });

export interface SellableItem {
  variantId: string;
  name: string;
  price: number;
  taxId: string | null;
  uom: "unit" | "kg";
}

/** Adds a line that sells (or tops up) a gift card: face value, no VAT, no discount. */
export function addGiftCard(cart: Cart, code: string, amount: number, newId: () => string = () => crypto.randomUUID()): Cart {
  const line: CartLine = {
    id: newId(),
    variantId: null,
    giftCardCode: code.trim().toUpperCase(),
    name: "Gift card",
    unitPrice: amount,
    qty: 1,
    discountBp: 0,
    taxId: null,
    uom: "unit",
  };
  return { ...cart, lines: [...cart.lines, line] };
}

/**
 * Scanning the same unit item again adds to its line; weighed items and items with
 * modifiers (each made its own way) always get a new line.
 */
export function addItem(
  cart: Cart,
  item: SellableItem,
  qty = 1,
  newId: () => string = () => crypto.randomUUID(),
  modifiers: LineModifier[] = [],
): Cart {
  const existing =
    item.uom === "unit" && !modifiers.length
      ? cart.lines.find((l) => l.variantId === item.variantId && !l.discountBp && l.unitPrice === item.price && !l.note && !l.modifiers?.length)
      : undefined;
  if (existing) return updateLine(cart, existing.id, { qty: normalizeQty(existing.qty + qty) });
  const price = item.price + modifiersTotal(modifiers);
  const line: CartLine = {
    id: newId(),
    variantId: item.variantId,
    name: item.name,
    unitPrice: price,
    qty: normalizeQty(qty),
    discountBp: 0,
    taxId: item.taxId,
    uom: item.uom,
    listPrice: price,
    ...(modifiers.length ? { modifiers } : {}),
  };
  return { ...cart, lines: [...cart.lines, line] };
}

/**
 * Adds a line from a scale label: the weight (or the price) printed on it. Each label is its
 * own line, and a price label's amount is kept as printed, like a price set by hand.
 */
export function addScaleItem(
  cart: Cart,
  item: SellableItem,
  label: ScaleBarcode,
  code: string,
  newId: () => string = () => crypto.randomUUID(),
): Cart | null {
  const sold = scaleLine(label, item);
  if (!sold) return null;
  const line: CartLine = {
    id: newId(),
    variantId: item.variantId,
    name: item.name,
    unitPrice: sold.unitPrice,
    qty: sold.qty,
    discountBp: 0,
    taxId: item.taxId,
    uom: item.uom,
    listPrice: item.price,
    scaleLabel: code,
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

/** Whether the cashier changed the line's price or discount by hand. */
export const isManual = (l: CartLine) => !!l.discountBp || (l.listPrice !== undefined && l.unitPrice !== l.listPrice);

/**
 * Puts each line at its list price (the customer's or store's price list, else the
 * product's own). Lines whose price was changed by hand keep it.
 */
export function repriceCart(cart: Cart, priceOf: (variantId: string) => number | undefined): Cart {
  let changed = false;
  const lines = cart.lines.map((l) => {
    if (!l.variantId || (l.listPrice !== undefined && l.unitPrice !== l.listPrice)) return l;
    const base = priceOf(l.variantId);
    const price = base === undefined ? undefined : base + modifiersTotal(l.modifiers);
    if (price === undefined || (price === l.unitPrice && price === l.listPrice)) return l;
    changed = true;
    return { ...l, unitPrice: price, listPrice: price };
  });
  return changed ? { ...cart, lines } : cart;
}

export function setCustomer(cart: Cart, customer: CartCustomer | null): Cart {
  return { ...cart, customer, customerId: customer?.id ?? null };
}

export function addCode(cart: Cart, code: string): Cart {
  const c = code.trim().toUpperCase();
  const codes = cart.codes ?? [];
  return !c || codes.includes(c) ? cart : { ...cart, codes: [...codes, c] };
}

export function removeCode(cart: Cart, code: string): Cart {
  return { ...cart, codes: (cart.codes ?? []).filter((c) => c !== code) };
}

export interface PromoEnv {
  promotions: Promotion[];
  /** Product and category of each variant, to match promotion targets. */
  products: Map<string, { productId: string; categoryId: string | null }>;
  storeId: string;
  timezone: string;
}

export interface PromotedCart {
  /** The cart with each line's promotion discount filled in. */
  cart: Cart;
  applied: AppliedPromotion[];
  unknownCodes: string[];
}

/**
 * Works out the promotions on a sale. A refund keeps the promotion share it was given from
 * the original sale, so it is left as it is.
 */
export function promoteCart(cart: Cart, env: PromoEnv, now = new Date()): PromotedCart {
  if (cart.refundOfOrderId) return { cart, applied: [], unknownCodes: [] };
  const res = applyPromotions(
    cart.lines.map((l) => {
      const p = l.variantId ? env.products.get(l.variantId) : undefined;
      return {
        id: l.id,
        variantId: l.variantId,
        productId: p?.productId ?? null,
        categoryId: p?.categoryId ?? null,
        unitPrice: l.unitPrice,
        qty: l.qty,
        uom: l.uom,
        // Gift cards are money, not goods: never on promotion.
        manual: isManual(l) || !!l.giftCardCode,
      };
    }),
    env.promotions,
    { now, timezone: env.timezone, storeId: env.storeId, codes: cart.codes ?? [], orderPromotions: !cart.orderDiscountBp },
  );
  const lines = cart.lines.map((l) => ({ ...l, promoDiscount: res.lines[l.id]?.discount ?? 0, promotionId: res.lines[l.id]?.promotionId ?? null }));
  return { cart: { ...cart, lines }, applied: res.applied, unknownCodes: res.unknownCodes };
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
