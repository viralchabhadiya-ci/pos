import { formatMoney } from "@pos/core";

export const money = (minor: number) => formatMoney(minor);
export const aed = (minor: number) => `AED ${formatMoney(minor)}`;

const TZ = "Asia/Dubai";
export const time = (iso: string) => new Intl.DateTimeFormat("en-AE", { timeStyle: "short", timeZone: TZ }).format(new Date(iso));
const dubaiDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
/** Just the time for today, the weekday and time for earlier days. */
export const when = (iso: string, now = Date.now()) =>
  dubaiDay(new Date(iso)) === dubaiDay(new Date(now))
    ? time(iso)
    : new Intl.DateTimeFormat("en-AE", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TZ }).format(new Date(iso));
export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-AE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(new Date(iso));
export const dayLabel = (ymd: string) =>
  new Intl.DateTimeFormat("en-AE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${ymd}T00:00:00Z`),
  );
export const longDay = (ymd: string) =>
  new Intl.DateTimeFormat("en-AE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${ymd}T00:00:00Z`),
  );

/** "Just now", "4 min ago", "3 h ago", then the date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return dateTime(iso);
}

/** Time left on an approval request, e.g. "4:05 left", or null once it has run out. */
export function timeLeft(expiresAt: string, now = Date.now()): string | null {
  const secs = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (secs <= 0) return null;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} left`;
}

/** "+12%" against a comparison value, or null when there is nothing to compare with. */
export function change(now: number, before: number): string | null {
  if (!before) return null;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export const APPROVAL_KIND: Record<string, string> = {
  refund: "Refund",
  discount: "Discount",
  void: "Void",
  price_override: "Price change",
  cash_out: "Cash out",
  no_sale: "Open drawer",
  other: "Request",
};
