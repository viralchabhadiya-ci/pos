/**
 * Verifies a cashier PIN offline. Parameters must match apps/api/src/security.ts:
 * PBKDF2-SHA256, 100,000 iterations, 32-byte key, hex salt and hash.
 */
const ITERATIONS = 100_000;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPin(pin: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: ITERATIONS },
    key,
    256,
  );
  return bytesToHex(bits);
}

export async function verifyPin(pin: string, saltHex: string, hashHex: string): Promise<boolean> {
  const candidate = await hashPin(pin, saltHex);
  if (candidate.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
