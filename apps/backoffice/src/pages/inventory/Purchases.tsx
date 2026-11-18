import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../../components/Field.js";
import { Icon } from "../../components/Icon.js";
import { ItemPicker } from "../../components/ItemPicker.js";
import { Modal } from "../../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, errorText } from "../../lib/api.js";
import { aed, dateTime, money, tryParseMoney } from "../../lib/format.js";
import { dateOnly, parseQty, PO_STATUS, qtyUnit, type PickItem, type PoDetail, type PoStatus, type PoSummary, type Supplier, type Uom } from "../../lib/inventory.js";
import { go } from "../../lib/router.js";
import type { Me } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";
import { StatusBadge, StoreSelect } from "./Inventory.js";
import { SupplierDialog } from "./Suppliers.js";

const PAGE = 50;

export function Purchases({ me, id }: { me: Me; id?: string }) {
  if (id === "new") return <PoEditor me={me} />;
  if (id) return <PoView me={me} id={id} />;
  return <PoList me={me} />;
}

function PoList({ me }: { me: Me }) {
  const [status, setStatus] = useState("open");
  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [receiving, setReceiving] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => (setSearch(q.trim()), setOffset(0)), 250);
    return () => clearTimeout(t);
  }, [q]);
  const suppliers = useLoad(() => api<{ suppliers: Supplier[] }>("/suppliers?status=all"), []);
  const list = useLoad(() => {
    const p = new URLSearchParams({ status, limit: String(PAGE), offset: String(offset) });
    if (supplierId) p.set("supplierId", supplierId);
    if (storeId) p.set("storeId", storeId);
    if (search) p.set("q", search);
    return api<{ orders: PoSummary[]; count: number }>(`/purchase-orders?${p}`);
  }, [status, supplierId, storeId, search, offset]);
  const data = list.data;

  return (
    <>
      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search orders" placeholder="Order number or supplier" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
          <option value="open">Open</option>
          <option value="draft">Drafts</option>
          <option value="ordered">Ordered</option>
          <option value="partial">Part received</option>
          <option value="received">Received</option>
          <option value="closed">Closed short</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <select aria-label="Supplier" value={supplierId} onChange={(e) => (setSupplierId(e.target.value), setOffset(0))}>
          <option value="">All suppliers</option>
          {suppliers.data?.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <StoreSelect me={me} value={storeId} onChange={(v) => (setStoreId(v), setOffset(0))} all />
        <div className="head-actions">
          <button type="button" className="btn" onClick={() => setReceiving(true)}>
            <Icon name="truck" /> Receive without order
          </button>
          <button type="button" className="btn primary" onClick={() => go("inventory/purchases/new")}>
            <Icon name="plus" /> New order
          </button>
        </div>
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="receipt" title={status === "open" && !supplierId && !search ? "No open orders" : "No orders match"}>
          <p className="muted">Create an order, or start from the Reorder tab to order what is running low.</p>
          <button type="button" className="btn primary" onClick={() => go("inventory/purchases/new")}>
            <Icon name="plus" /> New order
          </button>
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Purchase orders</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Supplier</th>
                  <th scope="col" className="hide-sm">Expected</th>
                  <th scope="col" className="hide-xs">Received</th>
                  <th scope="col" className="num">Total (AED)</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <a className="row-link num" href={`#/inventory/purchases/${o.id}`}>
                        {o.number}
                      </a>
                      <span className="cell-sub">
                        <StatusBadge {...PO_STATUS[o.status]} />
                      </span>
                    </td>
                    <td>
                      {o.supplierName}
                      {me.stores.length > 1 && <span className="cell-sub">To {o.storeName}</span>}
                    </td>
                    <td className="hide-sm">{o.expectedOn ? dateOnly(o.expectedOn) : <span className="muted">Not set</span>}</td>
                    <td className="hide-xs">
                      <span className="progress" aria-hidden="true">
                        <span style={{ width: `${o.ordered ? Math.min(100, (o.received / o.ordered) * 100) : 0}%` }} />
                      </span>
                      {o.ordered ? Math.round((o.received / o.ordered) * 100) : 0}%
                    </td>
                    <td className="num strong">{money(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.count > PAGE && (
            <nav className="pager" aria-label="Pages">
              <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <Icon name="chevronLeft" /> Previous
              </button>
              <span className="muted">
                {offset + 1}–{Math.min(offset + PAGE, data.count)} of {data.count}
              </span>
              <button type="button" className="btn" disabled={offset + PAGE >= data.count} onClick={() => setOffset(offset + PAGE)}>
                Next <Icon name="chevronRight" />
              </button>
            </nav>
          )}
        </>
      )}
      {receiving && <DirectReceiveDialog me={me} onClose={() => setReceiving(false)} onDone={() => setReceiving(false)} />}
    </>
  );
}

