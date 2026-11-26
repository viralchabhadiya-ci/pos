import type { FastifyInstance } from "fastify";
import { formatMoney } from "@pos/core";

export type WebOrderNotice = "placed" | "ready" | "cancelled";

/** The customer's page for an order, when the shop app's address is known (SHOP_URL). */
export function orderLink(slug: string, token: string, base = process.env.SHOP_URL) {
  return base ? `${base.replace(/\/$/, "")}/#/${slug}/order/${token}` : null;
}

/**
 * Tells the customer about their order: by email when they gave one, otherwise by SMS.
 * These are service messages about something they asked for, so marketing consent does not
 * apply. Failures are logged by the caller; the order itself is never held up.
 */
export async function notifyWebOrder(app: FastifyInstance, id: string, kind: WebOrderNotice) {
  const { rows } = await app.db.query(
    `SELECT w.number, w.name, w.phone, w.email, w.total, w.token, w.pickup_code AS "pickupCode", w.cancel_reason AS "cancelReason",
            o.slug, o.ready_minutes AS "readyMinutes", t.name AS shop, s.name AS store, s.address
       FROM web_orders w JOIN online_stores o ON o.tenant_id = w.tenant_id JOIN tenants t ON t.id = w.tenant_id JOIN stores s ON s.id = w.store_id
      WHERE w.id = $1`,
    [id],
  );
  const w = rows[0];
  if (!w) return;
  const first = String(w.name).trim().split(/\s+/)[0];
  const link = orderLink(w.slug, w.token);
  const where = w.address ? `${w.store}, ${w.address}` : w.store;
  const text =
    kind === "placed"
      ? `Hi ${first}, ${w.shop} has your order ${w.number} (AED ${formatMoney(w.total)}, pay when you collect). We'll message you when it is ready at ${where}.`
      : kind === "ready"
        ? `Hi ${first}, your order ${w.number} is ready at ${where}. Pickup code ${w.pickupCode}. AED ${formatMoney(w.total)} to pay at the counter.`
        : `Hi ${first}, your order ${w.number} at ${w.shop} was cancelled${w.cancelReason ? `: ${w.cancelReason}` : ""}. Sorry about that.`;
  const body = link ? `${text}\n${link}` : text;
  const subject =
    kind === "placed" ? `Order ${w.number} received` : kind === "ready" ? `Order ${w.number} is ready to collect` : `Order ${w.number} cancelled`;
  if (w.email) await app.senders.email.send({ to: w.email, subject: `${subject} · ${w.shop}`, text: body });
  else await app.senders.sms.send({ to: w.phone, text: body });
}
