import { describe, expect, it } from "vitest";
import { findByCode, searchByName } from "./match.js";

const lines = [
  { variantId: "a", name: "Al Ain Water 1.5L", uom: "unit", barcode: "6291001", extraBarcodes: ["6291999"], sku: "W15" },
  { variantId: "b", name: "Masafi Water 500ml", uom: "unit", barcode: "6292002", extraBarcodes: null, sku: null },
];

describe("matching a scan to a line", () => {
  it("uses the barcode, then extra barcodes, then the SKU", () => {
    expect(findByCode(lines, "6292002")?.variantId).toBe("b");
    expect(findByCode(lines, " 6291999 ")?.variantId).toBe("a");
    expect(findByCode(lines, "W15")?.variantId).toBe("a");
    expect(findByCode(lines, "nope")).toBeUndefined();
    expect(findByCode(lines, "")).toBeUndefined();
  });
  it("searches by every word of the name", () => {
    expect(searchByName(lines, "water").map((l) => l.variantId)).toEqual(["a", "b"]);
    expect(searchByName(lines, "masafi WATER").map((l) => l.variantId)).toEqual(["b"]);
    expect(searchByName(lines, "  ")).toEqual([]);
  });
});
