/**
 * Barcodes printed by a shop's own scale. The EAN-13 numbers that start with 2 are kept for
 * use inside a shop (GS1 "restricted circulation"), and scales print them as
 *   prefix · item code (PLU) · weight in grams, or price in fils · check digit
 * e.g. 21 00042 01250 9 = item 42, 1.250 kg. Each business says which prefixes its scales use.
 */

export type ScaleValueKind = "weight" | "price";

export interface ScaleBarcodeRule {
  /** The first 1 to 3 digits, e.g. "21". */
  prefix: string;
  /** What the digits after the item code mean: grams, or fils. */
  kind: ScaleValueKind;
  /** How many digits the item code (PLU) has, 4 to 6. The value takes what is left. */
  pluLength: number;
}

/** What most scales sold in the UAE are set to out of the box. */
export const DEFAULT_SCALE_RULES: ScaleBarcodeRule[] = [
  { prefix: "21", kind: "weight", pluLength: 5 },
  { prefix: "22", kind: "price", pluLength: 5 },
];

/** The EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** A rule's problems, for the settings form; empty when it is fine. */
export function scaleRuleProblem(rule: ScaleBarcodeRule): string | null {
  if (!/^2\d{0,2}$/.test(rule.prefix)) return "The prefix must be 1 to 3 digits starting with 2.";
  if (!Number.isInteger(rule.pluLength) || rule.pluLength < 4 || rule.pluLength > 6) return "The item code must be 4 to 6 digits.";
  if (12 - rule.prefix.length - rule.pluLength < 4) return "That leaves fewer than 4 digits for the weight or price.";
  return null;
}

export interface ScaleBarcode {
  rule: ScaleBarcodeRule;
  /** The item code, without leading zeros, as the scale knows the product. */
  plu: string;
  /** Grams for a weight label, fils for a price label. */
  value: number;
}

/**
 * Reads a scale label. Null when the code is not an EAN-13 with a valid check digit or no
 * rule's prefix matches. The longest matching prefix wins, so "21" and "2" can both be set.
 */
export function parseScaleBarcode(code: string, rules: ScaleBarcodeRule[]): ScaleBarcode | null {
  if (!isValidEan13(code)) return null;
  const rule = [...rules].sort((a, b) => b.prefix.length - a.prefix.length).find((r) => code.startsWith(r.prefix) && !scaleRuleProblem(r));
  if (!rule) return null;
  const pluDigits = code.slice(rule.prefix.length, rule.prefix.length + rule.pluLength);
  const valueDigits = code.slice(rule.prefix.length + rule.pluLength, 12);
  return { rule, plu: normalizePlu(pluDigits), value: Number(valueDigits) };
}

/** "00042" and "42" are the same item code. */
export function normalizePlu(plu: string): string {
  const trimmed = plu.trim().replace(/^0+(?=\d)/, "");
  return trimmed;
}

/** Makes a scale label's barcode, e.g. for tests and for printing labels for pre-weighed packs. */
export function makeScaleBarcode(rule: ScaleBarcodeRule, plu: string, value: number): string {
  const valueLength = 12 - rule.prefix.length - rule.pluLength;
  const p = normalizePlu(plu).padStart(rule.pluLength, "0");
  const v = String(Math.round(value)).padStart(valueLength, "0");
  if (p.length > rule.pluLength || v.length > valueLength) throw new Error("Item code or value too long for this rule");
  const first12 = `${rule.prefix}${p}${v}`;
  return `${first12}${ean13CheckDigit(first12)}`;
}

/**
 * The quantity and unit price a scale label puts on the bill.
 * - Weight label on a product sold by the kg: that weight at the shelf price.
 * - Price label on a product sold by the kg: the weight is worked back from the price; when that
 *   weight (to the gram) times the shelf price does not land on the label's price, the unit price
 *   is nudged so the bill shows exactly what the label says.
 * - Price label on a product sold by the piece (a pre-packed tray): one piece at the label's price.
 * Null for a weight label on a product sold by the piece, which makes no sense.
 */
export function scaleLine(label: ScaleBarcode, item: { price: number; uom: "unit" | "kg" }): { qty: number; unitPrice: number } | null {
  if (label.rule.kind === "weight") {
    if (item.uom !== "kg" || label.value <= 0) return null;
    return { qty: label.value / 1000, unitPrice: item.price };
  }
  if (label.value <= 0) return null;
  if (item.uom === "unit" || item.price <= 0) return { qty: 1, unitPrice: label.value };
  const qty = Math.max(1, Math.round((label.value / item.price) * 1000)) / 1000;
  if (Math.round(qty * item.price) === label.value) return { qty, unitPrice: item.price };
  const nudged = Math.round(label.value / qty);
  return { qty, unitPrice: Math.round(qty * nudged) === label.value ? nudged : item.price };
}
