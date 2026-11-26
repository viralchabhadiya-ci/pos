import { createHash } from "node:crypto";
import { formatMoney } from "@pos/core";
import type { Db } from "../db.js";
import { grossOf, taxMap } from "../routes/shop.js";

/** When a slide or offer shows: dates, days of the week (0 = Sunday) and hours, in the store's time. */
export interface Schedule {
  startsOn?: string | null;
  endsOn?: string | null;
  days?: number[] | null;
  startTime?: string | null;
  endTime?: string | null;
}
/** The store's own date, weekday and time of day. */
export interface LocalNow {
  date: string;
  dow: number;
  time: string;
}

/** Whether a schedule is on now. Hours may run past midnight (22:00 to 02:00). */
export function liveNow(s: Schedule, now: LocalNow): boolean {
  if (s.startsOn && now.date < s.startsOn) return false;
  if (s.endsOn && now.date > s.endsOn) return false;
  if (s.days?.length && !s.days.includes(now.dow)) return false;
  const from = s.startTime ?? null;
  const to = s.endTime ?? null;
  if (from && to) return from <= to ? now.time >= from && now.time < to : now.time >= from || now.time < to;
  if (from) return now.time >= from;
  if (to) return now.time < to;
  return true;
}

const pct = (bp: number) => String(Math.round(bp) / 100).replace(/\.0+$/, "");

interface PromoRow {
  kind: string;
  percent_bp: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  bundle_qty: number | null;
  bundle_price: number | null;
  amount: number | null;
  min_subtotal: number | null;
  code: string | null;
}

/** The deal in a few words, in English and Arabic, for an offer slide. */
export function describeDeal(p: PromoRow): { en: string[]; ar: string[] } {
  const en: string[] = [];
  const ar: string[] = [];
  const m = (fils: number | null) => formatMoney(fils ?? 0);
  switch (p.kind) {
    case "percent_off":
      en.push(`${pct(p.percent_bp ?? 0)}% off`);
      ar.push(`خصم ${pct(p.percent_bp ?? 0)}%`);
      break;
    case "buy_x_get_y":
      en.push(`Buy ${p.buy_qty}, get ${p.get_qty} free`);
      ar.push(`اشترِ ${p.buy_qty} واحصل على ${p.get_qty} مجاناً`);
      break;
    case "multi_buy":
      en.push(`${p.bundle_qty} for AED ${m(p.bundle_price)}`);
      ar.push(`${p.bundle_qty} بسعر ${m(p.bundle_price)} درهم`);
      break;
    case "order_percent_off":
      en.push(`${pct(p.percent_bp ?? 0)}% off your shopping`);
      ar.push(`خصم ${pct(p.percent_bp ?? 0)}% على مشترياتك`);
      break;
    case "order_amount_off":
      en.push(`AED ${m(p.amount)} off your shopping`);
      ar.push(`خصم ${m(p.amount)} درهم على مشترياتك`);
      break;
  }
  if (p.min_subtotal) {
    en.push(`When you spend AED ${m(p.min_subtotal)} or more`);
    ar.push(`عند الشراء بقيمة ${m(p.min_subtotal)} درهم أو أكثر`);
  }
  if (p.code) {
    en.push(`Use code ${p.code}`);
    ar.push(`استخدم الرمز ${p.code}`);
  }
  return { en, ar };
}

export type FeedSlide =
  | { id: string; kind: "image"; duration: number; mediaId: string }
  | { id: string; kind: "video"; duration: number; url: string }
  | { id: string; kind: "message"; duration: number; theme: string; title: string | null; titleAr: string | null; body: string | null; bodyAr: string | null }
  | {
      id: string;
      kind: "promo";
      duration: number;
      theme: string;
      title: string;
      titleAr: string | null;
      deal: string[];
      dealAr: string[];
      until: string | null;
    }
  | {
      id: string;
      kind: "prices";
      duration: number;
      theme: string;
      title: string | null;
      titleAr: string | null;
      products: { name: string; nameAr: string | null; price: string; uom: string | null }[];
    };

export interface Feed {
  screen: { name: string; orientation: "landscape" | "portrait"; lang: "en" | "ar" | "both"; store: string; storeAr: string | null };
  slides: FeedSlide[];
  /** Changes whenever what is on screen would change, so the TV only restarts when it must. */
  version: string;
  /** The TV asks again after this many seconds. */
  refresh: number;
}

export interface ScreenRow {
  id: string;
  tenant_id: string;
  store_id: string;
  name: string;
  playlist_id: string | null;
  orientation: "landscape" | "portrait";
  lang: "en" | "ar" | "both";
}

/** Most products one price board slide lists; it pages through them on screen. */
const MAX_BOARD = 48;

