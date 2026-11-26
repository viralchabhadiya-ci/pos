import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AR } from "./i18n.js";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("shop translations", () => {
  it("has Arabic for every string passed to t()", () => {
    const used = new Set<string>();
    for (const file of sources(join(__dirname, ".."))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((k) => !AR[k])).toEqual([]);
  });
});
