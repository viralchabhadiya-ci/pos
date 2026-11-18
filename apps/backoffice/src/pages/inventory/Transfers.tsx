import { useState, type FormEvent } from "react";
import { Field } from "../../components/Field.js";
import { Icon } from "../../components/Icon.js";
import { ItemPicker } from "../../components/ItemPicker.js";
import { Modal } from "../../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, errorText } from "../../lib/api.js";
import { dateTime } from "../../lib/format.js";
import { parseQty, qtyUnit, TRANSFER_STATUS, type TransferDetail, type TransferSummary, type Uom } from "../../lib/inventory.js";
import { go } from "../../lib/router.js";
import type { Me } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";
import { StatusBadge, StoreSelect } from "./Inventory.js";

const PAGE = 50;

export function Transfers({ me, id }: { me: Me; id?: string }) {
  if (me.stores.length < 2 && !id) {
    return (
      <EmptyState icon="arrows" title="Transfers need two stores">
        <p className="muted">Add another store in Settings, then move stock between them here.</p>
        <a className="btn" href="#/settings">
          <Icon name="settings" /> Settings
        </a>
      </EmptyState>
    );
  }
  if (id === "new") return <TransferEditor me={me} />;
  if (id) return <TransferView me={me} id={id} />;
  return <TransferList me={me} />;
}

