import { formatMoney, parseMoney } from "@pos/core";

export const money = (minor: number) => formatMoney(minor);
export const aed = (minor: number) => `AED ${formatMoney(minor)}`;

export function tryParseMoney(input: string): number | null {
  try {
    return parseMoney(input);
  } catch {
    return null;
  }
}

export const qtyText = (qty: number, uom: "unit" | "kg") => (uom === "kg" ? `${qty.toFixed(3)} kg` : String(qty));
