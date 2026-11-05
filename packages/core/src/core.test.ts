import { describe, expect, it } from "vitest";
import {
  allocate,
  DisplayRelay,
  checkPayments,
  formatMoney,
  formatReceiptNumber,
  parseMoney,
  parseReceiptNumber,
  priceOrder,
  roundCash,
  type LineInput,
  type TaxRate,
} from "./index.js";

const VAT_INC: TaxRate = { id: "vat-inc", name: "VAT 5%", rateBp: 500, priceIncluded: true };
const VAT_EXC: TaxRate = { id: "vat-exc", name: "VAT 5%", rateBp: 500, priceIncluded: false };
const taxes = { [VAT_INC.id]: VAT_INC, [VAT_EXC.id]: VAT_EXC };

const line = (over: Partial<LineInput>): LineInput => ({
  id: "l1",
  variantId: "v1",
  name: "Item",
  unitPrice: 1050,
  qty: 1,
  taxId: VAT_INC.id,
  ...over,
});

describe("money", () => {
  it("parses and formats amounts", () => {
    expect(parseMoney("10.5")).toBe(1050);
    expect(parseMoney("1,234.56")).toBe(123456);
    expect(parseMoney("0.005")).toBe(1);
    expect(parseMoney("-2")).toBe(-200);
    expect(() => parseMoney("abc")).toThrow();
    expect(formatMoney(123456)).toBe("1,234.56");
    expect(formatMoney(-5)).toBe("-0.05");
  });

  it("rounds cash to 25 fils", () => {
    expect(roundCash(1037, 25)).toEqual({ rounded: 1025, adjustment: -12 });
    expect(roundCash(1038, 25)).toEqual({ rounded: 1050, adjustment: 12 });
    expect(roundCash(1038, 1)).toEqual({ rounded: 1038, adjustment: 0 });
  });

  it("allocates without losing a fil", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(7, [0, 0])).toEqual([0, 0]);
    const parts = allocate(999, [123, 456, 789]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(999);
  });
});

describe("priceOrder", () => {
  it("extracts 5% VAT from tax-inclusive prices", () => {
    const t = priceOrder([line({})], { taxes });
    expect(t.lines[0]).toMatchObject({ net: 1000, tax: 50, gross: 1050 });
    expect(t).toMatchObject({ subtotalNet: 1000, taxTotal: 50, total: 1050 });
    expect(t.taxes).toEqual([{ taxId: "vat-inc", name: "VAT 5%", rateBp: 500, net: 1000, tax: 50 }]);
  });

  it("adds 5% VAT on tax-exclusive prices", () => {
    const t = priceOrder([line({ unitPrice: 1000, taxId: VAT_EXC.id })], { taxes });
    expect(t).toMatchObject({ subtotalNet: 1000, taxTotal: 50, total: 1050 });
  });

  it("prices weighed items to 3 decimals", () => {
    const t = priceOrder([line({ unitPrice: 2400, qty: 0.375 })], { taxes });
    expect(t.lines[0]!.amount).toBe(900);
  });

  it("applies line then order discounts and keeps totals consistent", () => {
    const t = priceOrder(
      [line({ id: "a", unitPrice: 1999, discountBp: 1000 }), line({ id: "b", unitPrice: 501, qty: 3 })],
      { taxes, orderDiscountBp: 500 },
    );
    expect(t.lines[0]!.lineDiscount).toBe(200);
    const afterLine = 1799 + 1503;
    const orderDiscount = Math.round(afterLine * 0.05);
    expect(t.lines.reduce((s, l) => s + l.orderDiscount, 0)).toBe(orderDiscount);
    expect(t.total).toBe(afterLine - orderDiscount);
    expect(t.subtotalNet + t.taxTotal).toBe(t.total);
    expect(t.discountTotal).toBe(200 + orderDiscount);
  });

  it("makes a refund mirror the sale exactly", () => {
    const sale = priceOrder([line({ unitPrice: 333, qty: 7 })], { taxes });
    const refund = priceOrder([line({ unitPrice: 333, qty: -7 })], { taxes });
    expect(refund.total).toBe(-sale.total);
    expect(refund.taxTotal).toBe(-sale.taxTotal);
  });

  it("handles out-of-scope items and rejects unknown taxes", () => {
    expect(priceOrder([line({ taxId: null })], { taxes }).taxTotal).toBe(0);
    expect(() => priceOrder([line({ taxId: "nope" })], { taxes })).toThrow(/Unknown tax/);
  });
});

describe("checkPayments", () => {
  it("rounds all-cash orders and computes change", () => {
    const c = checkPayments(1037, [{ id: "p", methodId: "m", kind: "cash", amount: 1025, tendered: 2000 }]);
    expect(c).toMatchObject({ due: 1025, cashRounding: -12, remaining: 0, change: 975, complete: true });
  });

  it("does not round when a card is involved", () => {
    const c = checkPayments(1037, [
      { id: "p1", methodId: "m1", kind: "cash", amount: 500 },
      { id: "p2", methodId: "m2", kind: "card", amount: 400 },
    ]);
    expect(c).toMatchObject({ due: 1037, remaining: 137, complete: false });
  });

  it("treats refunds (negative totals) as complete when fully paid out", () => {
    const c = checkPayments(-1050, [{ id: "p", methodId: "m", kind: "card", amount: -1050 }]);
    expect(c.complete).toBe(true);
  });
});

describe("receipt numbers", () => {
  it("formats and parses", () => {
    const n = formatReceiptNumber({ storeCode: "DXB1", registerCode: "R1", sessionSeq: 5, orderSeq: 12 });
    expect(n).toBe("DXB1-R1-0005-0012");
    expect(parseReceiptNumber(n)).toEqual({ storeCode: "DXB1", registerCode: "R1", sessionSeq: 5, orderSeq: 12 });
    expect(parseReceiptNumber("bad")).toBeNull();
  });
});

describe("display relay", () => {
  const state = { kind: "cart" as const, storeName: "S", lines: [], subtotalNet: 0, taxTotal: 0, discountTotal: 0, total: 0 };

  it("answers at once with a newer state and waits otherwise", async () => {
    const relay = new DisplayRelay();
    expect(await relay.get("r1", 0, 0)).toEqual({ version: 0, state: null });
    const waiting = relay.get("r1", 0, 5_000);
    relay.put("r1", state);
    expect(await waiting).toEqual({ version: 1, state });
    const t = Date.now();
    expect((await relay.get("r1", 1, 50)).version).toBe(1);
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
  });
});
