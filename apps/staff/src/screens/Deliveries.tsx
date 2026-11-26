import { useMemo, useState } from "react";
import { CodeInput, Scanner } from "../components/Scanner.js";
import { Sheet, Stepper } from "../components/Sheet.js";
import { Empty, ErrorState, Skeleton } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { qty } from "../lib/format.js";
import { findByCode, searchByName } from "../lib/match.js";
import type { Scannable, StaffUser } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface OrderSummary {
  id: string;
  number: string;
  status: "ordered" | "partial";
  expectedOn: string | null;
  supplierName: string;
  lines: number;
}
interface OrderLine extends Scannable {
  id: string;
  trackExpiry: boolean;
  ordered: number;
  received: number;
}
interface Order {
  id: string;
  number: string;
  status: string;
  supplierName: string;
  lines: OrderLine[];
}
interface Arrived {
  qty: number;
  expiresOn?: string;
}

export function Deliveries({ id, user }: { id?: string; user: StaffUser }) {
  return id ? <DeliveryView id={id} user={user} /> : <DeliveryList />;
}

function DeliveryList() {
  const list = useLoad(() => api<{ orders: OrderSummary[] }>("/staff/deliveries"), []);
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Skeleton />;
  if (!list.data.orders.length) return <Empty title="Nothing on its way" text="Purchase orders marked as ordered for this store show here, ready to check in when the van comes." />;
  return (
    <>
      {list.data.orders.map((o) => (
        <a key={o.id} className="card" href={`#/receive/${o.id}`} style={{ display: "block", textDecoration: "none" }}>
          <h2 style={{ marginBottom: 4 }}>{o.supplierName}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {o.number} · {o.lines} {o.lines === 1 ? "product" : "products"}
            {o.expectedOn ? ` · due ${o.expectedOn}` : ""} {o.status === "partial" && <span className="badge warn">Part received</span>}
          </p>
        </a>
      ))}
    </>
  );
}

