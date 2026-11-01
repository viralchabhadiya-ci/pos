import { Icon } from "../components/Icon.js";
import { ErrorState, SkeletonRows } from "../components/States.js";
import { api } from "../lib/api.js";
import { aed, bp, dateTime, money, qty } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";

interface Bill {
  id: string;
  number: string;
  createdAt: string;
  syncedAt: string;
  amountTotal: number;
  discountTotal: number;
  subtotalNet: number;
  taxTotal: number;
  total: number;
  cashRounding: number;
  totalsMismatch: boolean;
  storeName: string;
  registerName: string;
  cashierName: string;
  customerName: string | null;
  customerPhone: string | null;
  refundOfId: string | null;
  refundOfNumber: string | null;
  refunds: { id: string; number: string; total: number }[];
  lines: {
    lineNo: number;
    name: string;
    qty: string;
    unitPrice: number;
    discountBp: number;
    discount: number;
    taxRateBp: number | null;
    gross: number;
    note: string | null;
  }[];
  payments: { kind: string; name: string; amount: number; tendered: number | null; change: number; reference: string | null }[];
}

export function OrderDetail({ id }: { id: string }) {
  const { data: b, error, reload } = useLoad(() => api<Bill>(`/orders/${id}`), [id]);

  return (
    <div className="page narrow-page">
      <a href="#/sales" className="back-link">
        <Icon name="arrowLeft" /> All sales
      </a>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !b ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1 className="num">
                {b.refundOfId ? "Refund " : "Bill "}
                {b.number}
              </h1>
              <p className="muted">
                {dateTime(b.createdAt)} · {b.storeName}, {b.registerName} · {b.cashierName}
              </p>
            </div>
            <p className={b.total < 0 ? "bill-total bad num" : "bill-total num"}>{aed(b.total)}</p>
          </header>

          {b.refundOfId && (
            <p className="notice">
              <Icon name="refund" /> Refund for bill{" "}
              <a className="link num" href={`#/sales/${b.refundOfId}`}>
                {b.refundOfNumber}
              </a>
            </p>
          )}
          {b.refunds.length > 0 && (
            <p className="notice warn">
              <Icon name="refund" />
              <span>
                Partly or fully refunded:{" "}
                {b.refunds.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ", "}
                    <a className="link num" href={`#/sales/${r.id}`}>
                      {r.number}
                    </a>{" "}
                    ({aed(r.total)})
                  </span>
                ))}
              </span>
            </p>
          )}
          {b.totalsMismatch && (
            <p className="notice warn">
              <Icon name="alert" /> The till showed a different total from the server's check. The server's numbers are shown here.
            </p>
          )}

          <section className="panel" aria-labelledby="h-items">
            <h2 id="h-items">Items</h2>
            <div className="table-wrap flat">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="num">Qty</th>
                    <th scope="col" className="num hide-xs">Price</th>
                    <th scope="col" className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {b.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td>
                        <span className="cell-main">{l.name}</span>
                        {l.discount > 0 && (
                          <span className="cell-sub">
                            Discount {l.discountBp ? bp(l.discountBp) : ""} −{money(l.discount)}
                          </span>
                        )}
                        {l.note && <span className="cell-sub">{l.note}</span>}
                      </td>
                      <td className="num">{qty(l.qty)}</td>
                      <td className="num hide-xs">{money(l.unitPrice)}</td>
                      <td className="num strong">{money(l.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="totals">
              {b.discountTotal !== 0 && (
                <>
                  <dt>Discounts</dt>
                  <dd className="num">−{money(Math.abs(b.discountTotal))}</dd>
                </>
              )}
              <dt>Before VAT</dt>
              <dd className="num">{money(b.subtotalNet)}</dd>
              <dt>VAT</dt>
              <dd className="num">{money(b.taxTotal)}</dd>
              <dt className="grand">Total</dt>
              <dd className="num grand">{aed(b.total)}</dd>
            </dl>
          </section>

          <section className="panel" aria-labelledby="h-pay">
            <h2 id="h-pay">Payment</h2>
            <ul className="pay-list">
              {b.payments.map((p, i) => (
                <li key={i}>
                  <Icon name={p.kind === "cash" ? "cash" : "card"} />
                  <span className="cell-main">{p.name}</span>
                  <span className="num strong">{aed(p.amount)}</span>
                  {p.tendered != null && p.tendered !== p.amount && (
                    <span className="cell-sub">
                      Given {money(p.tendered)} · change {money(p.change)}
                    </span>
                  )}
                  {p.reference && <span className="cell-sub">Ref {p.reference}</span>}
                </li>
              ))}
              {b.cashRounding !== 0 && (
                <li className="muted small">Cash rounding {money(b.cashRounding)}</li>
              )}
            </ul>
            {b.customerName && (
              <p className="muted">
                Customer: {b.customerName}
                {b.customerPhone ? ` · ${b.customerPhone}` : ""}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
