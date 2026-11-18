import { ErrorState, Skeleton, Updated } from "../components/States.js";
import { api } from "../lib/api.js";
import { aed, ago, dayLabel, hourLabel, money, time, when } from "../lib/format.js";
import type { Dashboard, Live } from "../lib/types.js";
import { usePoll } from "../lib/usePoll.js";

/** A till that has not reached the server for this long is shown as possibly offline. */
const STALE_MINUTES = 15;

function HourBars({ hourly }: { hourly: Dashboard["hourly"] }) {
  const byHour = new Map(hourly.map((h) => [h.hour, h]));
  const first = Math.min(8, ...hourly.map((h) => h.hour));
  const last = Math.max(22, ...hourly.map((h) => h.hour));
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const max = Math.max(1, ...hourly.map((h) => h.total));
  return (
    <figure style={{ margin: 0 }}>
      <div className="bars" role="img" aria-label="Sales by hour">
        {hours.map((h) => {
          const v = byHour.get(h);
          const pct = v ? Math.max(2, (Math.max(0, v.total) / max) * 100) : 2;
          return <span key={h} className={v ? "bar" : "bar zero"} style={{ height: `${pct}%` }} title={`${hourLabel(h)}: ${v ? aed(v.total) : "no sales"}`} />;
        })}
      </div>
      <figcaption className="bar-axis">
        <span>{hourLabel(first)}</span>
        <span>{hourLabel(Math.round((first + last) / 2))}</span>
        <span>{hourLabel(last)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Sales by hour</caption>
        <tbody>
          {hourly.map((h) => (
            <tr key={h.hour}>
              <th>{hourLabel(h.hour)}</th>
              <td>{aed(h.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Today({ storeId }: { storeId: string }) {
  const q = storeId ? `?storeId=${storeId}` : "";
  const live = usePoll(() => api<Live>(`/live${q}`), [q], 30_000);
  const dash = usePoll(() => api<Dashboard>(`/dashboard${q}`), [q], 60_000);
  const refresh = () => {
    void live.reload();
    void dash.reload();
  };

  if (!live.data && live.error) return <ErrorState message={live.error} onRetry={refresh} />;
  if (!live.data) return <Skeleton rows={4} />;
  const l = live.data;
  const d = dash.data;
  const yesterday = d?.trend.at(-2);
  const cash = d?.payments.find((p) => p.kind === "cash")?.amount ?? 0;
  const card = d?.payments.find((p) => p.kind === "card")?.amount ?? 0;
  const paid = Math.max(1, cash + card);

  return (
    <>
      <Updated at={live.updatedAt} error={live.error} loading={live.loading || dash.loading} onRefresh={refresh} />
      <section className="card hero" aria-labelledby="sales-today">
        <div className="label" id="sales-today">
          Sales today
        </div>
        <div className="big">{aed(l.today.total)}</div>
        <div className="row">
          <span>
            {l.today.orderCount} {l.today.orderCount === 1 ? "bill" : "bills"}
          </span>
          {yesterday && (
            <span>
              {dayLabel(yesterday.date)}: {aed(yesterday.total)}
            </span>
          )}
          {l.pendingApprovals > 0 && (
            <a href="#/approvals" style={{ color: "inherit", fontWeight: 700 }}>
              {l.pendingApprovals} waiting for approval
            </a>
          )}
        </div>
      </section>

      {d && (
        <div className="kpis">
          <div className="kpi">
            <div className="label">Average bill</div>
            <div className="value">{money(d.averageBasket)}</div>
          </div>
          <div className="kpi">
            <div className="label">VAT</div>
            <div className="value">{money(d.tax)}</div>
          </div>
          <div className="kpi">
            <div className="label">Refunds</div>
            <div className="value">{d.refundCount ? money(d.refunds) : "None"}</div>
          </div>
          <div className="kpi">
            <div className="label">Discounts</div>
            <div className="value">{money(d.discounts)}</div>
          </div>
        </div>
      )}

      {l.stores.length > 1 && (
        <section className="card">
          <h2>Stores</h2>
          <ul className="list">
            {l.stores.map((s) => (
              <li key={s.id}>
                <div className="grow">
                  <span className="title">{s.name}</span>
                  <span className="sub">
                    {s.orderCount} bills · last sale {s.lastOrderAt ? time(s.lastOrderAt) : "none yet today"}
                  </span>
                </div>
                <span className="amount">{money(s.total)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.hourly.length > 0 && (
        <section className="card">
          <h2>By hour</h2>
          <HourBars hourly={d.hourly} />
          <div className="split" aria-hidden>
            <span style={{ width: `${(cash / paid) * 100}%` }} />
            <span style={{ width: `${(card / paid) * 100}%` }} />
          </div>
          <div className="legend">
            <span>
              <i style={{ background: "var(--accent)" }} />
              Cash {aed(cash)}
            </span>
            <span>
              <i style={{ background: "var(--warn)" }} />
              Card {aed(card)}
            </span>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Tills open now</h2>
        {l.openShifts.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No shift is open at the moment.
          </p>
        ) : (
          <ul className="list">
            {l.openShifts.map((s) => {
              const stale = !s.lastSeenAt || Date.now() - new Date(s.lastSeenAt).getTime() > STALE_MINUTES * 60_000;
              return (
                <li key={s.id}>
                  <span className={stale ? "dot stale" : "dot"} aria-hidden />
                  <div className="grow">
                    <span className="title">
                      {s.registerName} · {s.cashier}
                    </span>
                    <span className="sub">
                      {l.stores.length > 1 ? `${s.storeName} · ` : ""}since {time(s.openedAt)} · {s.orderCount} bills
                      {stale ? ` · last synced ${ago(s.lastSeenAt).toLowerCase()}` : ""}
                    </span>
                  </div>
                  <span className="amount">{money(s.total)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {d && d.topProducts.length > 0 && (
        <section className="card">
          <h2>Best sellers today</h2>
          <ul className="list">
            {d.topProducts.map((p) => (
              <li key={p.variantId}>
                <div className="grow">
                  <span className="title">{p.name}</span>
                  <span className="sub">{p.qty} sold</span>
                </div>
                <span className="amount">{money(p.total)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Latest bills</h2>
        {l.latestOrders.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No bills yet.
          </p>
        ) : (
          <ul className="list">
            {l.latestOrders.map((o) => (
              <li key={o.id}>
                <div className="grow">
                  <span className="title">{o.isRefund ? `Refund ${o.number}` : o.number}</span>
                  <span className="sub">
                    {when(o.createdAt)} · {o.cashier}
                    {l.stores.length > 1 ? ` · ${o.storeName}` : ""}
                  </span>
                </div>
                <span className={o.total < 0 ? "amount neg" : "amount"}>{money(o.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
