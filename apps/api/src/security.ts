import { createHash, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * PINs use PBKDF2-SHA256 so the till can verify them offline with WebCrypto using the
 * same parameters. Keep these in sync with apps/till/src/lib/pin.ts.
 */
export const PIN_ITERATIONS = 100_000;
const PIN_KEY_BYTES = 32;

export function hashPin(pin: string, saltHex = randomBytes(16).toString("hex")): { salt: string; hash: string } {
  const hash = pbkdf2Sync(pin, Buffer.from(saltHex, "hex"), PIN_ITERATIONS, PIN_KEY_BYTES, "sha256").toString("hex");
  return { salt: saltHex, hash };
}

export function verifyPin(pin: string, saltHex: string, hashHex: string): boolean {
  const candidate = Buffer.from(hashPin(pin, saltHex).hash, "hex");
  const expected = Buffer.from(hashHex, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Device tokens are random and only their SHA-256 is stored. */
export function newDeviceToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 6-digit pairing code shown as a QR on the till; short-lived and single use. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
