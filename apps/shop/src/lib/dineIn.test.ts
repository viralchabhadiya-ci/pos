import { describe, expect, it } from "vitest";
import { addPick, lineKey, setPickQty } from "../DineIn.js";

describe("guest order lines", () => {
  it("keeps one line per item made the same way, whatever order the choices were tapped", () => {
    let lines = addPick([], "v1", ["b", "a"]);
    lines = addPick(lines, "v1", ["a", "b"]);
    lines = addPick(lines, "v1", []);
    expect(lines.map((l) => [l.key, l.qty])).toEqual([
      [lineKey("v1", ["a", "b"]), 2],
      ["v1", 1],
    ]);
    expect(setPickQty(lines, "v1", 0).length).toBe(1);
    expect(setPickQty(lines, "v1", 80).find((l) => l.key === "v1")!.qty).toBe(50);
  });
});
