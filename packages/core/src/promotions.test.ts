import { describe, expect, it } from "vitest";
import { applyPromotions, priceOrder, promotionRunning, type PromoLine, type Promotion } from "./index.js";

const base = (over: Partial<Promotion>): Promotion => ({
  id: over.id ?? "p1",
  name: over.name ?? "Promo",
  kind: "percent_off",
  target: { all: true, categoryIds: [], productIds: [] },
  priority: 10,
  active: true,
  ...over,
});
const line = (id: string, unitPrice: number, qty: number, over: Partial<PromoLine> = {}): PromoLine => ({
  id,
  variantId: `v-${id}`,
  productId: `p-${id}`,
  categoryId: "drinks",
  unitPrice,
  qty,
  uom: "unit",
  manual: false,
  ...over,
});
// Thursday 19 Nov 2026, 18:30 in Dubai.
const ctx = { now: new Date("2026-11-19T14:30:00Z"), timezone: "Asia/Dubai", storeId: "s1", codes: [] as string[] };

describe("promotions", () => {
  it("takes a percentage off matching items only", () => {
    const p = base({ percentBp: 2000, target: { all: false, categoryIds: ["drinks"], productIds: [] } });
    const r = applyPromotions([line("a", 250, 2), line("b", 1000, 1, { categoryId: "snacks" })], [p], ctx);
    expect(r.lines).toEqual({ a: { discount: 100, promotionId: "p1" } });
    expect(r.applied).toEqual([{ promotionId: "p1", name: "Promo", amount: 100, code: null }]);
  });

  it("gives the cheapest unit free on buy 2 get 1, across lines", () => {
    const p = base({ kind: "buy_x_get_y", buyQty: 2, getQty: 1, percentBp: 10_000 });
    const r = applyPromotions([line("a", 300, 2), line("b", 250, 2)], [p], ctx);
    // Units 300, 300, 250 | 250: the 250 in the first group is free; the last unit is not.
    expect(r.lines.b).toEqual({ discount: 250, promotionId: "p1" });
    expect(r.lines.a).toEqual({ discount: 0, promotionId: "p1" });
    expect(r.applied[0]!.amount).toBe(250);
  });

  it("prices N units for a fixed amount, repeating", () => {
    const p = base({ kind: "multi_buy", bundleQty: 3, bundlePrice: 1000 });
    const r = applyPromotions([line("a", 400, 7)], [p], ctx);
    // Two bundles of 3 x 4.00 = 12.00 for 10.00; the 7th unit at full price.
    expect(r.lines.a!.discount).toBe(400);
  });

  it("leaves manual discounts, returns and weighed items out of unit promotions", () => {
    const p = base({ kind: "buy_x_get_y", buyQty: 1, getQty: 1 });
    const r = applyPromotions(
      [line("m", 500, 2, { manual: true }), line("r", 500, -2), line("k", 500, 2.5, { uom: "kg" })],
      [p],
      ctx,
    );
    expect(r.lines).toEqual({});
  });

  it("gives each line one item promotion, by priority", () => {
    const first = base({ id: "first", priority: 1, percentBp: 1000 });
    const second = base({ id: "second", priority: 2, percentBp: 5000 });
    const r = applyPromotions([line("a", 1000, 1)], [second, first], ctx);
    expect(r.lines.a).toEqual({ discount: 100, promotionId: "first" });
  });

  it("adds the best order promotion from a minimum spend, spread over the lines", () => {
    const pct = base({ id: "pct", kind: "order_percent_off", percentBp: 1000, minSubtotal: 5000 });
    const amt = base({ id: "amt", kind: "order_amount_off", amount: 1000, minSubtotal: 5000 });
    const small = applyPromotions([line("a", 2000, 2)], [pct, amt], ctx);
    expect(small.applied).toEqual([]);
    const big = applyPromotions([line("a", 3000, 2), line("b", 3000, 1)], [pct, amt], ctx);
    // 10% of 90.00 = 9.00 loses to AED 10 off.
    expect(big.applied).toEqual([{ promotionId: "amt", name: "Promo", amount: 1000, code: null }]);
    expect(big.lines.a!.discount + big.lines.b!.discount).toBe(1000);
    expect(big.lines.a!.promotionId).toBeNull();
    // A hand discount on the whole sale turns order promotions off.
    expect(applyPromotions([line("a", 3000, 3)], [pct, amt], { ...ctx, orderPromotions: false }).applied).toEqual([]);
  });

  it("needs the coupon code, and reports codes that match nothing", () => {
    const p = base({ code: "EID10", percentBp: 1000 });
    expect(applyPromotions([line("a", 1000, 1)], [p], ctx).applied).toEqual([]);
    const r = applyPromotions([line("a", 1000, 1)], [p], { ...ctx, codes: ["eid10", "nope"] });
    expect(r.applied[0]).toMatchObject({ code: "EID10", amount: 100 });
    expect(r.unknownCodes).toEqual(["NOPE"]);
  });

  it("runs only in its dates, days, hours and stores", () => {
    const running = (over: Partial<Promotion>) => promotionRunning(base(over), ctx);
    expect(running({ startsAt: "2026-11-20T00:00:00Z" })).toBe(false);
    expect(running({ endsAt: "2026-11-19T14:00:00Z" })).toBe(false);
    expect(running({ days: [4] })).toBe(true); // Thursday
    expect(running({ days: [5, 6] })).toBe(false);
    expect(running({ startTime: "17:00", endTime: "19:00" })).toBe(true);
    expect(running({ startTime: "19:00", endTime: "21:00" })).toBe(false);
    expect(running({ storeIds: ["s2"] })).toBe(false);
    expect(running({ active: false })).toBe(false);
    // A late-night window that wraps midnight counts for the day it started.
    const late = { ...ctx, now: new Date("2026-11-19T20:30:00Z") }; // Fri 00:30 in Dubai
    expect(promotionRunning(base({ startTime: "22:00", endTime: "02:00", days: [4] }), late)).toBe(true);
    expect(promotionRunning(base({ startTime: "22:00", endTime: "02:00", days: [5] }), late)).toBe(false);
  });

  it("feeds the pricing engine, which keeps VAT right and never goes below zero", () => {
    const VAT = { id: "vat", name: "VAT 5%", rateBp: 500, priceIncluded: true };
    const t = priceOrder(
      [
        { id: "a", variantId: "v", name: "A", unitPrice: 1050, qty: 2, taxId: "vat", promoDiscount: 1050 },
        { id: "b", variantId: "v", name: "B", unitPrice: 500, qty: 1, taxId: "vat", promoDiscount: 9999 },
      ],
      { taxes: { vat: VAT } },
    );
    expect(t.lines[0]).toMatchObject({ promoDiscount: 1050, gross: 1050, net: 1000, tax: 50 });
    expect(t.lines[1]).toMatchObject({ promoDiscount: 500, gross: 0 });
    expect(t.discountTotal).toBe(1550);
    expect(t.total).toBe(1050);
  });
});
