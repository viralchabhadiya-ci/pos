import { DEFAULT_SCALE_RULES, makeScaleBarcode, parseScaleBarcode } from "@pos/core";
import { describe, expect, it } from "vitest";
import {
  addScaleItem,
  addCode,
  addGiftCard,
  addItem,
  cartTotals,
  emptyCart,
  needsManager,
  promoteCart,
  removeCode,
  removeLine,
  repriceCart,
  updateLine,
  type SellableItem,
} from "./cart.js";

const vat = { id: "vat", name: "VAT 5%", rateBp: 500, priceIncluded: true };
const water: SellableItem = { variantId: "w", name: "Water", price: 150, taxId: "vat", uom: "unit" };
const banana: SellableItem = { variantId: "b", name: "Bananas", price: 795, taxId: "vat", uom: "kg" };
let n = 0;
const id = () => `line-${++n}`;

describe("cart", () => {
  it("merges repeated scans of unit items and keeps weighed items separate", () => {
    let cart = addItem(emptyCart(), water, 1, id);
    cart = addItem(cart, water, 1, id);
    cart = addItem(cart, banana, 0.5, id);
    cart = addItem(cart, banana, 0.25, id);
    expect(cart.lines.map((l) => [l.variantId, l.qty])).toEqual([
      ["w", 2],
      ["b", 0.5],
      ["b", 0.25],
    ]);
  });

  it("removes a line when its quantity becomes zero", () => {
    let cart = addItem(emptyCart(), water, 1, id);
    cart = updateLine(cart, cart.lines[0]!.id, { qty: 0 });
    expect(cart.lines).toHaveLength(0);
  });

  it("totals with VAT and order discount", () => {
    let cart = addItem(emptyCart(), water, 4, id);
    cart = { ...cart, orderDiscountBp: 1000 };
    const t = cartTotals(cart, { vat });
    expect(t.total).toBe(540);
    expect(t.subtotalNet + t.taxTotal).toBe(540);
  });

  it("asks for a manager on price changes and big discounts", () => {
    const cart = addItem(emptyCart(), water, 1, id);
    const line = cart.lines[0]!;
    expect(needsManager({ discountBp: 500 }, line)).toBe(false);
    expect(needsManager({ discountBp: 1500 }, line)).toBe(true);
    expect(needsManager({ unitPrice: 100 }, line)).toBe(true);
    expect(removeLine(cart, line.id).lines).toHaveLength(0);
  });
});

