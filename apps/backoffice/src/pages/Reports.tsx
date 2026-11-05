import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, download, errorText } from "../lib/api.js";
import { aed, bp, money, qty } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";

type GroupBy = "product" | "category" | "cashier" | "payment" | "day";
type Tab = GroupBy | "vat";

const TABS: { id: Tab; label: string }[] = [
  { id: "product", label: "Products" },
  { id: "category", label: "Categories" },
  { id: "cashier", label: "Cashiers" },
  { id: "payment", label: "Payments" },
  { id: "day", label: "Days" },
  { id: "vat", label: "VAT return" },
];

interface Column {
  key: string;
  label: string;
  money?: boolean;
}
interface SalesReport {
  columns: Column[];
  rows: Record<string, string | number | null>[];
}
interface VatRow {
  kind: "standard" | "zero" | "exempt" | "none";
  rateBp: number;
  salesNet: number;
  salesVat: number;
  refundNet: number;
  refundVat: number;
  net: number;
  vat: number;
}
interface VatReport {
  rows: VatRow[];
  boxes: { standardRated: { amount: number; vat: number }; zeroRated: { amount: number }; exempt: { amount: number }; outOfScope: { amount: number } };
}

/** Dates in Dubai time, since the shops count their days there. */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);

function presets() {
  const today = ymd(new Date());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const d = new Date(`${today}T00:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const lastMonthStart = new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
  const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return [
    { label: "Today", from: today, to: today },
    { label: "This week", from: iso(monday), to: today },
    { label: "This month", from: firstOfMonth, to: today },
    { label: "Last month", from: iso(lastMonthStart), to: iso(lastMonthEnd) },
  ];
}

const KIND_LABEL: Record<VatRow["kind"], string> = {
  standard: "Standard rated",
  zero: "Zero rated",
  exempt: "Exempt",
  none: "No VAT set",
};

export function Reports() {
  const [tab, setTab] = useState<Tab>("product");
  const [range, setRange] = useState(() => presets()[2]!);
  const toast = useToast();
  const q = `from=${range.from}&to=${range.to}`;

  const report = useLoad<SalesReport | VatReport>(
    () => (tab === "vat" ? api<VatReport>(`/reports/vat?${q}`) : api<SalesReport>(`/reports/sales?${q}&groupBy=${tab}`)),
    [tab, q],
  );

  const exportCsv = () => {
    const path = tab === "vat" ? `/reports/vat?${q}&format=csv` : `/reports/sales?${q}&groupBy=${tab}&format=csv`;
    const name = tab === "vat" ? `vat-${range.from}-to-${range.to}.csv` : `sales-by-${tab}-${range.from}-to-${range.to}.csv`;
    download(path, name).catch((err) => toast(errorText(err)));
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">Sales net of refunds, by store day. Download any report as CSV for Excel or your accountant.</p>
        </div>
        <button type="button" className="btn" onClick={exportCsv} disabled={!report.data}>
          <Icon name="download" /> Download CSV
        </button>
      </header>

      <div className="filters">
        <div className="chips" role="group" aria-label="Quick dates">
          {presets().map((p) => (
            <button
              key={p.label}
              type="button"
              className="chip"
              aria-pressed={p.from === range.from && p.to === range.to}
              onClick={() => setRange(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="inline-label">
          <span>From</span>
          <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value, label: "" })} />
        </label>
        <label className="inline-label">
          <span>To</span>
          <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value, label: "" })} />
        </label>
      </div>

      <div
        className="tabs"
        role="tablist"
        aria-label="Report"
        onKeyDown={(e) => {
          // Arrow keys move between tabs, as screen reader users expect.
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          const i = TABS.findIndex((t) => t.id === tab);
          const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
          setTab(next.id);
          document.getElementById(`tab-${next.id}`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="report-panel"
            className="tab"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section id="report-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} aria-busy={report.loading}>
        {report.error ? (
          <ErrorState message={report.error} onRetry={report.reload} />
        ) : !report.data || report.loading ? (
          <SkeletonRows />
        ) : tab === "vat" ? (
          <VatView data={report.data as VatReport} />
        ) : (
          <SalesTable data={report.data as SalesReport} />
        )}
      </section>
    </div>
  );
}

/** On a phone the table keeps the name and the last (total) column; CSV has everything. */
const hideOnPhone = (i: number, count: number) => (i > 0 && i < count - 1 ? "hide-sm" : "");

function SalesTable({ data }: { data: SalesReport }) {
  if (!("columns" in data)) return null;
  if (data.rows.length === 0) {
    return (
      <EmptyState icon="chart" title="No sales in these dates">
        <p className="muted">Pick a wider range, or check that the tills have synced.</p>
      </EmptyState>
    );
  }
  const totals = data.columns.map((c) =>
    c.money || c.key === "qty" || c.key === "orders" || c.key === "count" || c.key === "refunds"
      ? data.rows.reduce((n, r) => n + Number(r[c.key] ?? 0), 0)
      : null,
  );
  const cell = (c: Column, v: string | number | null) => (c.money ? money(Number(v ?? 0)) : c.key === "qty" ? qty(Number(v ?? 0)) : (v ?? "—"));
  const isNum = (c: Column) => c.money || ["qty", "orders", "count", "refunds"].includes(c.key);
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Sales report</caption>
        <thead>
          <tr>
            {data.columns.map((c, i) => (
              <th key={c.key} scope="col" className={[isNum(c) ? "num" : "", hideOnPhone(i, data.columns.length)].join(" ")}>
                {c.label}
                {c.money ? " (AED)" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, idx) => (
            <tr key={String(r.id ?? idx)}>
              {data.columns.map((c, i) => (
                <td
                  key={c.key}
                  className={[isNum(c) ? "num" : "", hideOnPhone(i, data.columns.length), i === data.columns.length - 1 ? "strong" : ""].join(" ")}
                >
                  {cell(c, r[c.key] ?? null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            {data.columns.map((c, i) => (
              <td key={c.key} className={[isNum(c) ? "num" : "", hideOnPhone(i, data.columns.length), "strong"].join(" ")}>
                {i === 0 ? "Total" : totals[i] === null ? "" : c.money ? money(totals[i]!) : qty(totals[i]!)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function VatView({ data }: { data: VatReport }) {
  if (!("boxes" in data)) return null;
  const b = data.boxes;
  return (
    <>
      <div className="kpis vat-boxes">
        <div className="kpi">
          <span className="kpi-label">Standard rated supplies</span>
          <span className="kpi-value num">{aed(b.standardRated.amount)}</span>
          <span className="kpi-note">Box 1 amount</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">VAT on sales</span>
          <span className="kpi-value num">{aed(b.standardRated.vat)}</span>
          <span className="kpi-note">Box 1 VAT</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Zero rated supplies</span>
          <span className="kpi-value num">{aed(b.zeroRated.amount)}</span>
          <span className="kpi-note">Box 4</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Exempt supplies</span>
          <span className="kpi-value num">{aed(b.exempt.amount)}</span>
          <span className="kpi-note">Box 5</span>
        </div>
      </div>
      {b.outOfScope.amount !== 0 && (
        <p className="form-error" role="status">
          <Icon name="alert" /> {aed(b.outOfScope.amount)} of sales were for products with no VAT set. Give those products a VAT type so they land in
          the right box.
        </p>
      )}
      <p className="muted small">
        Sales are amounts before VAT, after discounts. Refunds made in these dates are credit notes and are taken off. Purchases (input VAT)
        are not included; add them from your supplier bills.
      </p>
      {data.rows.length === 0 ? (
        <EmptyState icon="chart" title="No sales in these dates" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">VAT by type and rate</caption>
            <thead>
              <tr>
                <th scope="col">Supply</th>
                <th scope="col" className="num">Rate</th>
                <th scope="col" className="num hide-sm">Sales</th>
                <th scope="col" className="num hide-sm">Credit notes</th>
                <th scope="col" className="num">Net (AED)</th>
                <th scope="col" className="num">VAT (AED)</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.kind}-${r.rateBp}`}>
                  <td>{KIND_LABEL[r.kind]}</td>
                  <td className="num">{bp(r.rateBp)}</td>
                  <td className="num hide-sm">{money(r.salesNet)}</td>
                  <td className="num hide-sm">{r.refundNet ? `−${money(r.refundNet)}` : "0.00"}</td>
                  <td className="num strong">{money(r.net)}</td>
                  <td className="num strong">{money(r.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
