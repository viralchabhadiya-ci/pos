import { useState } from "react";
import "../hq.css";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, download, errorText } from "../lib/api.js";
import { aed, ago, bp, money } from "../lib/format.js";
import type { HqOverview, Me, RoyaltyRow, StoreOverview } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

/** Dates in Dubai time, since the shops count their days there. */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);
const iso = (x: Date) => x.toISOString().slice(0, 10);

function presets() {
  const today = ymd(new Date());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const d = new Date(`${today}T00:00:00Z`);
  const lastMonthStart = new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
  const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0));
  return [
    { label: "Today", from: today, to: today },
    { label: "Last 7 days", from: iso(new Date(d.getTime() - 6 * 86_400_000)), to: today },
    { label: "This month", from: `${today.slice(0, 7)}-01`, to: today },
    { label: "Last month", from: iso(lastMonthStart), to: iso(lastMonthEnd) },
  ];
}

type Tab = "overview" | "royalties";

/** Head office: every store side by side, and what franchise stores owe. */
export function Stores({ me, tab: tabParam }: { me: Me; tab?: string }) {
  const hq = me.user.storeIds === null;
  const tab: Tab = hq && tabParam === "royalties" ? "royalties" : "overview";
  const [range, setRange] = useState(() => presets()[1]!);
  const toast = useToast();
  const q = `from=${range.from}&to=${range.to}`;

  const exportCsv = () => {
    const path = tab === "royalties" ? `/reports/royalties?${q}&format=csv` : `/hq/overview?${q}&format=csv`;
    const name = tab === "royalties" ? `royalties-${range.from}-to-${range.to}.csv` : `stores-${range.from}-to-${range.to}.csv`;
    download(path, name).catch((err) => toast(errorText(err)));
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Stores</h1>
          <p className="muted">
            {hq
              ? "Every store side by side: sales against the period before, stock, transfers on the way and tills online."
              : "Your stores side by side. Head office sees the whole business."}
          </p>
        </div>
        <button type="button" className="btn" onClick={exportCsv}>
          <Icon name="download" /> Download CSV
        </button>
      </header>

      {hq && (
        <div className="tabs" role="tablist" aria-label="Stores view">
          {(["overview", "royalties"] as Tab[]).map((t) => (
            <a
              key={t}
              role="tab"
              className="tab"
              aria-selected={tab === t}
              href={t === "overview" ? "#/stores" : "#/stores/royalties"}
            >
              {t === "overview" ? "Overview" : "Franchise royalties"}
            </a>
          ))}
        </div>
      )}

      <div className="filters">
        <div className="chips" role="group" aria-label="Quick dates">
          {presets().map((p) => (
            <button key={p.label} type="button" className="chip" aria-pressed={p.from === range.from && p.to === range.to} onClick={() => setRange(p)}>
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

      {tab === "royalties" ? <Royalties q={q} /> : <Overview q={q} me={me} />}
    </div>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  const up = value >= 0;
  return (
    <span className={up ? "change up" : "change down"}>
      {up ? "▲" : "▼"} {Math.abs(value).toFixed(1)}%<span className="sr-only">{up ? " up" : " down"} on the period before</span>
    </span>
  );
}

function Overview({ q, me }: { q: string; me: Me }) {
  const { data, error, loading, reload } = useLoad(() => api<HqOverview>(`/hq/overview?${q}`), [q]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <SkeletonRows rows={4} />;
  const t = data.totals;
  const best = Math.max(...data.stores.map((s) => s.total), 0);
  const ranked = [...data.stores].sort((a, b) => b.total - a.total);
  return (
    <div className={loading ? "dash loading" : "dash"} aria-busy={loading}>
      <section className="kpis" aria-label="All stores">
        <div className="kpi hero">
          <span className="kpi-label">Sales, {data.stores.length === 1 ? "1 store" : `${data.stores.length} stores`}</span>
          <span className="kpi-value num">{aed(t.total)}</span>
          <span className="kpi-note">
            {t.change === null ? "Nothing to compare with yet" : `${t.change >= 0 ? "Up" : "Down"} ${Math.abs(t.change).toFixed(1)}% on the ${data.days === 1 ? "day" : `${data.days} days`} before`}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Bills</span>
          <span className="kpi-value num">{t.bills}</span>
          <span className="kpi-note">Average {aed(t.averageBill)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Before VAT</span>
          <span className="kpi-value num">{aed(t.net)}</span>
          <span className="kpi-note">VAT {aed(t.vat)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Refunds</span>
          <span className="kpi-value num">{aed(t.refundTotal)}</span>
          <span className="kpi-note">{t.refunds === 1 ? "1 refund" : `${t.refunds} refunds`}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Stock at cost</span>
          <span className="kpi-value num">{aed(t.stockValue)}</span>
          <span className="kpi-note">On hand today</span>
        </div>
      </section>

      <section className="panel span-3" aria-labelledby="by-store">
        <div className="panel-head">
          <h2 id="by-store">By store</h2>
          <span className="muted small">Highest sales first</span>
        </div>
        {ranked.length === 0 ? (
          <EmptyState icon="store" title="No stores yet" />
        ) : (
          <div className="table-wrap flat">
            <table className="table store-table">
              <caption className="sr-only">Sales and status by store</caption>
              <thead>
                <tr>
                  <th scope="col">Store</th>
                  <th scope="col" className="num">Sales (AED)</th>
                  <th scope="col" className="num hide-xs">Change</th>
                  <th scope="col" className="num hide-sm">Bills</th>
                  <th scope="col" className="num hide-sm">Avg bill</th>
                  <th scope="col" className="num hide-md">Refunds</th>
                  <th scope="col" className="num hide-md">Stock at cost</th>
                  <th scope="col" className="hide-sm">Tills</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((s) => (
                  <StoreRow key={s.id} s={s} best={best} share={t.total > 0 ? s.total / t.total : 0} multi={me.stores.length > 1} />
                ))}
              </tbody>
              {ranked.length > 1 && (
                <tfoot>
                  <tr>
                    <td className="strong">All stores</td>
                    <td className="num strong">{money(t.total)}</td>
                    <td className="num hide-xs">
                      <Change value={t.change} />
                    </td>
                    <td className="num strong hide-sm">{t.bills}</td>
                    <td className="num strong hide-sm">{money(t.averageBill)}</td>
                    <td className="num strong hide-md">{money(t.refundTotal)}</td>
                    <td className="num strong hide-md">{money(t.stockValue)}</td>
                    <td className="hide-sm" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StoreRow({ s, best, share, multi }: { s: StoreOverview; best: number; share: number; multi: boolean }) {
  const width = best > 0 ? Math.max(2, Math.round((Math.max(s.total, 0) / best) * 100)) : 0;
  const offline = s.openShifts > 0 && s.tillsOnline < s.tills;
  return (
    <tr>
      <td>
        <span className="cell-main">
          <a className="link" href={multi ? `#/dashboard/${s.id}` : "#/dashboard"}>
            {s.name}
          </a>{" "}
          <span className="muted small">· {s.code}</span>
          {s.ownership === "franchise" && <span className="badge">Franchise</span>}
        </span>
        <span className="cell-sub">
          {s.lastSaleAt ? `Last sale ${ago(s.lastSaleAt)}` : "No sales in these dates"}
          {s.incomingTransfers > 0 && ` · ${s.incomingTransfers} transfer${s.incomingTransfers === 1 ? "" : "s"} on the way`}
          {s.transfersToSend > 0 && ` · ${s.transfersToSend} to send`}
        </span>
        <span className="share-bar" aria-hidden="true">
          <span style={{ width: `${width}%` }} />
        </span>
      </td>
      <td className="num strong">
        {money(s.total)}
        <span className="cell-sub">{Math.round(share * 100)}% of sales</span>
      </td>
      <td className="num hide-xs">
        <Change value={s.change} />
      </td>
      <td className="num hide-sm">{s.bills}</td>
      <td className="num hide-sm">{money(s.averageBill)}</td>
      <td className="num hide-md">{s.refunds ? `${money(s.refundTotal)} · ${s.refunds}` : "0.00"}</td>
      <td className="num hide-md">
        {money(s.stockValue)}
        {s.stockNoCost > 0 && <span className="cell-sub">{s.stockNoCost} without a cost</span>}
      </td>
      <td className="hide-sm">
        {s.tills === 0 ? (
          <span className="muted">No till paired</span>
        ) : (
          <span className={offline ? "badge warn" : "badge good"}>
            {s.tillsOnline} of {s.tills} online
          </span>
        )}
        <span className="cell-sub">{s.openShifts === 0 ? "No shift open" : s.openShifts === 1 ? "1 shift open" : `${s.openShifts} shifts open`}</span>
      </td>
    </tr>
  );
}

function Royalties({ q }: { q: string }) {
  const { data, error, loading, reload } = useLoad(
    () => api<{ stores: RoyaltyRow[]; totals: { net: number; royalty: number; marketingFee: number; due: number } }>(`/reports/royalties?${q}`),
    [q],
  );
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <SkeletonRows rows={3} />;
  if (data.stores.length === 0) {
    return (
      <EmptyState icon="store" title="No franchise stores">
        <p className="muted">
          In <a className="link" href="#/settings">Settings</a>, set a store to Franchise and enter its royalty and marketing fee.
        </p>
      </EmptyState>
    );
  }
  const t = data.totals;
  return (
    <div aria-busy={loading}>
      <section className="kpis royalty-kpis" aria-label="Royalty totals">
        <div className="kpi hero">
          <span className="kpi-label">Due to head office</span>
          <span className="kpi-value num">{aed(t.due)}</span>
          <span className="kpi-note">Royalty and marketing fee</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Royalty base</span>
          <span className="kpi-value num">{aed(t.net)}</span>
          <span className="kpi-note">Net sales before VAT</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Royalty</span>
          <span className="kpi-value num">{aed(t.royalty)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Marketing fee</span>
          <span className="kpi-value num">{aed(t.marketingFee)}</span>
        </div>
      </section>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Royalties by franchise store</caption>
          <thead>
            <tr>
              <th scope="col">Store</th>
              <th scope="col" className="num hide-sm">Sales</th>
              <th scope="col" className="num hide-sm">Refunds</th>
              <th scope="col" className="num">Base (AED)</th>
              <th scope="col" className="num hide-xs">Royalty</th>
              <th scope="col" className="num hide-xs">Marketing</th>
              <th scope="col" className="num">Due (AED)</th>
            </tr>
          </thead>
          <tbody>
            {data.stores.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="cell-main">
                    {r.name} <span className="muted small">· {r.code}</span>
                  </span>
                  <span className="cell-sub">{r.franchisee ?? "Franchisee not set"}</span>
                </td>
                <td className="num hide-sm">{money(r.sales)}</td>
                <td className="num hide-sm">{r.refunds ? `−${money(r.refunds)}` : "0.00"}</td>
                <td className="num">{money(r.net)}</td>
                <td className="num hide-xs">
                  {money(r.royalty)}
                  <span className="cell-sub">{bp(r.royaltyBp)}</span>
                </td>
                <td className="num hide-xs">
                  {money(r.marketingFee)}
                  <span className="cell-sub">{bp(r.marketingFeeBp)}</span>
                </td>
                <td className="num strong">{money(r.due)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        The base is each store's net sales before VAT, after discounts, less refunds made in these dates. Gift cards sold are not sales, so
        they are left out; they count when they are spent.
      </p>
    </div>
  );
}