/** What a screen shows right now: its playlist's slides that are on at this hour. */
export async function screenFeed(db: Db, screen: ScreenRow): Promise<Feed> {
  const { rows: st } = await db.query(
    `SELECT s.name, s.name_ar, s.price_list_id, to_char(now() AT TIME ZONE s.timezone, 'YYYY-MM-DD') AS date,
            extract(dow FROM now() AT TIME ZONE s.timezone)::int AS dow, to_char(now() AT TIME ZONE s.timezone, 'HH24:MI') AS time,
            s.timezone
       FROM stores s WHERE s.id = $1`,
    [screen.store_id],
  );
  const store = st[0]!;
  const now: LocalNow = { date: store.date, dow: store.dow, time: store.time };
  const slides: FeedSlide[] = [];
  const rows = screen.playlist_id
    ? (await db.query(`SELECT *, starts_on::text AS s_on, ends_on::text AS e_on FROM signage_slides WHERE playlist_id = $1 AND active ORDER BY position, id`, [screen.playlist_id])).rows
    : [];
  let taxes: Awaited<ReturnType<typeof taxMap>> | null = null;

  for (const r of rows) {
    const sched = { startsOn: r.s_on, endsOn: r.e_on, days: r.days, startTime: r.start_time, endTime: r.end_time };
    if (!liveNow(sched, now)) continue;
    const base = { id: r.id as string, duration: r.duration as number };
    if (r.kind === "image") slides.push({ ...base, kind: "image", mediaId: r.media_id });
    else if (r.kind === "video") slides.push({ ...base, kind: "video", url: r.video_url });
    else if (r.kind === "message") slides.push({ ...base, kind: "message", theme: r.theme, title: r.title, titleAr: r.title_ar, body: r.body, bodyAr: r.body_ar });
    else if (r.kind === "promo") {
      const { rows: pr } = await db.query(
        `SELECT p.*, to_char(p.ends_at AT TIME ZONE $3, 'YYYY-MM-DD') AS ends_on,
                (p.starts_at IS NULL OR p.starts_at <= now()) AND (p.ends_at IS NULL OR p.ends_at > now()) AS in_dates
           FROM promotions p WHERE p.id = $1 AND p.tenant_id = $2`,
        [r.promotion_id, screen.tenant_id, store.timezone],
      );
      const p = pr[0];
      // An offer that has ended, is switched off, used up or not for this store is left out.
      if (!p || !p.active || !p.in_dates || (p.max_uses && p.uses >= p.max_uses)) continue;
      if (p.store_ids?.length && !p.store_ids.includes(screen.store_id)) continue;
      if (!liveNow({ days: p.days, startTime: p.start_time, endTime: p.end_time }, now)) continue;
      const deal = describeDeal(p);
      slides.push({ ...base, kind: "promo", theme: r.theme, title: r.title || p.name, titleAr: r.title_ar, deal: deal.en, dealAr: deal.ar, until: p.ends_on });
    } else if (r.kind === "prices") {
      taxes ??= await taxMap(db, screen.tenant_id);
      const { rows: ps } = await db.query(
        `SELECT p.name, p.name_ar AS "nameAr", p.uom, p.tax_id AS "taxId", COALESCE(pli.price, v.price) AS price
           FROM products p
           JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id AND v.active ORDER BY v.id LIMIT 1) v ON true
           LEFT JOIN price_list_items pli ON pli.price_list_id = $3 AND pli.variant_id = v.id AND pli.active
          WHERE p.tenant_id = $1 AND p.active AND ($4::uuid IS NULL OR p.category_id = $4)
            AND NOT EXISTS (SELECT 1 FROM store_hidden_products h WHERE h.store_id = $2 AND h.product_id = p.id)
          ORDER BY p.name LIMIT ${MAX_BOARD}`,
        [screen.tenant_id, screen.store_id, store.price_list_id, r.category_id],
      );
      if (!ps.length) continue;
      const cat = r.category_id ? (await db.query(`SELECT name, name_ar FROM categories WHERE id = $1`, [r.category_id])).rows[0] : null;
      slides.push({
        ...base,
        kind: "prices",
        theme: r.theme,
        title: r.title || cat?.name || null,
        titleAr: r.title_ar || cat?.name_ar || null,
        products: ps.map((x) => ({ name: x.name, nameAr: x.nameAr, uom: x.uom, price: formatMoney(grossOf(Number(x.price), x.taxId, taxes!)) })),
      });
    }
  }
  const out = {
    screen: { name: screen.name, orientation: screen.orientation, lang: screen.lang, store: store.name, storeAr: store.name_ar },
    slides,
  };
  return { ...out, version: createHash("sha1").update(JSON.stringify(out)).digest("base64url").slice(0, 16), refresh: 60 };
}