function TransferList({ me }: { me: Me }) {
  const [status, setStatus] = useState("open");
  const [storeId, setStoreId] = useState("");
  const [offset, setOffset] = useState(0);
  const list = useLoad(() => {
    const p = new URLSearchParams({ status, limit: String(PAGE), offset: String(offset) });
    if (storeId) p.set("storeId", storeId);
    return api<{ transfers: TransferSummary[]; count: number }>(`/transfers?${p}`);
  }, [status, storeId, offset]);
  const data = list.data;
  return (
    <>
      <div className="filters">
        <select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
          <option value="open">Open</option>
          <option value="draft">Drafts</option>
          <option value="sent">In transit</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <StoreSelect me={me} value={storeId} onChange={(v) => (setStoreId(v), setOffset(0))} all />
        <div className="head-actions">
          <button type="button" className="btn primary" onClick={() => go("inventory/transfers/new")}>
            <Icon name="plus" /> New transfer
          </button>
        </div>
      </div>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="arrows" title={status === "open" ? "No open transfers" : "No transfers match"} />
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Transfers</caption>
              <thead>
                <tr>
                  <th scope="col">Transfer</th>
                  <th scope="col">From → To</th>
                  <th scope="col" className="hide-sm">Last change</th>
                  <th scope="col" className="num">Products</th>
                </tr>
              </thead>
              <tbody>
                {data.transfers.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <a className="row-link num" href={`#/inventory/transfers/${t.id}`}>
                        {t.number}
                      </a>
                      <span className="cell-sub">
                        <StatusBadge {...TRANSFER_STATUS[t.status]} />
                      </span>
                    </td>
                    <td>
                      {t.fromStoreName} → {t.toStoreName}
                    </td>
                    <td className="hide-sm">{dateTime(t.receivedAt ?? t.sentAt ?? t.createdAt)}</td>
                    <td className="num">{t.lines}</td>
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
    </>
  );
}

interface Line {
  variantId: string;
  name: string;
  uom: Uom;
  onHand: number;
  qty: string;
}

function TransferEditor({ me, t, onDone }: { me: Me; t?: TransferDetail; onDone?: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState(t?.fromStoreId ?? me.stores[0]?.id ?? "");
  const [to, setTo] = useState(t?.toStoreId ?? me.stores[1]?.id ?? "");
  const [notes, setNotes] = useState(t?.notes ?? "");
  const [lines, setLines] = useState<Line[]>(t?.lines.map((l) => ({ variantId: l.variantId, name: l.name, uom: l.uom, onHand: l.fromOnHand, qty: String(l.qty) })) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent, send = false) => {
    e.preventDefault();
    setError(null);
    if (from === to) return setError("Pick two different stores.");
    if (!lines.length) return setError("Add at least one product.");
    const body = [];
    for (const l of lines) {
      const qty = parseQty(l.qty, l.uom);
      if (qty === null) return setError(`Check the quantity for ${l.name}${l.uom === "unit" ? " (whole pieces)" : ""}.`);
      body.push({ variantId: l.variantId, qty });
    }
    setBusy(true);
    try {
      const payload = { fromStoreId: from, toStoreId: to, notes: notes.trim() || null, lines: body };
      const res = t ? await api<{ id: string }>(`/transfers/${t.id}`, { method: "PUT", body: payload }) : await api<{ id: string }>("/transfers", { body: payload });
      if (send) await api(`/transfers/${res.id}/send`, { body: {} });
      toast(send ? "Sent. The stock has left the store." : "Transfer saved");
      if (onDone) onDone();
      else go(`inventory/transfers/${res.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const short = lines.filter((l) => {
    const q = Number(l.qty);
    return Number.isFinite(q) && q > l.onHand;
  });

  return (
    <div className="narrow-page wide-page">
      <a href="#/inventory/transfers" className="back-link" onClick={onDone && ((e) => (e.preventDefault(), onDone()))}>
        <Icon name="arrowLeft" /> {t ? t.number : "Transfers"}
      </a>
      <header className="page-head">
        <div>
          <h1>{t ? `Edit ${t.number}` : "New transfer"}</h1>
        </div>
      </header>
      <form onSubmit={(e) => void save(e)} noValidate>
        <section className="panel">
          <div className="form-grid">
            <Field label="From">
              {(p) => (
                <select {...p} value={from} onChange={(e) => (setFrom(e.target.value), setLines([]))}>
                  {me.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="To">
              {(p) => (
                <select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                  {me.stores.map((s) => (
                    <option key={s.id} value={s.id} disabled={s.id === from}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field label="Note">
            {(p) => <input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Optional, e.g. driver's name" />}
          </Field>
        </section>
        <section className="panel">
          <ItemPicker storeId={from} exclude={lines.map((l) => l.variantId)} onPick={(it) => setLines([...lines, { variantId: it.variantId, name: it.name, uom: it.uom, onHand: it.onHand, qty: "1" }])} />
          {lines.length === 0 ? (
            <p className="muted">Search or scan to add products.</p>
          ) : (
            <div className="table-wrap flat">
              <table className="table lines-table">
                <caption className="sr-only">Products to send</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="num">In stock here</th>
                    <th scope="col" className="num">Send</th>
                    <th scope="col"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.variantId}>
                      <td>{l.name}</td>
                      <td className={l.onHand <= 0 ? "num bad" : "num"}>{qtyUnit(l.onHand, l.uom)}</td>
                      <td className="num">
                        <input
                          aria-label={`Quantity of ${l.name}`}
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                        />
                      </td>
                      <td className="actions">
                        <button type="button" className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                          <Icon name="trash" size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {short.length > 0 && (
            <p className="notice warn">
              <Icon name="alert" /> More than the system shows in stock: {short.map((l) => l.name).join(", ")}. You can still send it; stock there will go below zero.
            </p>
          )}
        </section>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="sticky-actions">
          <button type="button" className="btn" onClick={() => (onDone ? onDone() : go("inventory/transfers"))}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            Save draft
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={(e) => void save(e, true)}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Save and send
          </button>
        </div>
      </form>
    </div>
  );
}

function TransferView({ me, id }: { me: Me; id: string }) {
  const toast = useToast();
  const tr = useLoad(() => api<TransferDetail>(`/transfers/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [confirm, setConfirm] = useState<"send" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (action: "send" | "cancel", done: string) => {
    setBusy(true);
    try {
      await api(`/transfers/${id}/${action}`, { body: {} });
      toast(done);
      setConfirm(null);
      await tr.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (tr.error) return <ErrorState message={tr.error} onRetry={tr.reload} />;
  const t = tr.data;
  if (!t) return <SkeletonRows rows={5} />;
  if (editing) return <TransferEditor me={me} t={t} onDone={() => (setEditing(false), void tr.reload())} />;
  const done = t.status === "received";

  return (
    <div className="narrow-page wide-page">
      <a href="#/inventory/transfers" className="back-link">
        <Icon name="arrowLeft" /> Transfers
      </a>
      <header className="page-head">
        <div>
          <h1 className="num">
            Transfer {t.number} <StatusBadge {...TRANSFER_STATUS[t.status]} />
          </h1>
          <p className="muted">
            {t.fromStoreName} → {t.toStoreName}
          </p>
        </div>
      </header>
      <div className="head-actions no-print" style={{ marginBottom: "var(--space-4)" }}>
        {t.status === "draft" && (
          <>
            <button type="button" className="btn primary" onClick={() => setConfirm("send")}>
              <Icon name="send" /> Send
            </button>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              <Icon name="edit" /> Edit
            </button>
          </>
        )}
        {t.status === "sent" && (
          <button type="button" className="btn primary" onClick={() => setReceiving(true)}>
            <Icon name="truck" /> Receive at {t.toStoreName}
          </button>
        )}
        <button type="button" className="btn" onClick={() => window.print()}>
          <Icon name="printer" /> Print
        </button>
        {(t.status === "draft" || t.status === "sent") && (
          <button type="button" className="btn ghost" onClick={() => setConfirm("cancel")}>
            Cancel transfer
          </button>
        )}
      </div>
      <section className="panel">
        <dl className="doc-meta">
          <div>
            <dt>Created</dt>
            <dd>
              {dateTime(t.createdAt)}
              {t.createdBy && <span className="cell-sub">{t.createdBy}</span>}
            </dd>
          </div>
          {t.sentAt && (
            <div>
              <dt>Sent</dt>
              <dd>
                {dateTime(t.sentAt)}
                {t.sentBy && <span className="cell-sub">{t.sentBy}</span>}
              </dd>
            </div>
          )}
          {t.receivedAt && (
            <div>
              <dt>Received</dt>
              <dd>
                {dateTime(t.receivedAt)}
                {t.receivedBy && <span className="cell-sub">{t.receivedBy}</span>}
              </dd>
            </div>
          )}
        </dl>
        {t.notes && <p className="notice">{t.notes}</p>}
        <div className="table-wrap flat">
          <table className="table">
            <caption className="sr-only">Products</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">Sent</th>
                {done && <th scope="col" className="num">Received</th>}
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l) => (
                <tr key={l.id} className={done && l.qtyReceived !== l.qty ? "changed" : undefined}>
                  <td>
                    {l.name}
                    {l.barcode && <span className="cell-sub">{l.barcode}</span>}
                  </td>
                  <td className="num">{qtyUnit(l.qty, l.uom)}</td>
                  {done && <td className="num strong">{qtyUnit(l.qtyReceived ?? 0, l.uom)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {receiving && (
        <ReceiveDialog
          t={t}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            void tr.reload();
          }}
        />
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} label={confirm === "send" ? "Send transfer" : "Cancel transfer"}>
          <h2>{confirm === "send" ? `Send ${t.number}?` : `Cancel ${t.number}?`}</h2>
          <p>
            {confirm === "send"
              ? `The stock leaves ${t.fromStoreName} now and shows as on its way to ${t.toStoreName} until it is received.`
              : t.status === "sent"
                ? `The stock goes back into ${t.fromStoreName}.`
                : "The draft stays on record as cancelled."}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Back
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void act(confirm, confirm === "send" ? `${t.number} sent` : `${t.number} cancelled`)}
            >
              {confirm === "send" ? "Send" : "Cancel transfer"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReceiveDialog({ t, onClose, onDone }: { t: TransferDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(t.lines.map((l) => [l.id, String(l.qty)])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const lines = [];
    for (const l of t.lines) {
      const n = parseQty(qty[l.id] ?? "", l.uom, true);
      if (n === null) return setError(`Check the quantity for ${l.name}${l.uom === "unit" ? " (whole pieces)" : ""}.`);
      lines.push({ lineId: l.id, qtyReceived: n });
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ differences: { name: string }[] }>(`/transfers/${t.id}/receive`, { body: { lines } });
      toast(res.differences.length ? `Received with ${res.differences.length} difference${res.differences.length === 1 ? "" : "s"}, noted in the audit log` : "Received in full");
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={`Receive ${t.number}`} wide>
      <h2>Receive at {t.toStoreName}</h2>
      <p className="muted">Check what arrived. Anything missing is recorded as a difference and does not come into stock.</p>
      <form onSubmit={submit} noValidate>
        <div className="table-wrap">
          <table className="table lines-table">
            <caption className="sr-only">What arrived</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">Sent</th>
                <th scope="col" className="num">Arrived</th>
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l) => (
                <tr key={l.id} className={qty[l.id] !== String(l.qty) ? "changed" : undefined}>
                  <td>{l.name}</td>
                  <td className="num">{qtyUnit(l.qty, l.uom)}</td>
                  <td className="num">
                    <input aria-label={`Arrived of ${l.name}`} inputMode="decimal" value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
