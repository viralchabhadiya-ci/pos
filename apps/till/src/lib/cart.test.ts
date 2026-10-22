import { describe, expect, it } from "vitest";
import { addItem, cartTotals, emptyCart, needsManager, removeLine, updateLine, type SellableItem } from "./cart.js";

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
