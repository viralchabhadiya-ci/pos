import type { DailySummary } from "./daily.js";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Fils to "1,234.50"; negatives keep their minus sign. */
export function money(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(fils);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** "+12%" against the comparison day, or null when there is nothing to compare with. */
export function change(now: number, before: number): string | null {
  if (!before) return null;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function longDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;

export const C = {
  fg: "#111a19",
  muted: "#4f5d5b",
  line: "#d3dcda",
  accent: "#0b6158",
  soft: "#eef2f1",
  good: "#1a6e33",
  bad: "#ad2219",
  warn: "#8f4b0c",
};

export function table(head: string[], rows: string[][], numeric: boolean[]): string {
  const th = head
    .map(
      (h, i) =>
        `<th style="text-align:${numeric[i] ? "right" : "left"};padding:6px 8px;border-bottom:1px solid ${C.line};color:${C.muted};font-weight:600;font-size:13px">${esc(h)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map(
            (c, i) =>
              `<td style="text-align:${numeric[i] ? "right" : "left"};padding:6px 8px;border-bottom:1px solid ${C.soft};font-size:14px${numeric[i] ? ";font-variant-numeric:tabular-nums;white-space:nowrap" : ""}">${c}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px">${`<tr>${th}</tr>`}${body}</table>`;
}

const section = (title: string, inner: string) =>
  `<h2 style="font-size:16px;margin:24px 0 8px;color:${C.fg}">${esc(title)}</h2>${inner}`;

/** The daily summary as an email: HTML for mail apps, plain text as the fallback. */
export function renderDailyEmail(s: DailySummary, opts: { appUrl?: string } = {}): RenderedEmail {
  const cur = s.currency;
  const t = s.totals;
  const vs = change(t.total, s.previous.total);
  const subject = `${s.tenantName}: ${cur} ${money(t.total)} sales on ${longDate(s.date)}`;

  // One row per figure: stays readable on a phone in every mail app, with no columns to squeeze.
  const stat = (label: string, value: string, note?: string | null) =>
    `<tr><td style="padding:10px 12px;background:${C.soft};border-radius:8px">
       <div style="font-size:13px;color:${C.muted}">${esc(label)}</div>
       <div style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:${C.fg}">${esc(value)}</div>
       ${note ? `<div style="font-size:13px;color:${C.muted}">${esc(note)}</div>` : ""}
     </td></tr><tr><td style="height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>`;
  const vsNote = vs ? `${vs} vs ${longDate(s.compareDate).split(",")[0]} last week` : "No sales the same day last week";

  const parts: string[] = [];
  parts.push(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">
      ${stat("Net sales", `${cur} ${money(t.total)}`, vsNote)}
      ${stat("Bills", String(t.orderCount), t.orderCount ? `Average ${cur} ${money(t.averageBasket)}` : null)}
      ${stat("VAT collected", `${cur} ${money(t.tax)}`, t.refundCount ? `${t.refundCount} refunds, ${cur} ${money(t.refunds)}` : "No refunds")}
    </table>`,
  );

  const attention = s.alerts.filter((a) => a.severity !== "low" || a.kind === "low_stock");
  if (attention.length) {
    const colour = { high: C.bad, medium: C.warn, low: C.muted } as const;
    parts.push(
      section(
        "Needs your attention",
        `<ul style="margin:0;padding-left:20px">${attention
          .map(
            (a) =>
              `<li style="margin:0 0 6px;color:${colour[a.severity]}"><strong>${esc(a.title)}</strong>${
                a.items.length
                  ? `<div style="color:${C.muted};font-size:13px">${a.items
                      .slice(0, 3)
                      .map((i) => esc(i.label))
                      .join(" · ")}</div>`
                  : ""
              }</li>`,
          )
          .join("")}</ul>`,
      ),
    );
  }

  if (s.stores.length > 1) {
    parts.push(
      section(
        "By store",
        table(
          ["Store", "Bills", "Sales"],
          s.stores.map((r) => [esc(r.name), String(r.orderCount), money(r.total)]),
          [false, true, true],
        ),
      ),
    );
  }
  if (s.payments.length) {
    parts.push(
      section(
        "Payments",
        table(
          ["Method", "Count", "Amount"],
          s.payments.map((r) => [esc(r.name), String(r.count), money(r.total)]),
          [false, true, true],
        ),
      ),
    );
  }
  if (s.topProducts.length) {
    parts.push(
      section(
        "Best sellers",
        table(
          ["Product", "Qty", "Sales"],
          s.topProducts.map((r) => [esc(r.name), String(r.qty), money(r.total)]),
          [false, true, true],
        ),
      ),
    );
  }
  if (s.cashiers.length) {
    parts.push(
      section(
        "Cashiers",
        table(
          ["Cashier", "Bills", "Refunds", "Sales"],
          s.cashiers.map((r) => [esc(r.name), String(r.orderCount), String(r.refundCount), money(r.total)]),
          [false, true, true, true],
        ),
      ),
    );
  }
  if (s.shifts.length) {
    parts.push(
      section(
        "Shifts closed",
        table(
          ["Register", "Closed by", "Expected", "Counted", "Over / short"],
          s.shifts.map((r) => [
            esc(r.register),
            esc(r.closedBy ?? ""),
            money(r.expected),
            money(r.counted),
            `<span style="color:${r.difference === 0 ? C.good : r.difference < 0 ? C.bad : C.warn}">${money(r.difference)}</span>`,
          ]),
          [false, false, true, true, true],
        ),
      ),
    );
  }
  const extra: string[] = [];
  if (s.busiestHour) extra.push(`Busiest hour: ${hourLabel(s.busiestHour.hour)} (${s.busiestHour.orderCount} bills)`);
  if (t.discounts) extra.push(`Discounts given: ${cur} ${money(t.discounts)}`);
  const a = s.approvals;
  if (a.approved + a.denied + a.expired) {
    extra.push(`Approvals: ${a.approved} approved, ${a.denied} denied, ${a.expired} not answered in time`);
  }
  if (extra.length) {
    parts.push(`<p style="margin:16px 0 0;color:${C.muted};font-size:14px">${extra.map(esc).join("<br>")}</p>`);
  }
  if (!t.orderCount && !t.refundCount) {
    parts.push(`<p style="margin:16px 0 0;color:${C.muted}">No sales were recorded on this day.</p>`);
  }

  const link = opts.appUrl
    ? `<p style="margin:24px 0 0"><a href="${esc(opts.appUrl)}" style="display:inline-block;background:${C.accent};color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Open the owner app</a></p>`
    : "";

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f4"><tr><td align="center" style="padding:16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:12px;font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:${C.fg}">
<tr><td style="padding:20px">
<div style="font-size:13px;color:${C.muted}">Daily summary · ${esc(s.tenantName)}</div>
<h1 style="font-size:22px;margin:4px 0 16px;overflow-wrap:anywhere">${esc(longDate(s.date))}</h1>
${parts.join("\n")}
${link}
<p style="margin:24px 0 0;font-size:12px;color:${C.muted}">Amounts in ${esc(cur)}, VAT included. Refunds are taken off sales. You get this email because daily summaries are on for you in the owner app.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const lines: string[] = [];
  lines.push(`Daily summary · ${s.tenantName}`, longDate(s.date), "");
  lines.push(`Net sales: ${cur} ${money(t.total)}${vs ? ` (${vs} vs last week)` : ""}`);
  lines.push(`Bills: ${t.orderCount}${t.orderCount ? `, average ${cur} ${money(t.averageBasket)}` : ""}`);
  lines.push(`VAT collected: ${cur} ${money(t.tax)}`);
  if (t.refundCount) lines.push(`Refunds: ${t.refundCount}, ${cur} ${money(t.refunds)}`);
  if (attention.length) {
    lines.push("", "Needs your attention:");
    for (const al of attention) lines.push(`- ${al.title}`);
  }
  if (s.stores.length > 1) {
    lines.push("", "By store:");
    for (const r of s.stores) lines.push(`- ${r.name}: ${r.orderCount} bills, ${money(r.total)}`);
  }
  if (s.payments.length) {
    lines.push("", "Payments:");
    for (const r of s.payments) lines.push(`- ${r.name}: ${r.count} payments, ${money(r.total)}`);
  }
  if (s.topProducts.length) {
    lines.push("", "Best sellers:");
    for (const r of s.topProducts) lines.push(`- ${r.name}: ${r.qty} sold, ${money(r.total)}`);
  }
  if (s.shifts.length) {
    lines.push("", "Shifts closed:");
    for (const r of s.shifts) lines.push(`- ${r.register}: expected ${money(r.expected)}, counted ${money(r.counted)}, ${money(r.difference)}`);
  }
  if (extra.length) lines.push("", ...extra);
  if (opts.appUrl) lines.push("", `Owner app: ${opts.appUrl}`);
  return { subject, html, text: lines.join("\n") + "\n" };
}
