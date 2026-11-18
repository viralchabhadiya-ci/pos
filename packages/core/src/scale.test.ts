import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCALE_RULES,
  ean13CheckDigit,
  isValidEan13,
  makeScaleBarcode,
  normalizePlu,
  parseScaleBarcode,
  scaleLine,
  scaleRuleProblem,
} from "./scale.js";

describe("EAN-13", () => {
  it("works out check digits", () => {
    expect(ean13CheckDigit("544900000099")).toBe(6); // Coca-Cola 5449000000996
    expect(isValidEan13("5449000000996")).toBe(true);
    expect(isValidEan13("5449000000997")).toBe(false);
    expect(isValidEan13("544900000099")).toBe(false);
  });
});

describe("scale labels", () => {
  const weight = DEFAULT_SCALE_RULES[0]!;
  const price = DEFAULT_SCALE_RULES[1]!;

  it("reads a weight label", () => {
    const code = makeScaleBarcode(weight, "42", 1250);
    expect(code).toBe("2100042012509");
    expect(parseScaleBarcode(code, DEFAULT_SCALE_RULES)).toEqual({ rule: weight, plu: "42", value: 1250 });
  });

  it("reads a price label", () => {
    const code = makeScaleBarcode(price, "00042", 1999);
    expect(parseScaleBarcode(code, DEFAULT_SCALE_RULES)).toMatchObject({ plu: "42", value: 1999, rule: { kind: "price" } });
  });

  it("ignores ordinary barcodes, bad check digits and unknown prefixes", () => {
    expect(parseScaleBarcode("5449000000996", DEFAULT_SCALE_RULES)).toBeNull();
    expect(parseScaleBarcode("2100042012508", DEFAULT_SCALE_RULES)).toBeNull();
    expect(parseScaleBarcode(makeScaleBarcode({ prefix: "23", kind: "weight", pluLength: 5 }, "1", 1), DEFAULT_SCALE_RULES)).toBeNull();
  });

  it("prefers the longest prefix", () => {
    const rules = [{ prefix: "2", kind: "price" as const, pluLength: 6 }, weight];
    expect(parseScaleBarcode(makeScaleBarcode(weight, "7", 500), rules)?.rule).toBe(weight);
    expect(parseScaleBarcode(makeScaleBarcode(rules[0]!, "7", 500), rules)?.rule.kind).toBe("price");
  });

  it("checks rules", () => {
    expect(scaleRuleProblem(weight)).toBeNull();
    expect(scaleRuleProblem({ prefix: "31", kind: "weight", pluLength: 5 })).toMatch(/starting with 2/);
    expect(scaleRuleProblem({ prefix: "21", kind: "weight", pluLength: 7 })).toMatch(/4 to 6/);
    expect(scaleRuleProblem({ prefix: "211", kind: "weight", pluLength: 6 })).toMatch(/fewer than 4/);
  });

  it("normalizes item codes", () => {
    expect(normalizePlu("00042")).toBe("42");
    expect(normalizePlu("0")).toBe("0");
  });
});

describe("scaleLine", () => {
  const w = (value: number) => ({ rule: DEFAULT_SCALE_RULES[0]!, plu: "1", value });
  const p = (value: number) => ({ rule: DEFAULT_SCALE_RULES[1]!, plu: "1", value });

  it("puts a weighed item on the bill at the shelf price", () => {
    expect(scaleLine(w(1250), { price: 2000, uom: "kg" })).toEqual({ qty: 1.25, unitPrice: 2000 });
    expect(scaleLine(w(1250), { price: 2000, uom: "unit" })).toBeNull();
  });

  it("matches a price label to the fil", () => {
    // AED 25.00/kg, label AED 3.37: 0.135 kg at 25.00 would be 3.38, so the unit price moves.
    const line = scaleLine(p(337), { price: 2500, uom: "kg" })!;
    expect(line.qty).toBe(0.135);
    expect(Math.round(line.qty * line.unitPrice)).toBe(337);
    expect(scaleLine(p(500), { price: 2000, uom: "kg" })).toEqual({ qty: 0.25, unitPrice: 2000 });
  });

  it("sells a pre-packed tray as one piece at the label price", () => {
    expect(scaleLine(p(1850), { price: 0, uom: "unit" })).toEqual({ qty: 1, unitPrice: 1850 });
  });
});