interface EditLine {
  variantId: string;
  name: string;
  uom: Uom;
  barcode: string | null;
  onHand: number;
  qty: string;
  cost: string;
}

/** New order, or changing one that nothing has arrived for yet. */
function PoEditor({ me, po, onDone }: { me: Me; po?: PoDetail; onDone?: () => void }) {
  const toast = useToast();
  const suppliers = useLoad(() => api<{ suppliers: Supplier[] }>("/suppliers?status=active"), []);
  const [supplierId, setSupplierId] = useState(po?.supplierId ?? "");
  const [storeId, setStoreId] = useState(po?.storeId ?? me.stores[0]?.id ?? "");
  const [expectedOn, setExpectedOn] = useState(po?.expectedOn ?? "");
  const [notes, setNotes] = useState(po?.notes ?? "");
  const [lines, setLines] = useState<EditLine[]>(
    po?.lines.map((l) => ({ variantId: l.variantId, name: l.name, uom: l.uom, barcode: l.barcode, onHand: l.onHand, qty: String(l.qtyOrdered), cost: money(l.unitCost) })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingSupplier, setAddingSupplier] = useState(false);

  const add = (it: PickItem) =>
    setLines((ls) => [
      ...ls,
      { variantId: it.variantId, name: it.name, uom: it.uom, barcode: it.barcode, onHand: it.onHand, qty: "1", cost: money(it.supplierCost ?? it.cost ?? 0) },
    ]);

  let net = 0;
  for (const l of lines) {
    const q = Number(l.qty.replace(",", "."));
    const c = tryParseMoney(l.cost);
    if (Number.isFinite(q) && c !== null) net += Math.round(q * c);
  }

  const save = async (e: FormEvent, thenOrder = false) => {
    e.preventDefault();
    setError(null);
    if (!supplierId) return setError("Pick a supplier.");
    if (!lines.length) return setError("Add at least one product.");
    const body = [];
    for (const l of lines) {
      const qty = parseQty(l.qty, l.uom);
      const cost = tryParseMoney(l.cost);
      if (qty === null) return setError(`Check the quantity for ${l.name}${l.uom === "unit" ? " (whole pieces)" : ""}.`);
      if (cost === null) return setError(`Check the cost for ${l.name}, e.g. 4.50.`);
      body.push({ variantId: l.variantId, qty, unitCost: cost });
    }
    setBusy(true);
    try {
      const payload = { supplierId, storeId, expectedOn: expectedOn || null, notes: notes.trim() || null, lines: body };
      const res = po
        ? await api<{ id: string }>(`/purchase-orders/${po.id}`, { method: "PUT", body: payload })
        : await api<{ id: string; number: string }>("/purchase-orders", { body: payload });
      if (thenOrder) await api(`/purchase-orders/${res.id}/order`, { body: {} });
      toast(po ? `${po.number} saved` : thenOrder ? "Order saved and marked as ordered" : "Draft saved");
      if (onDone) onDone();
      else go(`inventory/purchases/${res.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="narrow-page wide-page">
      <a href={po ? `#/inventory/purchases/${po.id}` : "#/inventory/purchases"} className="back-link" onClick={onDone && ((e) => (e.preventDefault(), onDone()))}>
        <Icon name="arrowLeft" /> {po ? po.number : "Purchase orders"}
      </a>
      <header className="page-head">
        <div>
          <h1>{po ? `Edit ${po.number}` : "New purchase order"}</h1>
          <p className="muted">Costs are per unit before VAT. They start from what the supplier charged last time.</p>
        </div>
      </header>
      <form onSubmit={(e) => void save(e)} noValidate>
        <section className="panel">
          <div className="form-grid">
            <Field label="Supplier" required>
              {(p) => (
                <div className="filters" style={{ margin: 0 }}>
                  <select {...p} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">Pick a supplier…</option>
                    {suppliers.data?.suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn" onClick={() => setAddingSupplier(true)}>
                    <Icon name="plus" /> New
                  </button>
                </div>
              )}
            </Field>
            {me.stores.length > 1 && (
              <Field label="Deliver to">
                {(p) => (
                  <select {...p} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                    {me.stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <Field label="Expected delivery">
              {(p) => <input {...p} type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />}
            </Field>
            <Field label="Notes for the supplier">
              {(p) => <input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}
            </Field>
          </div>
        </section>
        <section className="panel">
          <ItemPicker storeId={storeId} supplierId={supplierId || undefined} exclude={lines.map((l) => l.variantId)} onPick={add} />
          {lines.length === 0 ? (
            <p className="muted">Search or scan to add products.</p>
          ) : (
            <div className="table-wrap flat">
              <table className="table lines-table">
                <caption className="sr-only">Products on the order</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="num hide-xs">In stock</th>
                    <th scope="col" className="num">Quantity</th>
                    <th scope="col" className="num">Cost (AED)</th>
                    <th scope="col" className="num hide-sm">Line (AED)</th>
                    <th scope="col"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const set = (k: "qty" | "cost", v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
                    const c = tryParseMoney(l.cost);
                    const q = Number(l.qty.replace(",", "."));
                    return (
                      <tr key={l.variantId}>
                        <td>
                          {l.name}
                          {l.barcode && <span className="cell-sub">{l.barcode}</span>}
                        </td>
                        <td className="num hide-xs">{qtyUnit(l.onHand, l.uom)}</td>
                        <td className="num">
                          <input aria-label={`Quantity of ${l.name}`} inputMode="decimal" value={l.qty} onChange={(e) => set("qty", e.target.value)} />
                        </td>
                        <td className="num">
                          <input aria-label={`Cost of ${l.name}`} inputMode="decimal" value={l.cost} onChange={(e) => set("cost", e.target.value)} />
                        </td>
                        <td className="num hide-sm">{c !== null && Number.isFinite(q) ? money(Math.round(q * c)) : "–"}</td>
                        <td className="actions">
                          <button type="button" className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                            <Icon name="trash" size={18} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>Total before VAT</td>
                    <td className="num" colSpan={2}>
                      {aed(net)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="sticky-actions">
          <button type="button" className="btn" onClick={() => (onDone ? onDone() : go("inventory/purchases"))}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {po ? "Save changes" : "Save draft"}
          </button>
          {(!po || po.status === "draft") && (
            <button type="button" className="btn primary" disabled={busy} onClick={(e) => void save(e, true)}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Save and mark ordered
            </button>
          )}
        </div>
      </form>
      {addingSupplier && (
        <SupplierDialog
          supplier={null}
          onClose={() => setAddingSupplier(false)}
          onSaved={(id) => {
            setAddingSupplier(false);
            void suppliers.reload().then(() => setSupplierId(id));
          }}
        />
      )}
    </div>
  );
}

function PoView({ me, id }: { me: Me; id: string }) {
  const toast = useToast();
  const po = useLoad(() => api<PoDetail>(`/purchase-orders/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "close" | null>(null);

  const act = async (action: "order" | "cancel" | "close", done: string) => {
    setBusy(true);
    try {
      await api(`/purchase-orders/${id}/${action}`, { body: {} });
      toast(done);
      setConfirm(null);
      await po.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (po.error) return <ErrorState message={po.error} onRetry={po.reload} />;
  const d = po.data;
  if (!d) return <SkeletonRows rows={5} />;
  if (editing) return <PoEditor me={me} po={d} onDone={() => (setEditing(false), void po.reload())} />;
  const st = PO_STATUS[d.status as PoStatus];
  const canEdit = (d.status === "draft" || d.status === "ordered") && d.receipts.length === 0;
  const canReceive = ["draft", "ordered", "partial"].includes(d.status);

  return (
    <div className="narrow-page wide-page">
      <a href="#/inventory/purchases" className="back-link">
        <Icon name="arrowLeft" /> Purchase orders
      </a>
      <header className="page-head">
        <div>
          <h1 className="num">
            Purchase order {d.number} <StatusBadge {...st} />
          </h1>
          <p className="muted">
            {d.supplierName} · Created {dateTime(d.createdAt)}
            {d.createdBy ? ` by ${d.createdBy}` : ""}
          </p>
        </div>
        <p className="bill-total num">{aed(d.total)}</p>
      </header>

      <div className="head-actions no-print" style={{ marginBottom: "var(--space-4)" }}>
        {canReceive && (
          <button type="button" className="btn primary" onClick={() => setReceiving(true)}>
            <Icon name="truck" /> Receive goods
          </button>
        )}
        {d.status === "draft" && (
          <button type="button" className="btn" disabled={busy} onClick={() => void act("order", `${d.number} marked as ordered`)}>
            <Icon name="send" /> Mark as ordered
          </button>
        )}
        {canEdit && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            <Icon name="edit" /> Edit
          </button>
        )}
        <button type="button" className="btn" onClick={() => window.print()}>
          <Icon name="printer" /> Print
        </button>
        {d.status === "partial" && (
          <button type="button" className="btn" onClick={() => setConfirm("close")}>
            Close short
          </button>
        )}
        {canEdit && (
          <button type="button" className="btn ghost" onClick={() => setConfirm("cancel")}>
            Cancel order
          </button>
        )}
      </div>

      <section className="panel">
        <dl className="doc-meta">
          <div>
            <dt>Supplier</dt>
            <dd>
              {d.supplierName}
              {d.supplierTrn && <span className="cell-sub">TRN {d.supplierTrn}</span>}
              {(d.supplierPhone || d.supplierEmail) && <span className="cell-sub">{[d.supplierPhone, d.supplierEmail].filter(Boolean).join(" · ")}</span>}
            </dd>
          </div>
          <div>
            <dt>Deliver to</dt>
            <dd>
              {d.storeName}
              {d.storeAddress && <span className="cell-sub">{d.storeAddress}</span>}
            </dd>
          </div>
          <div>
            <dt>Expected</dt>
            <dd>{d.expectedOn ? dateOnly(d.expectedOn) : "Not set"}</dd>
          </div>
          <div>
            <dt>Payment</dt>
            <dd>{d.paymentTermsDays ? `${d.paymentTermsDays} days after delivery` : "On delivery"}</dd>
          </div>
        </dl>
        {d.notes && <p className="notice">{d.notes}</p>}
        <div className="table-wrap flat">
          <table className="table">
            <caption className="sr-only">Products</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">Ordered</th>
                <th scope="col" className="num">Received</th>
                <th scope="col" className="num hide-xs">Cost (AED)</th>
                <th scope="col" className="num">Line (AED)</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.name}
                    <span className="cell-sub">{[l.barcode, l.supplierSku && `Their code ${l.supplierSku}`].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td className="num">{qtyUnit(l.qtyOrdered, l.uom)}</td>
                  <td className={l.qtyReceived >= l.qtyOrdered ? "num good" : l.qtyReceived > 0 ? "num" : "num muted"}>{qtyUnit(l.qtyReceived, l.uom)}</td>
                  <td className="num hide-xs">{money(l.unitCost)}</td>
                  <td className="num">{money(l.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Total before VAT</td>
                <td className="num">{money(d.net)}</td>
              </tr>
              <tr>
                <td colSpan={4}>VAT</td>
                <td className="num">{money(d.vat)}</td>
              </tr>
              <tr>
                <td colSpan={4}>Total</td>
                <td className="num strong">{money(d.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {d.receipts.length > 0 && (
        <section className="panel no-print" aria-labelledby="po-rcv">
          <h2 id="po-rcv">Deliveries</h2>
          <div className="table-wrap flat">
            <table className="table">
              <caption className="sr-only">Deliveries</caption>
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">When</th>
                  <th scope="col" className="hide-xs">Supplier invoice</th>
                  <th scope="col" className="num">Value (AED)</th>
                </tr>
              </thead>
              <tbody>
                {d.receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{r.number}</td>
                    <td>
                      {dateTime(r.receivedAt)}
                      {r.receivedBy && <span className="cell-sub">{r.receivedBy}</span>}
                    </td>
                    <td className="hide-xs">{r.supplierInvoice ?? <span className="muted">None</span>}</td>
                    <td className="num">{money(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {receiving && (
        <ReceivePoDialog
          po={d}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            void po.reload();
          }}
        />
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} label={confirm === "cancel" ? "Cancel order" : "Close short"}>
          <h2>{confirm === "cancel" ? `Cancel ${d.number}?` : `Close ${d.number} short?`}</h2>
          <p>
            {confirm === "cancel"
              ? "The order stays on record as cancelled. Nothing changes in stock."
              : "Stop waiting for the rest of this order. What arrived stays in stock; the missing quantities no longer count as on their way."}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void act(confirm, confirm === "cancel" ? `${d.number} cancelled` : `${d.number} closed`)}
            >
              {confirm === "cancel" ? "Cancel order" : "Close short"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface RcvLine {
  key: string;
  name: string;
  uom: Uom;
  trackExpiry: boolean;
  expect: number | null;
  qty: string;
  cost: string;
  lot: string;
  expires: string;
}

function ReceiveLines({ lines, setLines, showExpect }: { lines: RcvLine[]; setLines: (l: RcvLine[]) => void; showExpect: boolean }) {
  const anyExpiry = lines.some((l) => l.trackExpiry);
  return (
    <div className="table-wrap">
      <table className="table lines-table">
        <caption className="sr-only">What arrived</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            {showExpect && <th scope="col" className="num hide-xs">Still due</th>}
            <th scope="col" className="num">Arrived</th>
            <th scope="col" className="num">Cost (AED)</th>
            {anyExpiry && <th scope="col">Batch and expiry</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const set = (k: keyof RcvLine, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
            return (
              <tr key={l.key}>
                <td>{l.name}</td>
                {showExpect && <td className="num hide-xs">{l.expect === null ? "" : qtyUnit(l.expect, l.uom)}</td>}
                <td className="num">
                  <input aria-label={`Arrived of ${l.name}`} inputMode="decimal" value={l.qty} onChange={(e) => set("qty", e.target.value)} />
                </td>
                <td className="num">
                  <input aria-label={`Cost of ${l.name}`} inputMode="decimal" value={l.cost} onChange={(e) => set("cost", e.target.value)} />
                </td>
                {anyExpiry && (
                  <td>
                    {l.trackExpiry ? (
                      <div className="filters" style={{ margin: 0 }}>
                        <input className="wide" aria-label={`Batch of ${l.name}`} placeholder="Batch (optional)" value={l.lot} onChange={(e) => set("lot", e.target.value)} />
                        <input type="date" aria-label={`Expiry of ${l.name}`} required value={l.expires} onChange={(e) => set("expires", e.target.value)} />
                      </div>
                    ) : (
                      <span className="muted">Not tracked</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Checks the lines typed into a receive form; skips lines left at zero. */
function readLines(lines: RcvLine[]) {
  const out: { key: string; qty: number; unitCost: number; lotCode: string | null; expiresOn: string | null }[] = [];
  for (const l of lines) {
    if (!l.qty.trim() || Number(l.qty) === 0) continue;
    const qty = parseQty(l.qty, l.uom);
    if (qty === null) return `Check the quantity for ${l.name}${l.uom === "unit" ? " (whole pieces)" : ""}.`;
    const cost = tryParseMoney(l.cost);
    if (cost === null) return `Check the cost for ${l.name}, e.g. 4.50.`;
    if (l.trackExpiry && !l.expires) return `Enter the expiry date for ${l.name}.`;
    out.push({ key: l.key, qty, unitCost: cost, lotCode: l.lot.trim() || null, expiresOn: l.expires || null });
  }
  if (!out.length) return "Enter what arrived.";
  return out;
}

function ReceivePoDialog({ po, onClose, onDone }: { po: PoDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [invoice, setInvoice] = useState("");
  const [lines, setLines] = useState<RcvLine[]>(
    po.lines.map((l) => {
      const due = Math.max(0, Math.round((l.qtyOrdered - l.qtyReceived) * 1000) / 1000);
      return { key: l.id, name: l.name, uom: l.uom, trackExpiry: l.trackExpiry, expect: due, qty: String(due), cost: money(l.unitCost), lot: "", expires: "" };
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const read = readLines(lines);
    if (typeof read === "string") return setError(read);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ number: string; status: string }>(`/purchase-orders/${po.id}/receive`, {
        body: { supplierInvoice: invoice.trim() || null, lines: read.map(({ key, ...r }) => ({ lineId: key, ...r })) },
      });
      toast(`${res.number} booked in. ${res.status === "received" ? "The order is complete." : "The rest is still due."}`);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={`Receive goods for ${po.number}`} wide>
      <h2>Receive goods</h2>
      <p className="muted">
        {po.number} from {po.supplierName}. Quantities start at what is still due; change them to what is actually on the delivery, or 0 for
        products that did not come.
      </p>
      <form onSubmit={submit} noValidate>
        <Field label="Supplier invoice or delivery note number">
          {(p) => <input {...p} value={invoice} onChange={(e) => setInvoice(e.target.value)} maxLength={60} />}
        </Field>
        <ReceiveLines lines={lines} setLines={setLines} showExpect />
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Book into stock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Goods that arrive with no purchase order, e.g. from a van salesman. */
function DirectReceiveDialog({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const suppliers = useLoad(() => api<{ suppliers: Supplier[] }>("/suppliers?status=active"), []);
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState("");
  const [invoice, setInvoice] = useState("");
  const [lines, setLines] = useState<RcvLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const read = readLines(lines);
    if (typeof read === "string") return setError(read);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ number: string }>("/receipts", {
        body: {
          storeId,
          supplierId: supplierId || null,
          supplierInvoice: invoice.trim() || null,
          lines: read.map(({ key, ...r }) => ({ variantId: key, ...r })),
        },
      });
      toast(`${res.number} booked into stock`);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Receive without order" wide>
      <h2>Receive without an order</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Supplier">
            {(p) => (
              <select {...p} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Not on the list</option>
                {suppliers.data?.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {me.stores.length > 1 && (
            <Field label="Store">
              {(p) => (
                <select {...p} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                  {me.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Invoice or delivery note number">
            {(p) => <input {...p} value={invoice} onChange={(e) => setInvoice(e.target.value)} maxLength={60} />}
          </Field>
        </div>
        <ItemPicker
          storeId={storeId}
          supplierId={supplierId || undefined}
          exclude={lines.map((l) => l.key)}
          onPick={(it) =>
            setLines([
              ...lines,
              { key: it.variantId, name: it.name, uom: it.uom, trackExpiry: it.trackExpiry, expect: null, qty: "1", cost: money(it.supplierCost ?? it.cost ?? 0), lot: "", expires: "" },
            ])
          }
        />
        {lines.length > 0 && <ReceiveLines lines={lines} setLines={setLines} showExpect={false} />}
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Book into stock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
