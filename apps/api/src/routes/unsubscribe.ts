import type { FastifyInstance } from "fastify";
import { z } from "zod";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const Token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const CHANNEL: Record<string, { en: string; ar: string; column: string }> = {
  email: { en: "emails", ar: "الرسائل الإلكترونية", column: "consent_email" },
  sms: { en: "text messages", ar: "الرسائل النصية", column: "consent_sms" },
  whatsapp: { en: "WhatsApp messages", ar: "رسائل واتساب", column: "consent_whatsapp" },
};

/**
 * The opt-out link in every marketing message. Opening it shows a button; only pressing it
 * unsubscribes, so link checkers in mail apps cannot unsubscribe people by accident. Email
 * apps' one-click unsubscribe (RFC 8058) posts straight to the same address.
 */
export async function unsubscribeRoutes(app: FastifyInstance) {
  const find = async (token: string) => {
    const t = Token.safeParse(token);
    if (!t.success) return null;
    const { rows } = await app.db.query(
      `SELECT m.customer_id, m.channel, t.name AS shop FROM campaign_messages m JOIN tenants t ON t.id = m.tenant_id WHERE m.token = $1`,
      [t.data],
    );
    return rows[0] ?? null;
  };

  app.get<{ Params: { token: string } }>("/u/:token", async (req, reply) => {
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("x-robots-tag", "noindex");
    const m = await find(req.params.token);
    if (!m) return reply.status(404).send(page("Link not valid", `<h1>This link is not valid</h1><p dir="rtl" lang="ar">هذا الرابط غير صالح</p>`));
    const ch = CHANNEL[m.channel]!;
    return page(
      "Unsubscribe",
      `<h1>Stop ${esc(ch.en)} from ${esc(m.shop)}?</h1>
       <p class="muted">You will still get your receipts.</p>
       <form method="post"><button type="submit">Unsubscribe</button></form>
       <p dir="rtl" lang="ar" class="ar">إيقاف ${esc(ch.ar)} من ${esc(m.shop)}؟ ستصلك الإيصالات كالمعتاد.</p>
       <form method="post" dir="rtl"><button type="submit" lang="ar">إلغاء الاشتراك</button></form>`,
    );
  });

  app.post<{ Params: { token: string } }>("/u/:token", async (req, reply) => {
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store");
    const m = await find(req.params.token);
    if (!m) return reply.status(404).send(page("Link not valid", `<h1>This link is not valid</h1>`));
    const ch = CHANNEL[m.channel]!;
    await app.db.query(`UPDATE customers SET ${ch.column} = false, consent_at = now(), consent_source = 'unsubscribe_link', updated_at = now() WHERE id = $1`, [
      m.customer_id,
    ]);
    await app.db.query(
      `INSERT INTO audit_log (tenant_id, action, entity, entity_id, data)
       SELECT tenant_id, 'customer.unsubscribe', 'customer', id::text, jsonb_build_object('channel', $2::text) FROM customers WHERE id = $1`,
      [m.customer_id, m.channel],
    );
    return page("Unsubscribed", `<h1>Done. No more ${esc(ch.en)} from ${esc(m.shop)}.</h1><p dir="rtl" lang="ar" class="ar">تم. لن تصلك ${esc(ch.ar)} بعد الآن.</p>`);
  });
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f3f5f4;--card:#fff;--fg:#111a19;--muted:#4f5d5b;--line:#d3dcda;--accent:#0b6158;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0e1514;--card:#161f1e;--fg:#e8efed;--muted:#a3b2af;--line:#2b3836;--accent:#3fb8a8;--on:#06201c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans","Noto Sans Arabic",sans-serif;padding:16px}
main{max-width:480px;margin:40px auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:20px;margin:0 0 8px}.muted{color:var(--muted)}.ar{margin-top:24px;font-size:17px}
button{font:inherit;font-weight:600;min-height:44px;padding:0 20px;border-radius:8px;border:0;background:var(--accent);color:var(--on);cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}
