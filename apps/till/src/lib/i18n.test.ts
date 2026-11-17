import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AR, getLang, itemCount, setLang, t } from "./i18n.js";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("till translations", () => {
  it("has Arabic for every literal string passed to t()", () => {
    const used = new Set<string>();
    for (const file of sources(SRC)) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(m[1]!);
      // t(cond ? "a" : "b") forms
      for (const m of code.matchAll(/\bt\(\s*[\w.!=\s"]+\?\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        used.add(m[1]!);
        used.add(m[2]!);
      }
    }
    // Keys built at runtime.
    for (const k of ["Qty", "% Disc", "Price", "Paid by cash", "Paid by card", "Paid by card manual", "{n} item", "{n} items"]) used.add(k);
    expect(used.size).toBeGreaterThan(100);
    const missing = [...used].filter((k) => !(k in AR));
    expect(missing).toEqual([]);
  });

  it("keeps placeholders in every Arabic string", () => {
    for (const [en, ar] of Object.entries(AR)) {
      const want = (en.match(/\{\w+\}/g) ?? []).sort();
      expect((ar.match(/\{\w+\}/g) ?? []).sort(), en).toEqual(want);
    }
  });

  it("switches language, fills placeholders and sets the page direction", () => {
    expect(getLang()).toBe("en");
    expect(t("Shift {n}", { n: 3 })).toBe("Shift 3");
    setLang("ar");
    expect(t("Shift {n}", { n: 3 })).toBe("الوردية 3");
    expect(itemCount(1)).toBe("1 صنف");
    expect(t("Not translated")).toBe("Not translated");
    setLang("en");
    expect(itemCount(2)).toBe("2 items");
  });
});
