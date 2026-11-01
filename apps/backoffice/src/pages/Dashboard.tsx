import { useState } from "react";
import { BarChart } from "../components/BarChart.js";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState } from "../components/States.js";
import { api } from "../lib/api.js";
import { aed, dayLabel, money, qty, time } from "../lib/format.js";
import type { Dashboard as Data, Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const shift = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function Dashboard({ me }: { me: Me }) {
  const [date, setDate] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => api<Data>(`/dashboard${date ? `?date=${date}` : ""}`), [date]);
  const today = data && !date ? data.date : null;
  const isToday = !date || date === today;
  const day = data?.date ?? date;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">{me.stores.length === 1 ? me.stores[0]!.name : `${me.stores.length} stores`}</p>
        </div>
        <div className="day-picker" role="group" aria-label="Day">
          <button type="button" className="icon-btn" aria-label="Previous day" disabled={!day} onClick={() => day && setDate(shift(day, -1))}>
            <Icon name="chevronLeft" />
          </button>
          <input
            type="date"
            aria-label="Choose a day"
            value={day ?? ""}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Next day"
            disabled={!day || isToday}
            onClick={() => day && setDate(shift(day, 1))}
          >
            <Icon name="chevronRight" />
          </button>
          {!isToday && (
            <button type="button" className="btn ghost" onClick={() => setDate(null)}>
              Today
            </button>
          )}
        </div>
      </header>

      {error && <ErrorState message={error} onRetry={reload} />}
      {!error && (
        <div className={loading ? "dash loading" : "dash"} aria-busy={loading}>
          <section className="kpis" aria-label="Totals">
            <Kpi label={isToday ? "Sales today" : "Sales"} value={data ? aed(data.total) : null} hero />
            <Kpi label="Bills" value={data ? String(data.orderCount) : null} />
            <Kpi label="Average bill" value={data ? aed(data.averageBasket) : null} />
            <Kpi label="VAT collected" value={data ? aed(data.tax) : null} />
            <Kpi
              label="Refunds"
              value={data ? aed(data.refunds) : null}
              note={data?.refundCount ? `${data.refundCount} refund${data.refundCount > 1 ? "s" : ""}` : undefined}
            />
          </section>

          <section className="panel span-2" aria-labelledby="h-hourly">
            <h2 id="h-hourly">Sales by hour</h2>
            {data && data.orderCount + data.refundCount === 0 ? (
              <EmptyState icon="receipt" title="No sales on this day yet">
                <p className="muted">Bills from the tills appear here as soon as they sync.</p>
              </EmptyState>
            ) : (
              data && <Hourly data={data} />
            )}
          </section>

          <section className="panel" aria-labelledby="h-pay">
            <h2 id="h-pay">Cash and card</h2>
            {data && <Payments data={data} />}
          </section>

          <section className="panel span-2" aria-labelledby="h-trend">
            <h2 id="h-trend">Last 7 days</h2>
            {data && (
              <BarChart
                title="Sales for the last 7 days"
                tableHead={["Day", "Sales (AED)"]}
                format={(v) => money(Math.round(v))}
                height={160}
                bars={data.trend.map((d) => ({
                  key: d.date,
                  label: dayLabel(d.date).split(",")[0]!,
                  value: Math.max(d.total, 0),
                  detail: `${dayLabel(d.date)} · ${aed(d.total)} · ${d.orders} bill${d.orders === 1 ? "" : "s"}`,
                }))}
              />
            )}
          </section>

          <section className="panel" aria-labelledby="h-top">
            <h2 id="h-top">Top products</h2>
            {data && data.topProducts.length === 0 && <p className="muted">Nothing sold yet.</p>}
            <ol className="rank">
              {data?.topProducts.map((p) => (
                <li key={p.variantId}>
                  <span className="rank-name">{p.name}</span>
                  <span className="muted num">× {qty(p.qty)}</span>
                  <span className="num strong">{money(p.total)}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel span-3" aria-labelledby="h-recent">
            <div className="panel-head">
              <h2 id="h-recent">Latest bills</h2>
              <a href="#/sales" className="link">
                See all sales
              </a>
            </div>
            {data && data.recentOrders.length === 0 && <p className="muted">No bills on this day.</p>}
            <ul className="recent">
              {data?.recentOrders.map((o) => (
                <li key={o.id}>
                  <a href={`#/sales/${o.id}`}>
                    <span className="recent-main">
                      <span className="num recent-no">{o.number}</span>
                      <span className="muted small">
                        {time(o.createdAt)}
                        {o.isRefund && <span className="badge warn">Refund</span>}
                      </span>
                    </span>
                    <span className={o.total < 0 ? "num strong bad" : "num strong"}>{money(o.total)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, note, hero }: { label: string; value: string | null; note?: string; hero?: boolean }) {
  return (
    <div className={hero ? "kpi hero" : "kpi"}>
      <span className="kpi-label">{label}</span>
      {value === null ? <span className="skeleton kpi-skel" /> : <span className="kpi-value num">{value}</span>}
      {note && <span className="kpi-note muted">{note}</span>}
    </div>
  );
}

function Hourly({ data }: { data: Data }) {
  const byHour = new Map(data.hourly.map((h) => [h.hour, h]));
  const hours = data.hourly.map((h) => h.hour);
  // Show the trading day only, at least 8am to 10pm, so a quiet morning is still visible.
  const from = Math.min(8, ...hours);
  const to = Math.max(22, ...hours);
  const bars = [];
  for (let h = from; h <= to; h++) {
    const row = byHour.get(h);
    const hh = String(h).padStart(2, "0");
    bars.push({
      key: hh,
      label: h % 3 === 0 ? hh : "",
      value: Math.max(row?.total ?? 0, 0),
      detail: `${hh}:00–${hh}:59 · ${aed(row?.total ?? 0)} · ${row?.orders ?? 0} bill${row?.orders === 1 ? "" : "s"}`,
    });
  }
  return <BarChart title="Sales by hour" tableHead={["Hour", "Sales (AED)"]} format={(v) => money(Math.round(v))} bars={bars} />;
}

function Payments({ data }: { data: Data }) {
  const cash = data.payments.find((p) => p.kind === "cash")?.amount ?? 0;
  const card = data.payments.find((p) => p.kind === "card")?.amount ?? 0;
  const sum = Math.max(cash, 0) + Math.max(card, 0);
  const rows = [
    { label: "Cash", icon: "cash" as const, amount: cash },
    { label: "Card", icon: "card" as const, amount: card },
  ];
  return (
    <ul className="split">
      {rows.map((r) => {
        const pct = sum ? Math.round((Math.max(r.amount, 0) / sum) * 100) : 0;
        return (
          <li key={r.label}>
            <div className="split-row">
              <span className="split-label">
                <Icon name={r.icon} /> {r.label}
              </span>
              <span className="num strong">{aed(r.amount)}</span>
            </div>
            <div className="meter" role="img" aria-label={`${r.label}: ${pct}% of takings`}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">{pct}% of takings</span>
          </li>
        );
      })}
    </ul>
  );
}
