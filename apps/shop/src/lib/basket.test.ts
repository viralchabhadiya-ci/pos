import { describe, expect, it } from "vitest";
import { setQty, stepOf } from "./basket.js";

describe("basket", () => {
  it("adds, changes and removes items", () => {
    let b = setQty({}, "a", 2);
    b = setQty(b, "b", 0.5);
    expect(b).toEqual({ a: 2, b: 0.5 });
    b = setQty(b, "a", 0);
    expect(b).toEqual({ b: 0.5 });
    expect(setQty(b, "b", 0.1 + 0.2)).toEqual({ b: 0.3 });
    expect(setQty({}, "x", 5000)).toEqual({ x: 999 });
  });

  it("moves weighed items in half kilos", () => {
    expect(stepOf("kg")).toBe(0.5);
    expect(stepOf("unit")).toBe(1);
  });
});
