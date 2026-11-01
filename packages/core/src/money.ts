/**
 * All money is held as integer minor units (fils for AED: 1 AED = 100 fils).
 * Never use floats for amounts that are stored or summed.
 */

/** Rounds half away from zero, so refunds (negative amounts) mirror sales exactly. */
export function roundHalfAway(value: number): number {
  const rounded = Math.round(Math.abs(value));
  return value < 0 ? -rounded : rounded;
}

/** Multiplies an integer amount by a ratio num/den and rounds half away from zero. */
export function mulDiv(amount: number, num: number, den: number): number {
  return roundHalfAway((amount * num) / den);
}

/** Formats minor units for display, e.g. 1050 -> "10.50". */
export function formatMoney(minor: number, decimals = 2): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const factor = 10 ** decimals;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(decimals, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

/** Parses a user-entered amount like "10.5" into minor units (1050). */
export function parseMoney(input: string, decimals = 2): number {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === "-" || trimmed === ".") {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace("-", "").split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const extra = frac.length > decimals ? Number(frac[decimals]) : 0;
  let minor = Number(whole || "0") * 10 ** decimals + Number(fracPadded || "0");
  if (extra >= 5) minor += 1;
  return negative ? -minor : minor;
}

/** Rounds a cash total to the nearest step (e.g. 25 fils). Returns the rounded total and the adjustment. */
export function roundCash(total: number, step: number): { rounded: number; adjustment: number } {
  if (step <= 1) return { rounded: total, adjustment: 0 };
  const rounded = roundHalfAway(total / step) * step;
  return { rounded, adjustment: rounded - total };
}

/**
 * Splits `amount` across `weights` proportionally so the parts always sum to `amount`
 * (largest remainder method). Used to spread an order discount over its lines.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((s, w) => s + Math.abs(w), 0);
  if (totalWeight === 0 || amount === 0) return weights.map(() => 0);
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const raw = weights.map((w) => (abs * Math.abs(w)) / totalWeight);
  const parts = raw.map((r) => Math.floor(r));
  let remainder = abs - parts.reduce((s, p) => s + p, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    remainder -= 1;
  }
  return parts.map((p) => p * sign);
}
