import { formatMoney } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const Id = z.string().uuid();

/**
 * The digital receipt behind the QR code. The order id is a random UUID made on the till,
 * so the link itself is the key; it shows nothing but this one receipt.
 */
export async function receiptPageRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/r/:id", async (req, reply) => {
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("x-robots-tag", "noindex");
    const id = Id.safeParse(req.params.id);
    const { rows } = id.success
      ? await app.db.query(
          `SELECT o.*, s.name AS store_name, s.name_ar AS store_name_ar, s.address, s.trn, s.timezone, s.receipt_footer,
                  u.name AS cashier_name, ro.number AS original_number, c.name AS customer_name, c.trn AS customer_trn
             FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.cashier_id
             LEFT JOIN orders ro ON ro.id = o.refund_of_order_id LEFT JOIN customers c ON c.id = o.customer_id
            WHERE o.id = $1`,
          [id.data],
        )
      : { rows: [] };
    const o = rows[0];
    if (!o) {
      reply.status(404);
      return page(
        "Receipt",
        `<main class="card"><h1>Receipt not found yet</h1><p>If you just paid, the shop may still be sending it. Try again in a few minutes.</p>
         <p dir="rtl" lang="ar">لم يتم العثور على الإيصال بعد. إذا دفعت للتو، حاول مرة أخرى بعد بضع دقائق.</p></main>`,
      );
    }
    const lines = await app.db.query("SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no", [o.id]);
    const pays = await app.db.query(
      "SELECT p.amount, p.tendered, p.change, m.name FROM payments p JOIN payment_methods m ON m.id = p.method_id WHERE p.order_id = $1",
      [o.id],
    );
    const vat = await app.db.query(
      "SELECT tax_rate_bp, SUM(net)::int AS net, SUM(tax)::int AS tax FROM order_lines WHERE order_id = $1 GROUP BY tax_rate_bp ORDER BY tax_rate_bp",
      [o.id],
    );
    const refund = o.refund_of_order_id !== null;
    const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: o.timezone }).format(o.created_at);
    const m = (n: number) => formatMoney(n);
    const qty = (q: string) => (Number.isInteger(Number(q)) ? String(Math.abs(Number(q))) : Math.abs(Number(q)).toFixed(3));
    const body = `
<main class="card">
  <header>
    <h1>${esc(o.store_name)}</h1>
    ${o.store_name_ar ? `<p class="ar" dir="rtl" lang="ar">${esc(o.store_name_ar)}</p>` : ""}
    ${o.address ? `<p class="muted">${esc(o.address)}</p>` : ""}
    ${o.trn ? `<p class="muted">TRN ${esc(o.trn)}</p>` : ""}
    <p class="doc">${refund ? "Tax Credit Note · إشعار دائن ضريبي" : "Tax Invoice · فاتورة ضريبية"}</p>
  </header>
  <dl class="meta">
    <dt>No.</dt><dd>${esc(o.number)}</dd>
    <dt>Date</dt><dd>${esc(date)}</dd>
    ${refund ? `<dt>Original invoice</dt><dd>${esc(o.original_number)}</dd>` : ""}
    <dt>Cashier</dt><dd>${esc(o.cashier_name)}</dd>
    ${o.customer_name ? `<dt>Customer</dt><dd>${esc(o.customer_name)}${o.customer_trn ? ` · TRN ${esc(o.customer_trn)}` : ""}</dd>` : ""}
  </dl>
  <table>
    <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Amount</th></tr></thead>
    <tbody>${lines.rows
      .map(
        (l) =>
          `<tr><td>${esc(l.name)}${l.note ? `<br><small class="muted">${esc(l.note)}</small>` : ""}<br><small class="muted">${m(l.unit_price)} each${
            l.line_discount + l.order_discount ? ` · discount ${m(Math.abs(l.line_discount + l.order_discount))}` : ""
          }</small></td><td class="n">${qty(l.qty)}</td><td class="n">${m(l.gross)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>
  <dl class="totals">
    <dt>Total excl. VAT</dt><dd>${m(o.subtotal_net)}</dd>
    ${vat.rows.map((v) => `<dt>VAT ${v.tax_rate_bp === null ? "0" : v.tax_rate_bp / 100}%</dt><dd>${m(v.tax)}</dd>`).join("")}
    <dt class="grand">Total AED</dt><dd class="grand">${m(o.total)}</dd>
    ${o.cash_rounding ? `<dt>Cash rounding</dt><dd>${m(o.cash_rounding)}</dd>` : ""}
  </dl>
  <dl class="pays">${pays.rows
    .map((p) => `<dt>${esc(p.name)}</dt><dd>${m(p.tendered ?? p.amount)}${p.change ? ` · change ${m(p.change)}` : ""}</dd>`)
    .join("")}</dl>
  ${o.receipt_footer ? `<p class="foot">${esc(o.receipt_footer)}</p>` : ""}
</main>`;
    return page(`${refund ? "Credit note" : "Receipt"} ${o.number}`, body);
  });
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f3f5f4;--card:#fff;--fg:#111a19;--muted:#4f5d5b;--line:#d3dcda;--accent:#0b6158}
@media (prefers-color-scheme:dark){:root{--bg:#0e1514;--card:#161f1e;--fg:#e8efed;--muted:#a3b2af;--line:#2b3836;--accent:#3fb8a8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans","Noto Sans Arabic",sans-serif;padding:16px}
.card{max-width:520px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:22px;margin:0;text-align:center}header p{margin:2px 0;text-align:center}.ar{font-size:18px}.muted{color:var(--muted)}
.doc{font-weight:700;color:var(--accent);margin-top:12px!important}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:16px 0}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}dt{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th{text-align:left;font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);padding:6px 0}
td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}.n{text-align:right;white-space:nowrap;padding-left:12px}
.grand{font-weight:700;font-size:18px;color:var(--fg)}.foot{text-align:center;color:var(--muted);margin-top:16px}
</style></head><body>${body}</body></html>`;
}
