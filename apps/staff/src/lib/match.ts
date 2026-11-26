import type { Scannable } from "./types.js";

/** Finds the line a scanned or typed code belongs to: barcode, extra barcodes, then SKU. */
export function findByCode<T extends Scannable>(lines: T[], code: string): T | undefined {
  const c = code.trim();
  if (!c) return undefined;
  return lines.find((l) => l.barcode === c || (l.extraBarcodes ?? []).includes(c)) ?? lines.find((l) => l.sku === c);
}

/** Lines whose name has every word typed, for when the label is missing. */
export function searchByName<T extends Scannable>(lines: T[], text: string, limit = 8): T[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return lines.filter((l) => words.every((w) => l.name.toLowerCase().includes(w))).slice(0, limit);
}
