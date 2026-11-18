import { formatMoney, TillEventSchema } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { audit } from "./audit.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A bill can be emailed a few times (a typo, a second address), not used to send mail in bulk. */
const MAX_EMAILS_PER_BILL = 3;

const EmailSchema = z.object({
  to: z.string().trim().toLowerCase().email().max(200),
  userId: z.string().uuid().optional(),
});

/** Till events for the audit log, and emailing a customer the link to their receipt. */
export async function tillEventRoutes(app: FastifyInstance) {
  app.post("/till-events", async (req) => {
    const device = await app.authenticate(req);
    const e = TillEventSchema.parse(req.body);
    // Staff ids come from the till's copy of the staff list; one deleted since is kept as null
    // rather than refusing the event, which would block the till's queue.
    const known = await app.db.query<{ id: string; name: string }>("SELECT id, name FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [
      device.tenantId,
      [e.userId, e.approvedBy].filter(Boolean),
    ]);
    const name = (id: string | null | undefined) => known.rows.find((u) => u.id === id)?.name ?? null;
    const userId = name(e.userId) ? e.userId : null;
    const at = Date.parse(e.at) > Date.now() ? new Date().toISOString() : e.at;
    await app.db.query(
      `INSERT INTO audit_log (tenant_id, user_id, device_id, action, entity, entity_id, data, at)
       VALUES ($1, $2, $3, $4, 'till_event', $5, $6, $7)
       ON CONFLICT (tenant_id, entity_id) WHERE entity = 'till_event' DO NOTHING`,
      [
        device.tenantId,
        userId,
        device.deviceId,
        `till.${e.kind}`,
        e.id,
        JSON.stringify({
          summary: e.summary,
          amount: e.amount ?? null,
          sessionId: e.sessionId ?? null,
          approvedBy: name(e.approvedBy) ? e.approvedBy : null,
          approvedByName: name(e.approvedBy),
          approvalId: e.approvalId ?? null,
          storeId: device.storeId,
          registerId: device.registerId,
          ...(e.details ? { details: e.details } : {}),
        }),
        at,
      ],
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/receipts/:id/email", async (req) => {
    const device = await app.authenticate(req);
    const orderId = z.string().uuid().parse(req.params.id);
    const body = EmailSchema.parse(req.body);
    const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
    if (!publicUrl) throw new HttpError(409, "no_public_url", "Digital receipts are not set up on this server (PUBLIC_URL).");
    const sent = await app.db.query(
      "SELECT COUNT(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'receipt.email' AND entity = 'order' AND entity_id = $2",
      [device.tenantId, orderId],
    );
    if (sent.rows[0].n >= MAX_EMAILS_PER_BILL) throw new HttpError(429, "too_many", "This receipt has already been emailed 3 times.");
    // The bill may not have synced yet; the link works as soon as it does.
    const { rows } = await app.db.query(
      `SELECT s.name AS store_name, s.name_ar AS store_name_ar, o.number, o.total, o.tenant_id, o.store_id
         FROM stores s LEFT JOIN orders o ON o.id = $2 AND o.tenant_id = $3
        WHERE s.id = $1`,
      [device.storeId, orderId, device.tenantId],
    );
    const r = rows[0];
    const link = `${publicUrl}/r/${orderId}`;
    const store = r?.store_name ?? "the shop";
    const what = r?.number ? `Receipt ${r.number}${r.total !== null ? ` · AED ${formatMoney(Number(r.total))}` : ""}` : "Your receipt";
    await app.mailer.send({
      to: [body.to],
      subject: `Your receipt from ${store}`,
      text: `${what}\n\nThank you for shopping at ${store}. Your receipt (tax invoice): ${link}\n\nإيصالك من ${r?.store_name_ar ?? store}: ${link}\n`,
      html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#13201c;max-width:520px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 8px">${esc(store)}</h1>
<p style="margin:0 0 16px;color:#4a5752">${esc(what)}</p>
<p style="margin:0 0 24px">Thank you for shopping with us. Your receipt (tax invoice) is here:</p>
<p style="margin:0 0 24px"><a href="${esc(link)}" style="background:#0d5c4f;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">View receipt</a></p>
<p dir="rtl" lang="ar" style="margin:0 0 8px">شكراً لتسوقكم معنا. إيصالكم (فاتورة ضريبية) هنا: <a href="${esc(link)}">عرض الإيصال</a></p>
<p style="color:#6b7772;font-size:12px;margin-top:32px">${esc(link)}</p>
</body></html>`,
    });
    // Only the domain is kept, so the audit log does not collect customers' addresses.
    await audit(app.db, device, body.userId ?? null, "receipt.email", "order", orderId, { domain: body.to.split("@")[1] });
    return { ok: true };
  });
}
