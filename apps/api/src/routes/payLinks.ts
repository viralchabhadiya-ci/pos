import { randomBytes } from "node:crypto";
import { formatMoney } from "@pos/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { DeviceContext } from "../app.js";
import { HttpError } from "../errors.js";
import { LINK_PROVIDERS, type LinkProviderId, type LinkRequest, type LinkResult, type LinkStatus } from "../payments/links.js";
import { audit } from "./audit.js";
import { esc, page } from "./receiptPage.js";

const FINAL = new Set<LinkStatus>(["paid", "declined", "expired", "cancelled", "failed"]);
const Provider = z.enum(Object.keys(LINK_PROVIDERS) as [LinkProviderId, ...LinkProviderId[]]);

const StartSchema = z.object({
  /** Made on the till, so pressing twice gives the one link. */
  id: z.string().uuid(),
  provider: Provider,
  amount: z.number().int().positive().max(100_000_000),
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  /** Where to text the link; without it the customer scans the QR code. */
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{7,20}$/, "Enter a phone number like +971 50 123 4567")
    .nullish()
    .transform((v) => (v ? v.replace(/\s+/g, "") : null)),
  /** Also send it on WhatsApp rather than SMS. */
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
});

const RefundSchema = z.object({
  id: z.string().uuid(),
  /** The original link payment the money goes back to. */
  refundOf: z.string().uuid(),
  amount: z.number().int().positive().max(100_000_000),
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const payUrl = (token: string) => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/pay/${token}` : `/pay/${token}`);

/** What the till sees about a link. */
function view(r: Record<string, unknown>) {
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    amount: r.amount,
    status: r.status,
    url: (r.checkout_url as string | null) ?? payUrl(r.token as string),
    providerRef: r.provider_ref ?? null,
    message: r.message ?? null,
    expiresAt: r.expires_at,
    phone: r.phone ?? null,
  };
}

/**
 * Paying on the customer's phone at the till: Tabby, Tamara or a card payment link. The till
 * shows the QR code (the customer display too) or texts the link, and asks here until it is paid.
 */
export async function payLinkRoutes(app: FastifyInstance) {
  const provider = (id: string) => {
    const p = app.linkProviders.get(id as LinkProviderId);
    if (!p) throw new HttpError(503, "provider_unavailable", `${id} is not set up on this server`);
    return p;
  };
  const request = (r: Record<string, unknown>, originalRef?: string | null): LinkRequest => ({
    id: r.id as string,
    kind: r.kind as "sale" | "refund",
    amount: r.amount as number,
    currency: "AED",
    token: r.token as string,
    phone: (r.phone as string | null) ?? null,
    originalRef,
  });
  /** A final answer is never overwritten, so a late status can't undo a payment. */
  async function save(id: string, res: LinkResult) {
    const { rows } = await app.db.query(
      `UPDATE payment_links SET status = $2, provider_ref = COALESCE($3, provider_ref), checkout_url = COALESCE($4, checkout_url), message = COALESCE($5, message),
              paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END, updated_at = now()
        WHERE id = $1 AND status NOT IN ('paid', 'declined', 'expired', 'cancelled', 'failed') RETURNING *`,
      [id, res.status, res.providerRef ?? null, res.checkoutUrl ?? null, res.message ?? null],
    );
    return rows[0] ?? (await app.db.query("SELECT * FROM payment_links WHERE id = $1", [id])).rows[0];
  }
  async function load(device: DeviceContext, id: string) {
    const { rows } = await app.db.query("SELECT * FROM payment_links WHERE id = $1 AND tenant_id = $2 AND store_id = $3", [id, device.tenantId, device.storeId]);
    if (!rows[0]) throw new HttpError(404, "not_found", "Payment link not found");
    return rows[0];
  }
  const till = async (req: Parameters<typeof app.authenticate>[0], userId: string) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can take payments");
    const u = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND active", [userId, device.tenantId]);
    if (!u.rowCount) throw new HttpError(400, "bad_request", "Unknown cashier");
    return device;
  };

  app.post("/pay-links", async (req) => {
    const b = StartSchema.parse(req.body);
    const device = await till(req, b.userId);
    const existing = await app.db.query("SELECT * FROM payment_links WHERE id = $1 AND tenant_id = $2", [b.id, device.tenantId]);
    if (existing.rows[0]) return view(existing.rows[0]);
    const method = await app.db.query("SELECT 1 FROM payment_methods WHERE tenant_id = $1 AND provider = $2 AND active", [device.tenantId, b.provider]);
    if (!method.rowCount) throw new HttpError(409, "not_enabled", `${LINK_PROVIDERS[b.provider].label} is not switched on. Turn it on in the back office under Online payments.`);
    const settings = (await app.db.query("SELECT * FROM online_payment_settings WHERE tenant_id = $1", [device.tenantId])).rows[0] ?? { link_minutes: 15, bnpl_min: 10_000, bnpl_max: 500_000 };
    if (LINK_PROVIDERS[b.provider].kind === "bnpl" && (b.amount < settings.bnpl_min || b.amount > settings.bnpl_max)) {
      throw new HttpError(409, "amount_out_of_range", `${LINK_PROVIDERS[b.provider].label} takes bills from AED ${formatMoney(settings.bnpl_min)} to AED ${formatMoney(settings.bnpl_max)}`);
    }
    const { rows } = await app.db.query(
      `INSERT INTO payment_links (id, tenant_id, store_id, register_id, provider, kind, amount, token, phone, order_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'sale', $6, $7, $8, $9, $10, now() + make_interval(mins => $11)) RETURNING *`,
      [b.id, device.tenantId, device.storeId, device.registerId, b.provider, b.amount, randomBytes(18).toString("base64url"), b.phone, b.orderId, b.userId, settings.link_minutes],
    );
    let row = rows[0];
    try {
      row = await save(row.id, await provider(b.provider).create(request(row)));
    } catch (err) {
      row = await save(row.id, { status: "failed", message: (err as Error).message });
    }
    await audit(app.db, device, b.userId, "pay_link.create", "payment_link", row.id, { provider: b.provider, amount: b.amount, phone: b.phone ? "yes" : "no" });
    if (b.phone && row.status === "pending") {
      const store = (await app.db.query("SELECT name FROM stores WHERE id = $1", [device.storeId])).rows[0];
      const text = `${store.name}: pay AED ${formatMoney(b.amount)} with ${LINK_PROVIDERS[b.provider].label} here: ${view(row).url}`;
      await (b.channel === "whatsapp" ? app.senders.whatsapp : app.senders.sms).send({ to: b.phone, text }).catch((err) => app.log.error(err, "payment link message failed"));
    }
    return view(row);
  });

  /** The till asks every few seconds. An open link past its time expires. */
  app.get<{ Params: { id: string } }>("/pay-links/:id", async (req) => {
    const device = await app.authenticate(req);
    let row = await load(device, z.string().uuid().parse(req.params.id));
    if (!FINAL.has(row.status)) {
      if (new Date(row.expires_at) <= new Date()) row = await save(row.id, { status: "expired", message: "The link expired" });
      else {
        try {
          row = await save(row.id, await provider(row.provider).status(request(row), row.status));
        } catch (err) {
          app.log.warn(err, "payment link status failed");
        }
      }
    }
    return view(row);
  });

  app.post<{ Params: { id: string } }>("/pay-links/:id/cancel", async (req) => {
    const b = z.object({ userId: z.string().uuid() }).parse(req.body);
    const device = await till(req, b.userId);
    let row = await load(device, z.string().uuid().parse(req.params.id));
    if (!FINAL.has(row.status)) {
      // The provider may answer that the customer just paid; then it stays paid.
      row = await save(row.id, await provider(row.provider).cancel(request(row)).catch(() => ({ status: "cancelled" as const })));
      await audit(app.db, device, b.userId, "pay_link.cancel", "payment_link", row.id, { status: row.status });
    }
    return view(row);
  });

  /** Money back to the customer's Tabby, Tamara or card, for a refund at the till. */
  app.post("/pay-links/refunds", async (req) => {
    const b = RefundSchema.parse(req.body);
    const device = await till(req, b.userId);
    const existing = await app.db.query("SELECT * FROM payment_links WHERE id = $1 AND tenant_id = $2", [b.id, device.tenantId]);
    if (existing.rows[0]) return view(existing.rows[0]);
    const orig = (await app.db.query("SELECT * FROM payment_links WHERE id = $1 AND tenant_id = $2 AND kind = 'sale'", [b.refundOf, device.tenantId])).rows[0];
    if (!orig || orig.status !== "paid") throw new HttpError(409, "not_paid", "That payment was not made by link, so it can't be refunded to it");
    const done = await app.db.query("SELECT COALESCE(SUM(amount), 0)::int AS n FROM payment_links WHERE refund_of = $1 AND status = 'paid'", [orig.id]);
    if (done.rows[0].n + b.amount > orig.amount) throw new HttpError(409, "too_much", `Only AED ${formatMoney(orig.amount - done.rows[0].n)} is left to refund on that payment`);
    const { rows } = await app.db.query(
      `INSERT INTO payment_links (id, tenant_id, store_id, register_id, provider, kind, amount, token, order_id, refund_of, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'refund', $6, $7, $8, $9, $10, now()) RETURNING *`,
      [b.id, device.tenantId, device.storeId, device.registerId, orig.provider, b.amount, randomBytes(18).toString("base64url"), b.orderId, orig.id, b.userId],
    );
    let row = rows[0];
    try {
      row = await save(row.id, await provider(row.provider).create(request(row, orig.provider_ref)));
    } catch (err) {
      row = await save(row.id, { status: "failed", message: (err as Error).message });
    }
    await audit(app.db, device, b.userId, "pay_link.refund", "payment_link", row.id, { provider: row.provider, amount: b.amount, status: row.status });
    return view(row);
  });

  // The customer's page. With the simulator it is the checkout itself.
  app.get<{ Params: { token: string } }>("/pay/:token", async (req, reply) => checkout(req.params.token, reply));
  app.post<{ Params: { token: string } }>("/pay/:token", async (req, reply) => {
    const outcome = z.object({ outcome: z.enum(["paid", "declined"]) }).safeParse(req.body);
    const t = await app.db.query("SELECT * FROM payment_links WHERE token = $1 AND kind = 'sale'", [req.params.token]);
    const row = t.rows[0];
    if (row && outcome.success && row.status === "pending" && !row.checkout_url && new Date(row.expires_at) > new Date()) {
      await save(row.id, { status: outcome.data.outcome, message: outcome.data.outcome === "paid" ? "Paid by the customer" : "Declined by the customer" });
    }
    return reply.redirect(`/pay/${encodeURIComponent(req.params.token)}`, 303);
  });

  async function checkout(token: string, reply: FastifyReply) {
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("x-robots-tag", "noindex");
    const { rows } = await app.db.query(
      `SELECT l.*, s.name AS store_name, s.name_ar AS store_name_ar FROM payment_links l JOIN stores s ON s.id = l.store_id WHERE l.token = $1 AND l.kind = 'sale'`,
      [token],
    );
    const l = rows[0];
    if (!l) {
      reply.status(404);
      return page("Payment", `<main class="card"><h1>This payment link is not valid</h1><p dir="rtl" lang="ar">رابط الدفع هذا غير صالح</p></main>`);
    }
    if (l.checkout_url && l.status === "pending") return reply.redirect(l.checkout_url, 302);
    const p = LINK_PROVIDERS[l.provider as LinkProviderId];
    const expired = l.status === "pending" && new Date(l.expires_at) <= new Date();
    const split = p.instalments > 1 ? Math.ceil(l.amount / p.instalments) : null;
    const state =
      l.status === "paid"
        ? `<p class="ok">Paid. Thank you! You can go back to the counter.</p><p class="ok" dir="rtl" lang="ar">تم الدفع. شكرًا لك!</p>`
        : l.status === "pending" && !expired
          ? `<form method="post"><input type="hidden" name="outcome" value="paid"><button class="pay">Pay AED ${formatMoney(l.amount)}</button></form>
             <form method="post"><input type="hidden" name="outcome" value="declined"><button class="decline">Decline</button></form>
             <p class="muted small">Test checkout: no money moves. The real ${esc(p.label)} page opens here once the shop's account is connected.</p>`
          : `<p class="bad">${expired || l.status === "expired" ? "This link has expired. Ask the cashier for a new one." : l.status === "declined" ? "The payment was declined." : "This payment was cancelled."}</p>`;
    return page(
      `Pay ${l.store_name}`,
      `<main class="card"><header><h1>${esc(l.store_name)}</h1>${l.store_name_ar ? `<p class="ar" dir="rtl" lang="ar">${esc(l.store_name_ar)}</p>` : ""}
        <p class="doc">${esc(p.label)}</p></header>
        <p class="amount">AED ${formatMoney(l.amount)}</p>
        ${split ? `<p class="muted center">${p.instalments} payments of AED ${formatMoney(split)}, the first today · ${p.instalments} دفعات</p>` : ""}
        ${state}</main>
        <style>.amount{font-size:40px;font-weight:700;text-align:center;margin:16px 0 4px;font-variant-numeric:tabular-nums}.center{text-align:center}.small{font-size:13px;text-align:center}
        form{margin:12px 0}button{width:100%;min-height:52px;border-radius:12px;font:inherit;font-weight:700;font-size:18px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
        .pay{background:var(--accent);color:#fff;border-color:var(--accent)}.ok{color:var(--accent);font-weight:700;text-align:center}.bad{color:#ad2219;font-weight:700;text-align:center}</style>`,
    );
  }
}