describe("price lists and promotions in the cart", () => {
  const env = {
    promotions: [
      {
        id: "p1",
        name: "Water 3 for 4.00",
        kind: "multi_buy" as const,
        target: { all: false, categoryIds: ["drinks"], productIds: [] },
        bundleQty: 3,
        bundlePrice: 400,
        priority: 1,
        active: true,
      },
      { id: "p2", name: "Eid 10%", kind: "order_percent_off" as const, target: { all: false, categoryIds: [], productIds: [] }, percentBp: 1000, code: "EID", priority: 2, active: true },
    ],
    products: new Map([
      ["w", { productId: "pw", categoryId: "drinks" }],
      ["b", { productId: "pb", categoryId: "fruit" }],
    ]),
    storeId: "s1",
    timezone: "Asia/Dubai",
  };

  it("re-prices lines from a price list but keeps prices changed by hand", () => {
    let cart = addItem(emptyCart(), water, 2, id);
    cart = addItem(cart, banana, 1, id);
    cart = updateLine(cart, cart.lines[1]!.id, { unitPrice: 700 });
    const listed = repriceCart(cart, (v) => (v === "w" ? 120 : 600));
    expect(listed.lines.map((l) => [l.unitPrice, l.listPrice])).toEqual([
      [120, 120],
      [700, 795],
    ]);
    // Nothing to change: the same cart comes back, so a re-render does not loop.
    expect(repriceCart(listed, (v) => (v === "w" ? 120 : 600))).toBe(listed);
  });

  it("works promotions into the lines, with coupons and without stacking on hand discounts", () => {
    let cart = addItem(emptyCart(), water, 3, id);
    const plain = promoteCart(cart, env);
    expect(plain.applied).toEqual([{ promotionId: "p1", name: "Water 3 for 4.00", amount: 50, code: null }]);
    expect(cartTotals(plain.cart, { vat }).total).toBe(400);

    cart = addCode(addCode(cart, " eid "), "EID");
    expect(cart.codes).toEqual(["EID"]);
    const coupon = promoteCart(cart, env);
    expect(cartTotals(coupon.cart, { vat }).total).toBe(360);
    // A hand discount on the whole sale turns the coupon off; on a line, that line's promotion.
    expect(promoteCart({ ...cart, orderDiscountBp: 500 }, env).applied.map((a) => a.promotionId)).toEqual(["p1"]);
    const manual = updateLine(cart, cart.lines[0]!.id, { discountBp: 500 });
    expect(promoteCart(manual, env).applied.map((a) => a.promotionId)).toEqual([]);
    expect(removeCode(cart, "EID").codes).toEqual([]);
  });

  it("sells a gift card at face value: no promotion, no discount, no VAT", () => {
    const cart = addCode(addGiftCard(addItem(emptyCart(), water, 3, id), " gift-1234 ", 5000, id), "EID");
    expect(cart.lines[1]).toMatchObject({ variantId: null, giftCardCode: "GIFT-1234", taxId: null, qty: 1 });
    const promoted = promoteCart(cart, env);
    expect(promoted.cart.lines[1]!.promoDiscount).toBe(0);
    const totals = cartTotals(promoted.cart, { vat });
    expect(totals.total).toBe(360 + 5000);
    expect(totals.lines[1]).toMatchObject({ gross: 5000, tax: 0 });
    // A discount on the whole sale leaves the gift card alone.
    const off = cartTotals({ ...cart, orderDiscountBp: 1000 }, { vat });
    expect(off.lines[1]).toMatchObject({ orderDiscount: 0, gross: 5000 });
    expect(off.lines[0]!.orderDiscount).toBe(45);
    expect(repriceCart(cart, () => 1)).toMatchObject({ lines: [{ unitPrice: 1 }, { unitPrice: 5000 }] });
  });

  it("leaves a refund's promotion share as the original sale gave it", () => {
    const refund = { ...emptyCart(), refundOfOrderId: "o1", lines: [{ ...addItem(emptyCart(), water, 1, id).lines[0]!, qty: -1, promoDiscount: -17 }] };
    const res = promoteCart(refund, env);
    expect(res.cart).toBe(refund);
    expect(cartTotals(res.cart, { vat }).total).toBe(-133);
  });
});

describe("scale labels", () => {
  const weightRule = DEFAULT_SCALE_RULES[0]!;
  const priceRule = DEFAULT_SCALE_RULES[1]!;

  it("adds each weight label as its own line at the shelf price", () => {
    const code = makeScaleBarcode(weightRule, "1", 1250);
    let cart = addScaleItem(emptyCart(), banana, parseScaleBarcode(code, DEFAULT_SCALE_RULES)!, code, id)!;
    cart = addScaleItem(cart, banana, parseScaleBarcode(code, DEFAULT_SCALE_RULES)!, code, id)!;
    expect(cart.lines).toHaveLength(2);
    expect(cart.lines[0]).toMatchObject({ qty: 1.25, unitPrice: 795, uom: "kg", scaleLabel: code });
    expect(cartTotals(cart, { vat }).total).toBe(2 * 994);
  });

  it("keeps a price label's amount as printed", () => {
    const code = makeScaleBarcode(priceRule, "1", 1000);
    const cart = addScaleItem(emptyCart(), banana, parseScaleBarcode(code, DEFAULT_SCALE_RULES)!, code, id)!;
    expect(cartTotals(cart, { vat }).total).toBe(1000);
  });

  it("refuses a weight label for an item sold by the piece", () => {
    const code = makeScaleBarcode(weightRule, "9", 500);
    expect(addScaleItem(emptyCart(), water, parseScaleBarcode(code, DEFAULT_SCALE_RULES)!, code, id)).toBeNull();
  });
});
