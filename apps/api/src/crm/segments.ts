import { z } from "zod";

/**
 * Rules for a segment. Every rule set must hold (AND). Amounts are fils, VAT included, net of
 * refunds; "window" limits spend and visit counts to the last N days.
 */
export const SegmentRulesSchema = z
  .object({
    minSpent: z.number().int().min(0).max(1_000_000_000).nullish(),
    maxSpent: z.number().int().min(0).max(1_000_000_000).nullish(),
    minOrders: z.number().int().min(0).max(100_000).nullish(),
    windowDays: z.number().int().min(1).max(3650).nullish(),
    lastVisitWithinDays: z.number().int().min(1).max(3650).nullish(),
    notVisitedForDays: z.number().int().min(1).max(3650).nullish(),
    minPoints: z.number().int().min(0).max(100_000_000).nullish(),
    tagsAny: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).nullish(),
    birthdayThisMonth: z.boolean().nullish(),
    storeId: z.string().uuid().nullish(),
    neverBought: z.boolean().nullish(),
  })
  .strict();
export type SegmentRules = z.infer<typeof SegmentRulesSchema>;

/**
 * SQL for the customers a segment holds, as `SELECT c.* ...` pieces. $1 is the tenant; more
 * parameters are pushed onto `params`. `tz` is a SQL expression for the business's timezone.
 */
export function segmentSql(rules: SegmentRules, params: unknown[], tz: string) {
  const p = (v: unknown) => `$${params.push(v)}`;
  const orderScope = [
    "o.customer_id = c.id",
    rules.storeId ? `o.store_id = ${p(rules.storeId)}` : null,
    rules.windowDays ? `o.created_at >= now() - make_interval(days => ${p(rules.windowDays)})` : null,
  ]
    .filter(Boolean)
    .join(" AND ");
  const where = ["c.tenant_id = $1"];
  if (rules.minSpent !== null && rules.minSpent !== undefined) where.push(`st.spent >= ${p(rules.minSpent)}`);
  if (rules.maxSpent !== null && rules.maxSpent !== undefined) where.push(`st.spent <= ${p(rules.maxSpent)}`);
  if (rules.minOrders) where.push(`st.orders >= ${p(rules.minOrders)}`);
  if (rules.lastVisitWithinDays) where.push(`lv.at >= now() - make_interval(days => ${p(rules.lastVisitWithinDays)})`);
  if (rules.notVisitedForDays) where.push(`(lv.at IS NOT NULL AND lv.at < now() - make_interval(days => ${p(rules.notVisitedForDays)}))`);
  if (rules.neverBought) where.push("lv.at IS NULL");
  if (rules.minPoints) where.push(`c.points >= ${p(rules.minPoints)}`);
  if (rules.tagsAny?.length) where.push(`c.tags && ${p(rules.tagsAny)}::text[]`);
  if (rules.birthdayThisMonth) where.push(`c.birth_month = EXTRACT(MONTH FROM now() AT TIME ZONE ${tz})`);
  if (rules.storeId) where.push("st.orders > 0");
  return {
    from: `customers c
      LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS orders, COALESCE(SUM(o.total), 0)::int AS spent
                           FROM orders o WHERE ${orderScope}) st ON true
      LEFT JOIN LATERAL (SELECT MAX(o.created_at) AS at FROM orders o WHERE o.customer_id = c.id) lv ON true`,
    where: where.join(" AND "),
  };
}

export type Channel = "email" | "sms" | "whatsapp";

/** Who a channel can reach: consent given and an address to send to. */
export const reachable = (channel: Channel) =>
  channel === "email" ? "c.consent_email AND c.email IS NOT NULL" : channel === "sms" ? "c.consent_sms AND c.phone IS NOT NULL" : "c.consent_whatsapp AND c.phone IS NOT NULL";

/**
 * A UAE mobile number in international form (+9715XXXXXXXX), from the ways people write it:
 * 050 123 4567, 00971501234567, 971501234567. Other countries keep their + form. Null when
 * it is not a number a message can go to.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = `+${d.slice(2)}`;
  if (/^05\d{8}$/.test(d)) return `+971${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `+971${d}`;
  if (/^9715\d{8}$/.test(d)) return `+${d}`;
  if (/^\+9715\d{8}$/.test(d)) return d;
  if (/^\+971/.test(d)) return null; // A UAE landline or a typo; marketing goes to mobiles only.
  if (/^\+\d{8,15}$/.test(d)) return d;
  return null;
}
