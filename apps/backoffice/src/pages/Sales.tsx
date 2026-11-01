import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { api } from "../lib/api.js";
import { aed, dateTime, money } from "../lib/format.js";
import type { OrderRow } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const PAGE = 50;
const KEY = "bo.sales.filters";

interface Filters {
  q: string;
  from: string;
  to: string;
  type: "all" | "sales" | "refunds";
}

/** Filters survive opening a bill and coming back, so the owner does not lose their place. */
function loadFilters(): Filters & { offset: number } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (saved) return saved;
  } catch {
    // Storage may be blocked; start fresh.
  }
  return { q: "", from: "", to: "", type: "all", offset: 0 };
}

export function Sales() {
  const initial = loadFilters();
  const [f, setF] = useState<Filters>(initial);
  const [q, setQ] = useState(initial.q);
  const [offset, setOffset] = useState(initial.offset);

  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim() !== f.q) set({ q: q.trim() });
    }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ...f, offset }));
    } catch {
      // Not critical.
    }
  }, [f, offset]);

  const list = useLoad(() => {
    const p = new URLSearchParams({ type: f.type, limit: String(PAGE), offset: String(offset) });
    if (f.q) p.set("q", f.q);
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    return api<{ orders: OrderRow[]; count: number; total: number }>(`/orders?${p}`);
  }, [f, offset]);

  const set = (patch: Partial<Filters>) => {
    setOffset(0);
    setF((x) => ({ ...x, ...patch }));
  };
  const filtered = f.q || f.from || f.to || f.type !== "all";
  const data = list.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Sales</h1>
          <p className="muted">Every bill from every till. Refunds are made on the till and show up here.</p>
        </div>
      </header>

      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Bill number" placeholder="Bill number" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="inline-label">
          <span>From</span>
          <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="inline-label">
          <span>To</span>
          <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <select aria-label="Bill type" value={f.type} onChange={(e) => set({ type: e.target.value as Filters["type"] })}>
          <option value="all">Sales and refunds</option>
          <option value="sales">Sales only</option>
          <option value="refunds">Refunds only</option>
        </select>
        {filtered && (
          <button type="button" className="btn ghost" onClick={() => (setQ(""), set({ q: "", from: "", to: "", type: "all" }))}>
            Clear
          </button>
        )}
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="receipt" title={filtered ? "No bills match these filters" : "No bills yet"}>
          <p className="muted">{filtered ? "Try a wider date range or clear the search." : "Bills appear here once a till syncs its first sale."}</p>
        </EmptyState>
      ) : (
        <>
          <p className="summary" aria-live="polite">
            <strong className="num">{data.count}</strong> bill{data.count === 1 ? "" : "s"} · net <strong className="num">{aed(data.total)}</strong>
          </p>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Bills</caption>
              <thead>
                <tr>
                  <th scope="col">Bill</th>
                  <th scope="col" className="hide-xs">Time</th>
                  <th scope="col" className="hide-sm">Cashier</th>
                  <th scope="col" className="hide-sm">Paid by</th>
                  <th scope="col" className="num">Total (AED)</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="clickable">
                    <td>
                      <a className="row-link num" href={`#/sales/${o.id}`}>
                        {o.number}
                      </a>
                      {o.isRefund && (
                        <span className="badge warn">
                          <Icon name="refund" size={14} /> Refund
                        </span>
                      )}
                      <span className="cell-sub show-xs">{dateTime(o.createdAt)}</span>
                    </td>
                    <td className="hide-xs">{dateTime(o.createdAt)}</td>
                    <td className="hide-sm">
                      {o.cashierName}
                      <span className="cell-sub">{o.registerName}</span>
                    </td>
                    <td className="hide-sm">{(o.paymentKinds ?? []).map((k) => (k === "cash" ? "Cash" : "Card")).join(", ")}</td>
                    <td className={o.total < 0 ? "num strong bad" : "num strong"}>{money(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.count > PAGE && (
            <nav className="pager" aria-label="Pages">
              <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <Icon name="chevronLeft" /> Newer
              </button>
              <span className="muted">
                {offset + 1}–{Math.min(offset + PAGE, data.count)} of {data.count}
              </span>
              <button type="button" className="btn" disabled={offset + PAGE >= data.count} onClick={() => setOffset(offset + PAGE)}>
                Older <Icon name="chevronRight" />
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
