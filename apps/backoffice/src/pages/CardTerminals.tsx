import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { dateTime, money } from "../lib/format.js";
import type { Register } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface Terminal {
  id: string;
  name: string;
  provider: string;
  terminalRef: string;
  active: boolean;
  registerId: string;
  registerName: string;
  storeName: string;
}
interface CardTx {
  id: string;
  kind: "sale" | "refund";
  amount: number;
  status: string;
  authCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  message: string | null;
  createdAt: string;
  terminalName: string;
  registerName: string;
  orderId: string | null;
  orderNumber: string | null;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  approved: { label: "Approved", tone: "good" },
  declined: { label: "Declined", tone: "" },
  cancelled: { label: "Cancelled", tone: "" },
  failed: { label: "Failed", tone: "" },
  pending: { label: "Waiting", tone: "warn" },
  unknown: { label: "No answer", tone: "warn" },
};

/** Card terminals per till, and every card payment for matching with the bank statement. */
export function CardTerminals({ registers }: { registers: Register[] }) {
  const terminals = useLoad(() => api<{ terminals: Terminal[] }>("/terminals"), []);
  const providers = useLoad(() => api<{ providers: { id: string; label: string }[] }>("/terminal-providers"), []);
  const [editing, setEditing] = useState<Terminal | "new" | null>(null);
  const [filter, setFilter] = useState<"all" | "problem">("all");
  const txs = useLoad(() => api<{ transactions: CardTx[]; count: number }>(`/card-transactions?status=${filter}&limit=30`), [filter]);

  return (
    <>
      <section className="panel" aria-labelledby="h-terminals">
        <div className="panel-head">
          <h2 id="h-terminals">Card terminals</h2>
          <button type="button" className="btn sm" onClick={() => setEditing("new")} disabled={!providers.data || registers.length === 0}>
            <Icon name="plus" /> Add terminal
          </button>
        </div>
        <p className="muted small">
          Link a card terminal to a till and the till sends the amount to it; the cashier never types it. A payment whose answer is lost is
          checked again, never charged twice.
        </p>
        {terminals.error ? (
          <ErrorState message={terminals.error} onRetry={terminals.reload} />
        ) : !terminals.data ? (
          <SkeletonRows rows={2} />
        ) : terminals.data.terminals.length === 0 ? (
          <EmptyState icon="card" title="No card terminals yet">
            <p className="muted">Without one, cashiers confirm card payments from a separate terminal by hand.</p>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Card terminals</caption>
              <thead>
                <tr>
                  <th scope="col">Terminal</th>
                  <th scope="col">Till</th>
                  <th scope="col" className="hide-sm">Provider</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {terminals.data.terminals.map((t) => (
                  <tr key={t.id} className={t.active ? undefined : "dim"}>
                    <td>
                      <span className="cell-main">{t.name}</span>
                      <span className="cell-sub">ID {t.terminalRef}</span>
                      {!t.active && <span className="badge">Off</span>}
                    </td>
                    <td>
                      {t.registerName}
                      <span className="cell-sub">{t.storeName}</span>
                    </td>
                    <td className="hide-sm">{providers.data?.providers.find((p) => p.id === t.provider)?.label ?? t.provider}</td>
                    <td className="actions">
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                        <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="h-cardtx">
        <div className="panel-head">
          <h2 id="h-cardtx">Card payments</h2>
          <div className="chips" role="group" aria-label="Show">
            <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              Latest
            </button>
            <button type="button" className="chip" aria-pressed={filter === "problem"} onClick={() => setFilter("problem")}>
              Needs a look
            </button>
          </div>
        </div>
        {filter === "problem" && (
          <p className="muted small">
            Charges older than 10 minutes that are on no bill (the sale was not finished), or that never got an answer. Refund them from the
            till or check them with the bank.
          </p>
        )}
        {txs.error ? (
          <ErrorState message={txs.error} onRetry={txs.reload} />
        ) : !txs.data ? (
          <SkeletonRows rows={3} />
        ) : txs.data.count === 0 ? (
          <EmptyState icon="card" title={filter === "problem" ? "Nothing needs a look" : "No card payments yet"} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Card payments</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Card</th>
                  <th scope="col" className="hide-sm">Bill</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Amount (AED)</th>
                </tr>
              </thead>
              <tbody>
                {txs.data.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {dateTime(t.createdAt)}
                      <span className="cell-sub">{t.registerName}</span>
                    </td>
                    <td>
                      {[t.cardBrand, t.cardLast4 && `•••• ${t.cardLast4}`].filter(Boolean).join(" ") || <span className="muted">—</span>}
                      {t.authCode && <span className="cell-sub">Auth {t.authCode}</span>}
                    </td>
                    <td className="hide-sm">
                      {t.orderId ? (
                        <a className="row-link" href={`#/sales/${t.orderId}`}>
                          {t.orderNumber}
                        </a>
                      ) : (
                        <span className="muted">Not on a bill</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${STATUS[t.status]?.tone ?? ""}`}>{STATUS[t.status]?.label ?? t.status}</span>
                      {t.kind === "refund" && <span className="cell-sub">Refund</span>}
                    </td>
                    <td className={t.kind === "refund" ? "num strong bad" : "num strong"}>{money(t.kind === "refund" ? -t.amount : t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && providers.data && (
        <TerminalDialog
          terminal={editing === "new" ? null : editing}
          registers={registers}
          providers={providers.data.providers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void terminals.reload();
          }}
        />
      )}
    </>
  );
}

function TerminalDialog({
  terminal,
  registers,
  providers,
  onClose,
  onSaved,
}: {
  terminal: Terminal | null;
  registers: Register[];
  providers: { id: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: terminal?.name ?? "",
    registerId: terminal?.registerId ?? registers[0]?.id ?? "",
    provider: terminal?.provider ?? providers[0]?.id ?? "",
    terminalRef: terminal?.terminalRef ?? "",
    active: terminal?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Give it a name the cashier will recognise, like Counter 1 terminal.";
    if (!form.terminalRef.trim()) errs.terminalRef = "Enter the terminal ID from the provider (on the device or in their portal).";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError(null);
    try {
      if (terminal) await api(`/terminals/${terminal.id}`, { method: "PUT", body: form });
      else await api("/terminals", { body: form });
      toast(`${form.name} saved`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={terminal ? `Edit ${terminal.name}` : "Add card terminal"}>
      <h2>{terminal ? "Edit card terminal" : "Add card terminal"}</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Name" required error={errors.name}>
          {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={80} />}
        </Field>
        <Field label="Till">
          {(p) => (
            <select {...p} value={form.registerId} onChange={(e) => set("registerId", e.target.value)}>
              {registers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.storeName}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Provider" hint="More providers are added as merchant agreements are signed.">
          {(p) => (
            <select {...p} value={form.provider} onChange={(e) => set("provider", e.target.value)}>
              {providers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Terminal ID" required error={errors.terminalRef}>
          {(p) => <input {...p} value={form.terminalRef} onChange={(e) => set("terminalRef", e.target.value)} maxLength={80} />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          <span>
            In use
            <span className="hint">Untick when the terminal is away for repair; the till then offers manual card only.</span>
          </span>
        </label>
        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
