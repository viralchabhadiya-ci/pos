import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Field } from "../../components/Field.js";
import { Icon } from "../../components/Icon.js";
import { ItemPicker } from "../../components/ItemPicker.js";
import { Modal } from "../../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, errorText } from "../../lib/api.js";
import { aed, dateTime } from "../../lib/format.js";
import { COUNT_STATUS, parseQty, qtyUnit, type CountLine, type CountSummary } from "../../lib/inventory.js";
import { go } from "../../lib/router.js";
import type { Category, Me } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";
import { StatusBadge } from "./Inventory.js";

export function Counts({ me, id }: { me: Me; id?: string }) {
  if (id) return <CountSheet me={me} id={id} />;
  return <CountList me={me} />;
}

function CountList({ me }: { me: Me }) {
  const [status, setStatus] = useState("all");
  const [starting, setStarting] = useState(false);
  const list = useLoad(() => api<{ counts: CountSummary[]; count: number }>(`/stock-counts?status=${status}&limit=100`), [status]);
  const data = list.data;
  return (
    <>
      <div className="filters">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All</option>
          <option value="open">In progress</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <div className="head-actions">
          <button type="button" className="btn primary" onClick={() => setStarting(true)}>
            <Icon name="plus" /> Start a count
          </button>
        </div>
      </div>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="clipboard" title="No stock counts yet">
          <p className="muted">Count the whole store, or one category at a time. You can keep selling while counting.</p>
          <button type="button" className="btn primary" onClick={() => setStarting(true)}>
            <Icon name="plus" /> Start a count
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap" aria-busy={list.loading}>
          <table className="table inv-rows">
            <caption className="sr-only">Stock counts</caption>
            <thead>
              <tr>
                <th scope="col">Count</th>
                <th scope="col" className="hide-sm">Started</th>
                <th scope="col">Counted</th>
              </tr>
            </thead>
            <tbody>
              {data.counts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a className="row-link" href={`#/inventory/counts/${c.id}`}>
                      {c.name}
                    </a>
                    <span className="cell-sub">
                      <span className="num">{c.number}</span> <StatusBadge {...COUNT_STATUS[c.status]} />
                    </span>
                  </td>
                  <td className="hide-sm">{dateTime(c.createdAt)}</td>
                  <td>
                    <span className="progress" aria-hidden="true">
                      <span style={{ width: `${c.lines ? (c.counted / c.lines) * 100 : 0}%` }} />
                    </span>
                    <span className="num">
                      {c.counted} of {c.lines}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {starting && <StartDialog me={me} onClose={() => setStarting(false)} />}
    </>
  );
}

function StartDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const cats = useLoad(() => api<{ categories: Category[] }>("/categories"), []);
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ id: string }>("/stock-counts", { body: { storeId, categoryId: categoryId || null, name: name.trim() || null } });
      go(`inventory/counts/${res.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Start a count">
      <h2>Start a stock count</h2>
      <form onSubmit={submit} noValidate>
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
        <Field label="What to count" hint="A category at a time keeps each count short.">
          {(p) => (
            <select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Every product</option>
              {cats.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Name" hint="Optional, e.g. Month-end December">
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}
        </Field>
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
            Start counting
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface CountDetail extends Omit<CountSummary, "lines" | "counted"> {
  categoryId: string | null;
  notes: string | null;
  createdBy: string | null;
  completedBy: string | null;
  lines: CountLine[];
}

/**
 * The count sheet. Typing a figure saves it after a short pause (stamped with the time, so
 * later sales are allowed for). Scanning a barcode jumps to that product.
 */
function CountSheet({ me, id }: { me: Me; id: string }) {
  const toast = useToast();
  const sheet = useLoad(() => api<CountDetail>(`/stock-counts/${id}`), [id]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, true>>({});
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"all" | "todo" | "diff">("all");
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<"complete" | "cancel" | null>(null);
  const [zeroUncounted, setZeroUncounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const c = sheet.data;
  const open = c?.status === "open";

  useEffect(() => {
    if (!c) return;
    setValues((v) => {
      const next = { ...v };
      for (const l of c.lines) if (!(l.variantId in pending)) next[l.variantId] = l.counted === null ? "" : String(l.counted);
      return next;
    });
  }, [c]);

  // Save typed counts after a pause, in one request.
  useEffect(() => {
    const keys = Object.keys(pending);
    if (!keys.length || !c) return;
    const t = setTimeout(async () => {
      const lines = [];
      for (const k of keys) {
        const line = c.lines.find((l) => l.variantId === k);
        const raw = values[k] ?? "";
        if (!raw.trim()) {
          lines.push({ variantId: k, counted: null });
          continue;
        }
        const n = parseQty(raw, line?.uom ?? "unit", true);
        if (n !== null) lines.push({ variantId: k, counted: n });
      }
      setPending({});
      if (!lines.length) return;
      setSaving(true);
      try {
        await api(`/stock-counts/${id}/lines`, { method: "PUT", body: { lines } });
        await sheet.reload();
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        setSaving(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [pending, values]);

  const shown = useMemo(() => {
    if (!c) return [];
    const s = q.trim().toLowerCase();
    return c.lines.filter((l) => {
      if (s && !(l.name.toLowerCase().includes(s) || l.barcode === q.trim() || l.sku === q.trim())) return false;
      if (filter === "todo") return l.counted === null;
      if (filter === "diff") return l.counted !== null && l.counted !== (l.systemAtCount ?? l.expected);
      return true;
    });
  }, [c, q, filter]);

  const act = async (action: "complete" | "cancel") => {
    setBusy(true);
    try {
      const res = await api<{ changed?: number; value?: number }>(`/stock-counts/${id}/${action}`, { body: action === "complete" ? { zeroUncounted } : {} });
      toast(action === "complete" ? `Count completed: ${res.changed} product${res.changed === 1 ? "" : "s"} corrected (${aed(res.value ?? 0)} at cost)` : "Count cancelled");
      setConfirm(null);
      await sheet.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (sheet.error) return <ErrorState message={sheet.error} onRetry={sheet.reload} />;
  if (!c) return <SkeletonRows rows={6} />;
  const counted = c.lines.filter((l) => l.counted !== null).length;
  const diffValue = c.lines.reduce((s, l) => {
    if (l.counted === null) return s;
    const sys = l.adjustment !== null ? l.counted - l.adjustment : (l.systemAtCount ?? l.expected);
    return s + Math.round((l.counted - sys) * (l.cost ?? 0));
  }, 0);

  return (
    <div className="narrow-page wide-page">
      <a href="#/inventory/counts" className="back-link">
        <Icon name="arrowLeft" /> Stock counts
      </a>
      <header className="page-head">
        <div>
          <h1>
            {c.name} <StatusBadge {...COUNT_STATUS[c.status]} />
          </h1>
          <p className="muted">
            <span className="num">{c.number}</span> · {me.stores.length > 1 ? `${c.storeName} · ` : ""}Started {dateTime(c.createdAt)}
            {c.completedAt ? ` · Completed ${dateTime(c.completedAt)}` : ""}
          </p>
        </div>
        {open && (
          <div className="head-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirm("cancel")}>
              Cancel count
            </button>
            <button type="button" className="btn primary" onClick={() => setConfirm("complete")} disabled={!counted || saving || Object.keys(pending).length > 0}>
              <Icon name="check" /> Complete
            </button>
          </div>
        )}
      </header>

      <section className="inv-kpis" aria-label="Progress">
        <div className="kpi">
          <span className="kpi-label">Counted</span>
          <span className="kpi-value num">
            {counted} of {c.lines.length}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Difference at cost</span>
          <span className={diffValue < 0 ? "kpi-value num bad" : "kpi-value num"}>{aed(diffValue)}</span>
          <span className="kpi-note muted" aria-live="polite">
            {saving ? "Saving…" : open ? "Saved as you type" : ""}
          </span>
        </div>
      </section>

      <div className="filters">
        <div className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Find a product"
            placeholder="Find or scan a product"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const hit = c.lines.find((l) => l.barcode === q.trim() || l.sku === q.trim()) ?? (shown.length === 1 ? shown[0] : undefined);
              if (hit) {
                inputs.current[hit.variantId]?.focus();
                inputs.current[hit.variantId]?.select();
              }
            }}
          />
        </div>
        <div className="chips" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["todo", "Not counted"],
              ["diff", "Different"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {open && (
        <ItemPicker
          storeId={c.storeId}
          label="Found something not on the list"
          exclude={c.lines.map((l) => l.variantId)}
          onPick={async (it) => {
            try {
              await api(`/stock-counts/${id}/lines`, { method: "PUT", body: { lines: [{ variantId: it.variantId, counted: null }] } });
              await sheet.reload();
              setQ(it.name);
            } catch (err) {
              toast(errorText(err), "error");
            }
          }}
        />
      )}

      {shown.length === 0 ? (
        <EmptyState icon="clipboard" title={filter === "todo" ? "Everything is counted" : "Nothing to show"} />
      ) : (
        <div className="table-wrap">
          <table className="table lines-table">
            <caption className="sr-only">Count sheet</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num hide-xs">System</th>
                <th scope="col" className="num">Counted</th>
                <th scope="col" className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const sys = l.counted !== null && l.adjustment !== null ? l.counted - l.adjustment : (l.systemAtCount ?? l.expected);
                const diff = l.counted === null ? null : Math.round((l.counted - sys) * 1000) / 1000;
                return (
                  <tr key={l.variantId} className={diff ? "changed" : undefined}>
                    <td>
                      {l.name}
                      <span className="cell-sub">{l.barcode ?? l.sku ?? ""}</span>
                    </td>
                    <td className="num hide-xs">{qtyUnit(sys, l.uom)}</td>
                    <td className="num">
                      {open ? (
                        <input
                          ref={(el) => {
                            inputs.current[l.variantId] = el;
                          }}
                          aria-label={`Counted ${l.name}`}
                          inputMode="decimal"
                          value={values[l.variantId] ?? ""}
                          aria-invalid={values[l.variantId]?.trim() && parseQty(values[l.variantId]!, l.uom, true) === null ? true : undefined}
                          onChange={(e) => {
                            setValues({ ...values, [l.variantId]: e.target.value });
                            setPending({ ...pending, [l.variantId]: true });
                          }}
                        />
                      ) : l.counted === null ? (
                        <span className="muted">Not counted</span>
                      ) : (
                        qtyUnit(l.counted, l.uom)
                      )}
                    </td>
                    <td className={diff && diff < 0 ? "num strong bad" : diff ? "num strong good" : "num muted"}>
                      {diff === null ? "–" : `${diff > 0 ? "+" : ""}${qtyUnit(diff, l.uom)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <Modal onClose={() => setConfirm(null)} label={confirm === "complete" ? "Complete count" : "Cancel count"}>
          <h2>{confirm === "complete" ? "Complete this count?" : "Cancel this count?"}</h2>
          {confirm === "complete" ? (
            <>
              <p>
                Stock for the {counted} counted product{counted === 1 ? "" : "s"} is set to what you counted. This cannot be undone, but you can
                count again.
              </p>
              {counted < c.lines.length && (
                <label className="check-row">
                  <input type="checkbox" checked={zeroUncounted} onChange={(e) => setZeroUncounted(e.target.checked)} />
                  Set the {c.lines.length - counted} products not counted to zero
                </label>
              )}
            </>
          ) : (
            <p>Nothing changes in stock. The figures typed so far are kept on record.</p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Back
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act(confirm)}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {confirm === "complete" ? "Complete and correct stock" : "Cancel count"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
