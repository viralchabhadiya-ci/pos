import { allocate, mulDiv } from "./money.js";
import { normalizeQty } from "./pricing.js";

/**
 * Promotions, worked out the same way on the till (offline too) and in the back office preview.
 *
 * Item promotions give each line at most one promotion, tried in priority order:
 * - percent_off: X% off matching items (optionally only from a minimum quantity).
 * - buy_x_get_y: buy X, get Y of the matching items at a discount (100% = free). The cheapest
 *   units in each group are the discounted ones.
 * - multi_buy: N matching units for a fixed price, e.g. 3 for AED 10.
 * Then one order promotion, the best one that qualifies:
 * - order_percent_off / order_amount_off, from a minimum spend.
 *
 * Lines with a manual discount, a price override or a negative quantity (returns) never take
 * a promotion, so discounts do not stack by accident. A promotion with a code (a coupon)
 * applies only when that code was entered.
 */

export type PromotionKind = "percent_off" | "buy_x_get_y" | "multi_buy" | "order_percent_off" | "order_amount_off";

export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  /** Which items count. Empty lists with all=false match nothing. Ignored for order promotions. */
  target: { all: boolean; categoryIds: string[]; productIds: string[] };
  /** percent_off, order_percent_off, and the discount on the "get" units of buy_x_get_y (10000 = free). */
  percentBp?: number | null;
  buyQty?: number | null;
  getQty?: number | null;
  bundleQty?: number | null;
  /** multi_buy price for bundleQty units, in minor units. */
  bundlePrice?: number | null;
  /** order_amount_off, in minor units. */
  amount?: number | null;
  /** Order promotions: minimum spend after item promotions. percent_off: ignored. */
  minSubtotal?: number | null;
  /** percent_off: minimum quantity of matching items in the cart. */
  minQty?: number | null;
  /** Coupon code; when set the promotion needs it. Compared without case. */
  code?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  /** Days of the week it runs (0 = Sunday), in the store's timezone. Empty or null: every day. */
  days?: number[] | null;
  /** Happy hour, "HH:MM" in the store's timezone. End before start wraps past midnight. */
  startTime?: string | null;
  endTime?: string | null;
  /** Stores it runs in. Empty or null: all stores. */
  storeIds?: string[] | null;
  /** Lower runs first. */
  priority: number;
  active: boolean;
}

export interface PromoLine {
  id: string;
  variantId: string | null;
  productId: string | null;
  categoryId: string | null;
  unitPrice: number;
  qty: number;
  uom: "unit" | "kg";
  /** A manual discount or price change; such lines keep that and take no promotion. */
  manual: boolean;
}

export interface PromoContext {
  now: Date;
  timezone: string;
  storeId: string;
  /** Coupon codes the cashier entered. */
  codes: string[];
  /** False when the cashier gave a discount on the whole sale by hand: no order promotion then. */
  orderPromotions?: boolean;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  amount: number;
  code: string | null;
}

export interface PromoResult {
  /** Discount per line id, with the item promotion that gave it (order promotions add to it). */
  lines: Record<string, { discount: number; promotionId: string | null }>;
  applied: AppliedPromotion[];
  /** Entered codes that matched no promotion running now, to tell the cashier. */
  unknownCodes: string[];
}

const ORDER_KINDS = new Set<PromotionKind>(["order_percent_off", "order_amount_off"]);

function localParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether a promotion runs at this moment in this store (code checks aside). */
export function promotionRunning(p: Promotion, ctx: Pick<PromoContext, "now" | "timezone" | "storeId">): boolean {
  if (!p.active) return false;
  const t = ctx.now.getTime();
  if (p.startsAt && t < Date.parse(p.startsAt)) return false;
  if (p.endsAt && t >= Date.parse(p.endsAt)) return false;
  if (p.storeIds?.length && !p.storeIds.includes(ctx.storeId)) return false;
  const local = localParts(ctx.now, ctx.timezone);
  if (p.startTime && p.endTime) {
    const s = toMinutes(p.startTime);
    const e = toMinutes(p.endTime);
    const inWindow = s <= e ? local.minutes >= s && local.minutes < e : local.minutes >= s || local.minutes < e;
    // A window that wraps past midnight belongs to the day it started on.
    const day = s > e && local.minutes < e ? (local.day + 6) % 7 : local.day;
    if (!inWindow) return false;
    if (p.days?.length && !p.days.includes(day)) return false;
  } else if (p.days?.length && !p.days.includes(local.day)) {
    return false;
  }
  return true;
}

function matches(p: Promotion, l: PromoLine): boolean {
  if (p.target.all) return true;
  if (l.productId && p.target.productIds.includes(l.productId)) return true;
  return !!l.categoryId && p.target.categoryIds.includes(l.categoryId);
}

interface Unit {
  lineId: string;
  price: number;
}

/** Every whole unit of the lines, dearest first, so the cheapest end up as the free ones. */
function units(lines: PromoLine[]): Unit[] {
  const out: Unit[] = [];
  for (const l of lines) for (let i = 0; i < Math.floor(l.qty); i++) out.push({ lineId: l.id, price: l.unitPrice });
  return out.sort((a, b) => b.price - a.price || a.lineId.localeCompare(b.lineId));
}

