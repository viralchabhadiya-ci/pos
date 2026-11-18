import { describe, expect, it } from "vitest";
import { whatsappNumber } from "./format.js";

describe("whatsappNumber", () => {
  it("adds the UAE country code to local numbers", () => {
    expect(whatsappNumber("050 123 4567")).toBe("971501234567");
    expect(whatsappNumber("501234567")).toBe("971501234567");
  });
  it("keeps international numbers", () => {
    expect(whatsappNumber("+971 50 123 4567")).toBe("971501234567");
    expect(whatsappNumber("00919812345678")).toBe("919812345678");
    expect(whatsappNumber("971501234567")).toBe("971501234567");
  });
  it("refuses what cannot be a phone number", () => {
    expect(whatsappNumber("12345")).toBeNull();
    expect(whatsappNumber("")).toBeNull();
  });
});
