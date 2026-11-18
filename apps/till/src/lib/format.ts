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

/**
 * A phone number as WhatsApp links want it: digits with the country code. UAE numbers
 * written the local way (050 123 4567) get 971; anything too short to be a number is null.
 */
export function whatsappNumber(phone: string): string | null {
  let digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `971${digits.slice(1)}`;
  else if (/^5\d{8}$/.test(digits)) digits = `971${digits}`;
  digits = digits.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
