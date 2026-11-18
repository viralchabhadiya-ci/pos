import { describe, expect, it } from "vitest";
import { barsFor, CODE128, code128, ean13 } from "./barcode.js";

const str = (m: boolean[]) => m.map((b) => (b ? "1" : "0")).join("");

describe("EAN-13", () => {
  it("draws 95 modules with guards and the right parity", () => {
    const b = ean13("5449000000996");
    expect(b.modules).toHaveLength(95);
    const s = str(b.modules);
    expect(s.slice(0, 3)).toBe("101");
    expect(s.slice(45, 50)).toBe("01010");
    expect(s.slice(92)).toBe("101");
    // First digit 5 → parity LGGLLG: the digit 4 in position 2 uses the L code 0100011.
    expect(s.slice(3, 10)).toBe("0100011");
    // Position 3 (digit 4) uses the G code 0011101.
    expect(s.slice(10, 17)).toBe("0011101");
  });

  it("refuses a bad check digit", () => {
    expect(() => ean13("5449000000997")).toThrow();
  });
});

describe("Code 128", () => {
  it("has 11-module symbols", () => {
    for (const w of CODE128) expect([...w].reduce((a, b) => a + Number(b), 0)).toBe(11);
    expect(CODE128).toHaveLength(106);
  });

  it("encodes text with its check symbol", () => {
    // Start B (104) + "A" (33): check (104 + 33) % 103 = 34.
    const b = code128("A");
    expect(b.modules).toHaveLength(11 * 3 + 13);
    expect(str(b.modules).slice(0, 11)).toBe("11010010000"); // Start B, 211214
    expect(str(b.modules).slice(-13)).toBe("1100011101011"); // Stop, 2331112
  });

  it("chooses EAN-13 for retail codes and Code 128 for the rest", () => {
    expect(barsFor("5449000000996").kind).toBe("ean13");
    expect(barsFor("SKU-12").kind).toBe("code128");
    expect(barsFor("2100001000000").kind).toBe("code128"); // no valid check digit
  });
});
