import { formatMoney, parseMoney } from "@pos/core";

export const money = (minor: number) => formatMoney(minor);
export const aed = (minor: number) => `AED ${formatMoney(minor)}`;

export function tryParseMoney(input: string): number | null {
  try {
    return input.trim() ? parseMoney(input.trim()) : null;
  } catch {
    return null;
  }
}

const TZ = "Asia/Dubai";
export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-AE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(new Date(iso));
export const time = (iso: string) => new Intl.DateTimeFormat("en-AE", { timeStyle: "short", timeZone: TZ }).format(new Date(iso));
export const dayLabel = (ymd: string) =>
  new Intl.DateTimeFormat("en-AE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
export const qty = (n: number | string) => {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
};
export const bp = (n: number) => `${(n / 100).toFixed(n % 100 ? 2 : 0)}%`;

/** "2 min ago", "3 h ago", or the date, for last-seen times. */
export function ago(iso: string | null): string {
  if (!iso) return "Never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return dateTime(iso);
}
