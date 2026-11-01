import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "./pin.js";

describe("offline PIN check", () => {
  it("matches the server's PBKDF2 hash", async () => {
    const salt = "00112233445566778899aabbccddeeff";
    const server = pbkdf2Sync("1234", Buffer.from(salt, "hex"), 100_000, 32, "sha256").toString("hex");
    expect(await hashPin("1234", salt)).toBe(server);
    expect(await verifyPin("1234", salt, server)).toBe(true);
    expect(await verifyPin("4321", salt, server)).toBe(false);
  });
});
