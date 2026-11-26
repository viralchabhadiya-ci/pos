import { formatMoney } from "@pos/core";

export const aed = (fils: number) => `AED ${formatMoney(fils)}`;

/** Quantities: whole pieces without decimals, weights to the gram. */
export const qty = (n: number, uom = "unit") => (uom === "kg" ? `${n.toFixed(3)} kg` : Number.isInteger(n) ? String(n) : n.toFixed(3));

export function shortDate(iso: string | null): string {
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-AE", { day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(new Date(iso));
}
