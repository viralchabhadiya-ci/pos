import { describe, expect, it } from "vitest";
import { ago, change, timeLeft } from "./format.js";
import { parseHash } from "./router.js";

describe("owner app helpers", () => {
  const now = Date.parse("2026-11-18T08:00:00Z");
  it("says how long ago", () => {
    expect(ago(null, now)).toBe("Never");
    expect(ago("2026-11-18T07:59:45Z", now)).toBe("Just now");
    expect(ago("2026-11-18T07:45:00Z", now)).toBe("15 min ago");
    expect(ago("2026-11-18T05:00:00Z", now)).toBe("3 h ago");
  });
  it("counts down an approval", () => {
    expect(timeLeft("2026-11-18T08:04:05Z", now)).toBe("4:05 left");
    expect(timeLeft("2026-11-18T07:59:00Z", now)).toBeNull();
  });
  it("compares with last week", () => {
    expect(change(150, 100)).toBe("+50%");
    expect(change(80, 100)).toBe("-20%");
    expect(change(5, 0)).toBeNull();
  });
  it("reads the tab from the address", () => {
    expect(parseHash("#/approvals")).toBe("approvals");
    expect(parseHash("#/nope")).toBe("today");
    expect(parseHash("")).toBe("today");
  });
});

describe("bill times", () => {
  it("shows the weekday for earlier days", async () => {
    const { when } = await import("./format.js");
    const now = Date.parse("2026-11-18T08:00:00Z");
    expect(when("2026-11-18T05:00:00Z", now)).not.toMatch(/Tue|Wed/);
    expect(when("2026-11-17T17:58:00Z", now)).toMatch(/^Tue/);
  });
});
