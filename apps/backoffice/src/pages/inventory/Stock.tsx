import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../../components/Field.js";
import { Icon } from "../../components/Icon.js";
import { ItemPicker } from "../../components/ItemPicker.js";
import { Modal } from "../../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, download, errorText } from "../../lib/api.js";
import { aed, dateTime, money, tryParseMoney } from "../../lib/format.js";
import { dateOnly, MOVE_LABEL, parseQty, qtyUnit, type ItemDetail, type Move, type PickItem, type StockRow, type Supplier, type Uom } from "../../lib/inventory.js";
import type { Category, Me } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";
import { StoreSelect } from "./Inventory.js";

const PAGE = 100;

export function Stock({ me }: { me: Me }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [storeId, setStoreId] = useState(me.stores.length > 1 ? "" : (me.stores[0]?.id ?? ""));
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const cats = useLoad(() => api<{ categories: Category[] }>("/categories"), []);
  const list = useLoad(() => {
    const p = new URLSearchParams({ status, limit: String(PAGE), offset: String(offset) });
    if (search) p.set("q", search);
    if (storeId) p.set("storeId", storeId);
    if (categoryId) p.set("categoryId", categoryId);
    return api<{ items: StockRow[]; count: number; value: number; noCost: number }>(`/inventory/stock?${p}`);
  }, [search, storeId, categoryId, status, offset]);
  const data = list.data;
  const filtered = !!(search || categoryId || status !== "all");

  return (
    <>
      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search stock" placeholder="Name, barcode or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <StoreSelect me={me} value={storeId} onChange={(v) => (setStoreId(v), setOffset(0))} all />
        <select aria-label="Category" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setOffset(0))}>
          <option value="">All categories</option>
          {cats.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Show" value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
          <option value="all">All products</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
          <option value="negative">Below zero</option>
        </select>
        <div className="head-actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              download(`/inventory/stock.csv${storeId ? `?storeId=${storeId}` : ""}`, "stock.csv").catch((err) => toast(errorText(err), "error"))
            }
          >
            <Icon name="download" /> Export
          </button>
          <button type="button" className="btn primary" onClick={() => setAdjusting(true)}>
            <Icon name="edit" /> Correct or write off
          </button>
        </div>
      </div>

      {data && (
        <section className="inv-kpis" aria-label="Totals">
          <div className="kpi">
            <span className="kpi-label">Products</span>
            <span className="kpi-value num">{data.count}</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Stock value at cost</span>
            <span className="kpi-value num">{aed(data.value)}</span>
            {data.noCost > 0 && <span className="kpi-note muted">{data.noCost} in stock with no cost price</span>}
          </div>
        </section>
      )}

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="stock" title={filtered ? "No products match" : "No products yet"}>
          {filtered && (
            <button type="button" className="btn" onClick={() => (setQ(""), setCategoryId(""), setStatus("all"))}>
              Clear filters
            </button>
          )}
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Stock</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="hide-sm">Category</th>
                  <th scope="col" className="num">In stock</th>
                  <th scope="col" className="num hide-xs">On its way</th>
                  <th scope="col" className="num hide-sm">Cost (AED)</th>
                  <th scope="col" className="num hide-xs">Value (AED)</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => {
                  const low = r.reorderLevel !== null && r.onHand <= r.reorderLevel;
                  return (
                    <tr key={r.variantId} className={r.active ? undefined : "dim"}>
                      <td>
                        <button type="button" className="row-link plain" onClick={() => setViewing(r.variantId)}>
                          {r.name}
                        </button>
                        <span className="cell-sub">{[r.barcode, r.supplierName].filter(Boolean).join(" · ") || "No barcode"}</span>
                      </td>
                      <td className="hide-sm">{r.categoryName ?? <span className="muted">None</span>}</td>
                      <td className={r.onHand < 0 ? "num strong bad" : "num strong"}>
                        {qtyUnit(r.onHand, r.uom)}
                        {r.onHand <= 0 && r.active ? (
                          <span className="badge bad">Out</span>
                        ) : (
                          low && (
                            <span className="badge warn">
                              <Icon name="alert" size={14} /> Low
                            </span>
                          )
                        )}
                      </td>
                      <td className="num hide-xs">{r.incoming ? qtyUnit(r.incoming, r.uom) : <span className="muted">None</span>}</td>
                      <td className="num hide-sm">{r.cost === null ? <span className="muted">Not set</span> : money(r.cost)}</td>
                      <td className="num hide-xs">{money(r.value)}</td>
                    </tr>
                  );
                })}
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

      {viewing && <ItemDialog me={me} variantId={viewing} onClose={() => setViewing(null)} onChanged={list.reload} />}
      {adjusting && (
        <AdjustDialog
          me={me}
          storeId={storeId || me.stores[0]!.id}
          onClose={() => setAdjusting(false)}
          onDone={() => {
            setAdjusting(false);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

/** One product: stock per store, suppliers, reorder levels, expiry tracking and its history. */
function ItemDialog({ me, variantId, onClose, onChanged }: { me: Me; variantId: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const item = useLoad(() => api<ItemDetail>(`/inventory/items/${variantId}`), [variantId]);
  const suppliers = useLoad(() => api<{ suppliers: Supplier[] }>("/suppliers?status=active"), []);
  const [moveOffset, setMoveOffset] = useState(0);
  const moves = useLoad(() => api<{ moves: Move[]; count: number }>(`/inventory/moves?variantId=${variantId}&limit=20&offset=${moveOffset}`), [variantId, moveOffset]);
  const [form, setForm] = useState<{
    reorderLevel: string;
    reorderQty: string;
    preferredSupplierId: string;
    trackExpiry: boolean;
    suppliers: { supplierId: string; name: string; supplierSku: string; unitCost: string }[];
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [addSupplier, setAddSupplier] = useState("");

  useEffect(() => {
    const d = item.data;
    if (!d) return;
    setForm({
      reorderLevel: d.reorderLevel === null ? "" : String(d.reorderLevel),
      reorderQty: d.reorderQty === null ? "" : String(d.reorderQty),
      preferredSupplierId: d.preferredSupplierId ?? "",
      trackExpiry: d.trackExpiry,
      suppliers: d.suppliers.map((s) => ({ supplierId: s.supplierId, name: s.name, supplierSku: s.supplierSku ?? "", unitCost: s.unitCost === null ? "" : money(s.unitCost) })),
    });
  }, [item.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || !item.data) return;
    const uom = item.data.uom;
    const errs: Record<string, string> = {};
    const level = form.reorderLevel.trim() ? parseQty(form.reorderLevel, uom, true) : null;
    const upTo = form.reorderQty.trim() ? parseQty(form.reorderQty, uom, true) : null;
    if (form.reorderLevel.trim() && level === null) errs.reorderLevel = uom === "unit" ? "Enter a whole number" : "Enter a number";
    if (form.reorderQty.trim() && upTo === null) errs.reorderQty = uom === "unit" ? "Enter a whole number" : "Enter a number";
    if (level !== null && upTo !== null && upTo < level) errs.reorderQty = "Order up to must be at least the reorder level";
    const sups = form.suppliers.map((s, i) => {
      const cost = s.unitCost.trim() ? tryParseMoney(s.unitCost) : null;
      if (s.unitCost.trim() && cost === null) errs[`cost-${i}`] = "Enter an amount like 4.50";
      return { supplierId: s.supplierId, supplierSku: s.supplierSku.trim() || null, unitCost: cost };
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api(`/inventory/items/${variantId}`, {
        method: "PUT",
        body: { reorderLevel: level, reorderQty: upTo, preferredSupplierId: form.preferredSupplierId || null, trackExpiry: form.trackExpiry, suppliers: sups },
      });
      toast(`${item.data.name} saved`);
      onChanged();
      void item.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const d = item.data;
  return (
    <Modal onClose={onClose} label={d ? d.name : "Product stock"} wide>
      {item.error ? (
        <ErrorState message={item.error} onRetry={item.reload} />
      ) : !d || !form ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <h2>{d.name}</h2>
          <p className="muted">
            {[d.barcode, d.sku && `SKU ${d.sku}`, `Price ${aed(d.price)}`, d.cost !== null ? `Average cost ${aed(d.cost)}` : "No cost price yet"]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Stock in each store</caption>
              <thead>
                <tr>
                  <th scope="col">Store</th>
                  <th scope="col" className="num">In stock</th>
                </tr>
              </thead>
              <tbody>
                {d.stores.map((s) => (
                  <tr key={s.storeId}>
                    <td>{s.name}</td>
                    <td className={s.onHand < 0 ? "num strong bad" : "num strong"}>{qtyUnit(s.onHand, d.uom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form onSubmit={save} noValidate className="stock-box">
            <h3>
              <Icon name="settings" /> Reordering and suppliers
            </h3>
            <div className="form-grid">
              <Field id="it-level" label="Reorder at" error={errors.reorderLevel} hint="Suggest an order when stock falls to this. Empty works it out from sales.">
                {(p) => <input {...p} inputMode="decimal" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />}
              </Field>
              <Field id="it-upto" label="Order up to" error={errors.reorderQty} hint="Stock to have after the delivery. Empty uses two weeks of sales.">
                {(p) => <input {...p} inputMode="decimal" value={form.reorderQty} onChange={(e) => setForm({ ...form, reorderQty: e.target.value })} />}
              </Field>
              <Field label="Main supplier">
                {(p) => (
                  <select {...p} value={form.preferredSupplierId} onChange={(e) => setForm({ ...form, preferredSupplierId: e.target.value })}>
                    <option value="">None</option>
                    {suppliers.data?.suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <label className="check-row">
                <input type="checkbox" checked={form.trackExpiry} onChange={(e) => setForm({ ...form, trackExpiry: e.target.checked })} />
                Track expiry dates (asked for when goods arrive)
              </label>
            </div>

            {form.suppliers.length > 0 && (
              <div className="table-wrap">
                <table className="table lines-table">
                  <caption className="sr-only">Suppliers of this product</caption>
                  <thead>
                    <tr>
                      <th scope="col">Supplier</th>
                      <th scope="col">Their code</th>
                      <th scope="col" className="num">Cost (AED)</th>
                      <th scope="col"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.suppliers.map((s, i) => (
                      <tr key={s.supplierId}>
                        <td>{s.name}</td>
                        <td>
                          <input
                            className="wide"
                            aria-label={`${s.name} code`}
                            value={s.supplierSku}
                            onChange={(e) => setForm({ ...form, suppliers: form.suppliers.map((x, j) => (j === i ? { ...x, supplierSku: e.target.value } : x)) })}
                          />
                        </td>
                        <td className="num">
                          <input
                            aria-label={`${s.name} cost`}
                            inputMode="decimal"
                            aria-invalid={errors[`cost-${i}`] ? true : undefined}
                            title={errors[`cost-${i}`]}
                            value={s.unitCost}
                            onChange={(e) => setForm({ ...form, suppliers: form.suppliers.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)) })}
                          />
                        </td>
                        <td className="actions">
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Remove ${s.name}`}
                            onClick={() => setForm({ ...form, suppliers: form.suppliers.filter((_, j) => j !== i) })}
                          >
                            <Icon name="trash" size={18} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="filters">
              <select aria-label="Add a supplier" value={addSupplier} onChange={(e) => setAddSupplier(e.target.value)}>
                <option value="">Add a supplier…</option>
                {suppliers.data?.suppliers
                  .filter((s) => !form.suppliers.some((x) => x.supplierId === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn"
                disabled={!addSupplier}
                onClick={() => {
                  const s = suppliers.data?.suppliers.find((x) => x.id === addSupplier);
                  if (s) setForm({ ...form, suppliers: [...form.suppliers, { supplierId: s.id, name: s.name, supplierSku: "", unitCost: "" }] });
                  setAddSupplier("");
                }}
              >
                <Icon name="plus" /> Add
              </button>
            </div>
            <div className="dialog-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>

          {d.lots.length > 0 && (
            <section className="stock-box">
              <h3>
                <Icon name="calendar" /> Batches
              </h3>
              <p className="muted small">
                {d.lots.map((l) => `${l.code}${l.expiresOn ? ` (expires ${dateOnly(l.expiresOn)})` : ""}`).join(" · ")}
              </p>
            </section>
          )}

          <section className="stock-box" aria-labelledby="it-hist">
            <h3 id="it-hist">
              <Icon name="history" /> History
            </h3>
            {moves.error ? (
              <ErrorState message={moves.error} onRetry={moves.reload} />
            ) : !moves.data ? (
              <SkeletonRows rows={3} />
            ) : moves.data.count === 0 ? (
              <p className="muted">No stock movements yet.</p>
            ) : (
              <MovesTable moves={moves.data.moves} uom={d.uom} multiStore={me.stores.length > 1} onNavigate={onClose} />
            )}
            {moves.data && moves.data.count > 20 && (
              <nav className="pager" aria-label="History pages">
                <button type="button" className="btn sm" disabled={moveOffset === 0} onClick={() => setMoveOffset(Math.max(0, moveOffset - 20))}>
                  <Icon name="chevronLeft" /> Newer
                </button>
                <span className="muted small">
                  {moveOffset + 1}–{Math.min(moveOffset + 20, moves.data.count)} of {moves.data.count}
                </span>
                <button type="button" className="btn sm" disabled={moveOffset + 20 >= moves.data.count} onClick={() => setMoveOffset(moveOffset + 20)}>
                  Older <Icon name="chevronRight" />
                </button>
              </nav>
            )}
          </section>
        </>
      )}
    </Modal>
  );
}

function refLink(m: Move): string | null {
  if (!m.refId) return null;
  if (m.refKind === "order") return `#/sales/${m.refId}`;
  if (m.refKind === "receipt" && m.poId) return `#/inventory/purchases/${m.poId}`;
  if (m.refKind === "transfer") return `#/inventory/transfers/${m.refId}`;
  if (m.refKind === "count") return `#/inventory/counts/${m.refId}`;
  return null;
}

function MovesTable({ moves, uom, multiStore, onNavigate }: { moves: Move[]; uom: Uom; multiStore: boolean; onNavigate: () => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Stock movements</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            <th scope="col" className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((m) => {
            const href = refLink(m);
            return (
              <tr key={m.id}>
                <td>
                  {dateTime(m.at)}
                  {multiStore && <span className="cell-sub">{m.storeName}</span>}
                </td>
                <td>
                  {MOVE_LABEL[m.reason]}{" "}
                  {m.refNumber &&
                    (href ? (
                      <a className="link num" href={href} onClick={onNavigate}>
                        {m.refNumber}
                      </a>
                    ) : (
                      <span className="num">{m.refNumber}</span>
                    ))}
                  <span className="cell-sub">{[m.note, m.lotCode && `Batch ${m.lotCode}`, m.userName].filter(Boolean).join(" · ")}</span>
                </td>
                <td className={m.qty < 0 ? "num strong bad" : "num strong good"}>
                  {m.qty > 0 ? "+" : ""}
                  {qtyUnit(m.qty, uom)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const WASTE_REASONS = ["Expired", "Damaged", "Stolen or missing", "Used in the shop"];

/** Corrections (either way) or write-offs for several products at once. */
function AdjustDialog({ me, storeId: initialStore, onClose, onDone }: { me: Me; storeId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [storeId, setStoreId] = useState(initialStore);
  const [reason, setReason] = useState<"waste" | "adjust">("waste");
  const [note, setNote] = useState(WASTE_REASONS[0]!);
  const [lines, setLines] = useState<{ item: PickItem; qty: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!lines.length) return setError("Add at least one product.");
    const body = [];
    for (const l of lines) {
      const neg = reason === "adjust" && l.qty.trim().startsWith("-");
      const n = parseQty(l.qty.replace(/^[-+]/, ""), l.item.uom);
      if (n === null) return setError(`Check the quantity for ${l.item.name}${l.item.uom === "unit" ? " (whole pieces)" : ""}.`);
      body.push({ variantId: l.item.variantId, qty: neg ? -n : n });
    }
    if (reason === "waste" && !note.trim()) return setError("Say why the stock is written off.");
    setBusy(true);
    try {
      const res = await api<{ value: number }>("/inventory/adjustments", { body: { storeId, reason, note: note.trim() || null, lines: body } });
      toast(reason === "waste" ? `Written off, ${aed(Math.abs(res.value))} at cost` : "Stock corrected");
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Correct or write off stock" wide>
      <h2>Correct or write off stock</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
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
          <Field label="What happened">
            {(p) => (
              <select
                {...p}
                value={reason}
                onChange={(e) => {
                  const r = e.target.value as "waste" | "adjust";
                  setReason(r);
                  setNote(r === "waste" ? WASTE_REASONS[0]! : "");
                }}
              >
                <option value="waste">Write off (expired, damaged, stolen)</option>
                <option value="adjust">Correction (count was wrong)</option>
              </select>
            )}
          </Field>
          <Field label={reason === "waste" ? "Reason" : "Note"} required={reason === "waste"}>
            {(p) =>
              reason === "waste" ? (
                <select {...p} value={note} onChange={(e) => setNote(e.target.value)}>
                  {WASTE_REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              ) : (
                <input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Optional" />
              )
            }
          </Field>
        </div>
        <ItemPicker storeId={storeId} exclude={lines.map((l) => l.item.variantId)} onPick={(item) => setLines([...lines, { item, qty: "1" }])} />
        {lines.length > 0 && (
          <div className="table-wrap">
            <table className="table lines-table">
              <caption className="sr-only">Products</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="num">In stock</th>
                  <th scope="col" className="num">{reason === "waste" ? "Thrown away" : "Add (use − to remove)"}</th>
                  <th scope="col"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.item.variantId}>
                    <td>{l.item.name}</td>
                    <td className="num">{qtyUnit(l.item.onHand, l.item.uom)}</td>
                    <td className="num">
                      <input
                        aria-label={`Quantity of ${l.item.name}`}
                        inputMode="decimal"
                        value={l.qty}
                        onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                      />
                    </td>
                    <td className="actions">
                      <button type="button" className="icon-btn" aria-label={`Remove ${l.item.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                        <Icon name="trash" size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
            {busy ? "Saving…" : reason === "waste" ? "Write off" : "Save correction"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