function itemDiscounts(p: Promotion, lines: PromoLine[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, v: number) => out.set(id, (out.get(id) ?? 0) + v);
  if (p.kind === "percent_off") {
    const bp = Math.min(p.percentBp ?? 0, 10_000);
    const qty = lines.reduce((s, l) => s + l.qty, 0);
    if (bp <= 0 || qty < (p.minQty ?? 0)) return out;
    for (const l of lines) add(l.id, mulDiv(mulDiv(l.unitPrice, Math.round(normalizeQty(l.qty) * 1000), 1000), bp, 10_000));
    return out;
  }
  const countable = lines.filter((l) => l.uom === "unit");
  if (p.kind === "buy_x_get_y") {
    const buy = p.buyQty ?? 0;
    const get = p.getQty ?? 0;
    const bp = Math.min(p.percentBp ?? 10_000, 10_000);
    if (buy < 1 || get < 1 || bp <= 0) return out;
    const all = units(countable);
    const group = buy + get;
    for (let g = 0; g + group <= all.length; g += group) {
      for (const u of all.slice(g + buy, g + group)) add(u.lineId, mulDiv(u.price, bp, 10_000));
    }
    // Lines that only made up a group (the "buy" units) are still taken by this promotion.
    if (out.size) for (const u of all.slice(0, Math.floor(all.length / group) * group)) if (!out.has(u.lineId)) out.set(u.lineId, 0);
    return out;
  }
  if (p.kind === "multi_buy") {
    const n = p.bundleQty ?? 0;
    const price = p.bundlePrice ?? -1;
    if (n < 2 || price < 0) return out;
    const all = units(countable);
    for (let g = 0; g + n <= all.length; g += n) {
      const set = all.slice(g, g + n);
      const full = set.reduce((s, u) => s + u.price, 0);
      const off = full - price;
      if (off <= 0) continue;
      allocate(off, set.map((u) => u.price)).forEach((v, i) => add(set[i]!.lineId, v));
    }
    return out;
  }
  return out;
}

export function applyPromotions(lines: PromoLine[], promotions: Promotion[], ctx: PromoContext): PromoResult {
  const codes = ctx.codes.map((c) => c.trim().toUpperCase()).filter(Boolean);
  const running = promotions
    .filter((p) => promotionRunning(p, ctx))
    .filter((p) => !p.code || codes.includes(p.code.trim().toUpperCase()))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const usedCodes = new Set(running.filter((p) => p.code).map((p) => p.code!.trim().toUpperCase()));
  const unknownCodes = codes.filter((c) => !usedCodes.has(c));

  const result: PromoResult["lines"] = {};
  const applied = new Map<string, AppliedPromotion>();
  const note = (p: Promotion, amount: number) => {
    const a = applied.get(p.id) ?? { promotionId: p.id, name: p.name, amount: 0, code: p.code ? p.code.trim().toUpperCase() : null };
    a.amount += amount;
    applied.set(p.id, a);
  };
  const eligible = lines.filter((l) => l.qty > 0 && !l.manual);
  const taken = new Set<string>();

  for (const p of running.filter((x) => !ORDER_KINDS.has(x.kind))) {
    const free = eligible.filter((l) => !taken.has(l.id) && matches(p, l));
    if (!free.length) continue;
    const got = itemDiscounts(p, free);
    let total = 0;
    for (const [id, v] of got) {
      taken.add(id);
      result[id] = { discount: v, promotionId: p.id };
      total += v;
    }
    if (total > 0) note(p, total);
  }

  // One order promotion: the best that qualifies on what is left to pay.
  const left = eligible.map((l) => mulDiv(l.unitPrice, Math.round(normalizeQty(l.qty) * 1000), 1000) - (result[l.id]?.discount ?? 0));
  const subtotal = left.reduce((s, v) => s + v, 0);
  let best: { p: Promotion; off: number } | null = null;
  for (const p of running.filter((x) => ORDER_KINDS.has(x.kind) && ctx.orderPromotions !== false)) {
    if (subtotal <= 0 || subtotal < (p.minSubtotal ?? 0)) continue;
    const off =
      p.kind === "order_percent_off" ? mulDiv(subtotal, Math.min(p.percentBp ?? 0, 10_000), 10_000) : Math.min(p.amount ?? 0, subtotal);
    if (off > 0 && (!best || off > best.off)) best = { p, off };
  }
  if (best) {
    allocate(best.off, left).forEach((v, i) => {
      const id = eligible[i]!.id;
      result[id] = { discount: (result[id]?.discount ?? 0) + v, promotionId: result[id]?.promotionId ?? null };
    });
    note(best.p, best.off);
  }

  for (const id of Object.keys(result)) if (result[id]!.discount === 0 && !result[id]!.promotionId) delete result[id];
  return { lines: result, applied: [...applied.values()].filter((a) => a.amount > 0), unknownCodes };
}