function DeliveryView({ id, user }: { id: string; user: StaffUser }) {
  const order = useLoad(() => api<Order>(`/staff/deliveries/${id}`), [id]);
  const toast = useToast();
  const [arrived, setArrived] = useState<Record<string, Arrived>>({});
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<OrderLine | null>(null);
  const [value, setValue] = useState("");
  const [expiry, setExpiry] = useState("");
  const [invoice, setInvoice] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = order.data?.lines ?? [];
  const matches = useMemo(() => (code && !/^\d{6,}$/.test(code) ? searchByName(lines, code) : []), [code, lines]);
  const canBook = user.role !== "cashier";

  const open = (l: OrderLine) => {
    setEditing(l);
    setValue(String(arrived[l.id]?.qty ?? Math.max(0, l.ordered - l.received)));
    setExpiry(arrived[l.id]?.expiresOn ?? "");
  };
  const onCode = (c: string) => {
    const l = findByCode(lines, c);
    if (!l) return toast(`${c} is not on this order`);
    setScanning(false);
    open(l);
  };

  const book = async () => {
    const entries = Object.entries(arrived).filter(([, a]) => a.qty > 0);
    if (!entries.length) return;
    setBusy(true);
    try {
      const res = await api<{ number: string; status: string }>(`/staff/deliveries/${id}/receive`, {
        body: {
          supplierInvoice: invoice.trim() || null,
          lines: entries.map(([lineId, a]) => ({ lineId, qty: a.qty, expiresOn: a.expiresOn || null })),
        },
      });
      toast(`Booked in as ${res.number}${res.status === "partial" ? ". The rest is still on order." : ""}`);
      setArrived({});
      setInvoice("");
      order.reload();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (order.error) return <ErrorState message={order.error} onRetry={order.reload} />;
  if (!order.data) return <Skeleton />;
  const o = order.data;
  const ticked = Object.values(arrived).filter((a) => a.qty > 0).length;
  const missingExpiry = lines.some((l) => l.trackExpiry && (arrived[l.id]?.qty ?? 0) > 0 && !arrived[l.id]?.expiresOn);

  return (
    <>
      <a href="#/receive" className="btn ghost sm">
        ← Deliveries
      </a>
      <h2 style={{ margin: "8px 0 0" }}>{o.supplierName}</h2>
      <p className="muted small">{o.number}</p>
      {!["ordered", "partial"].includes(o.status) ? (
        <Empty title={`This order is ${o.status}`} text="Nothing more is expected on it." />
      ) : (
        <>
          <CodeInput value={code} onChange={setCode} onSubmit={() => {
            const l = findByCode(lines, code) ?? (matches.length === 1 ? matches[0] : undefined);
            if (l) {
              open(l);
              setCode("");
            }
          }} scanning={scanning} onScanToggle={() => setScanning(!scanning)} label="Find a product on this order" />
          {scanning && <Scanner onCode={onCode} onClose={() => setScanning(false)} />}
          {matches.length > 0 && (
            <div className="card">
              <ul className="list">
                {matches.map((l) => (
                  <li key={l.id}>
                    <button type="button" className="btn ghost block" style={{ justifyContent: "flex-start" }} onClick={() => open(l)}>
                      {l.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <ul className="list">
              {lines.map((l) => {
                const a = arrived[l.id];
                const left = Math.max(0, l.ordered - l.received);
                return (
                  <li key={l.id}>
                    <span className="grow">
                      <span className="title">{l.name}</span>
                      <span className="line-meta">
                        Ordered {qty(l.ordered, l.uom)}
                        {l.received > 0 && ` · already in ${qty(l.received, l.uom)}`}
                        {l.trackExpiry && " · needs expiry"}
                      </span>
                    </span>
                    {a && a.qty > 0 && <span className="amount done-row">+{qty(a.qty, l.uom)}</span>}
                    <button type="button" className="btn sm" onClick={() => open(l)} disabled={left === 0 && !a}>
                      {left === 0 && !a ? "All in" : a ? "Change" : "Check in"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="card">
            <div className="field">
              <label htmlFor="invoice">Supplier invoice number</label>
              <input id="invoice" value={invoice} onChange={(e) => setInvoice(e.target.value)} maxLength={60} />
            </div>
            {missingExpiry && <p className="form-error">Some products need an expiry date. Tap them and add it.</p>}
            {!canBook && <p className="muted small">A manager books the delivery in. Check the goods, then hand the phone to them.</p>}
            <button type="button" className="btn primary block" onClick={book} disabled={!ticked || busy || !canBook || missingExpiry}>
              {busy && <span className="spinner" aria-hidden />}
              Book in {ticked} {ticked === 1 ? "product" : "products"}
            </button>
          </div>
        </>
      )}
      {editing && (
        <Sheet title={editing.name} onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(value);
              if (!Number.isFinite(n) || n < 0) return toast("Enter how many arrived");
              if (editing.uom !== "kg" && !Number.isInteger(n)) return toast(`${editing.name} comes in whole pieces`);
              if (editing.trackExpiry && n > 0 && !expiry) return toast("Add the expiry date from the pack");
              setArrived({ ...arrived, [editing.id]: { qty: n, expiresOn: expiry || undefined } });
              setEditing(null);
            }}
          >
            <p className="muted small">
              Ordered {qty(editing.ordered, editing.uom)}, already in {qty(editing.received, editing.uom)}.
            </p>
            <div className="field">
              <label htmlFor="arrived">Arrived now{editing.uom === "kg" ? " (kg)" : ""}</label>
              <Stepper id="arrived" value={value} onChange={setValue} label="arrived" step={editing.uom === "kg" ? 0.1 : 1} />
            </div>
            {editing.trackExpiry && (
              <div className="field">
                <label htmlFor="expiry">Expiry date</label>
                <input id="expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} required />
              </div>
            )}
            <button type="submit" className="btn primary block">
              Done
            </button>
          </form>
        </Sheet>
      )}
    </>
  );
}
