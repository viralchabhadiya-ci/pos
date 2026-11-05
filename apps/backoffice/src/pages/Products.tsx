import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, download, errorText } from "../lib/api.js";
import { money, qty, tryParseMoney } from "../lib/format.js";
import type { Category, Me, Product, Tax } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

export function Products({ me, initialStatus }: { me: Me; initialStatus?: string }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState(initialStatus === "low" ? "low" : "active");
  const [importing, setImporting] = useState(false);
  const toast = useToast();
  const [editing, setEditing] = useState<Product | "new" | null>(null);

  // Wait for a pause in typing before searching, so each keystroke does not hit the server.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const refs = useLoad(
    async () => {
      const [c, t] = await Promise.all([api<{ categories: Category[] }>("/categories"), api<{ taxes: Tax[] }>("/taxes")]);
      return { categories: c.categories, taxes: t.taxes };
    },
    [],
  );
  const list = useLoad(() => {
    const p = new URLSearchParams({ status });
    if (search) p.set("q", search);
    if (categoryId) p.set("categoryId", categoryId);
    return api<{ products: Product[] }>(`/products?${p}`);
  }, [search, categoryId, status]);

  const products = list.data?.products ?? [];
  const filtered = search || categoryId || status !== "active";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Products</h1>
          <p className="muted">Price changes reach every till within a minute.</p>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="btn"
            onClick={() => download("/products/export.csv", "products.csv").catch((err) => toast(errorText(err)))}
          >
            <Icon name="download" /> Export
          </button>
          <button type="button" className="btn" onClick={() => setImporting(true)}>
            <Icon name="upload" /> Import
          </button>
          <button type="button" className="btn primary" onClick={() => setEditing("new")} disabled={!refs.data}>
            <Icon name="plus" /> Add product
          </button>
        </div>
      </header>

      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search products"
            placeholder="Search by name, Arabic name or barcode"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select aria-label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {refs.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">On sale</option>
          <option value="low">Low stock</option>
          <option value="inactive">Hidden from tills</option>
          <option value="all">All</option>
        </select>
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <SkeletonRows />
      ) : products.length === 0 ? (
        <EmptyState icon="box" title={status === "low" && !search && !categoryId ? "Nothing is low on stock" : filtered ? "No products match" : "No products yet"}>
          {filtered ? (
            <button type="button" className="btn" onClick={() => (setQ(""), setCategoryId(""), setStatus("active"))}>
              Clear filters
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> Add your first product
            </button>
          )}
        </EmptyState>
      ) : (
        <div className="table-wrap" aria-busy={list.loading}>
          <table className="table">
            <caption className="sr-only">Products</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="hide-sm">Category</th>
                <th scope="col" className="hide-sm">Barcode</th>
                <th scope="col" className="num">Price (AED)</th>
                <th scope="col" className="num hide-xs">In stock</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className={p.active ? undefined : "dim"}>
                  <td>
                    <span className="cell-main">{p.name}</span>
                    {p.nameAr && (
                      <span className="cell-sub" dir="rtl" lang="ar">
                        {p.nameAr}
                      </span>
                    )}
                    {!p.active && <span className="badge">Hidden</span>}
                  </td>
                  <td className="hide-sm">{p.categoryName ?? <span className="muted">None</span>}</td>
                  <td className="hide-sm num">
                    {p.barcode ?? <span className="muted">None</span>}
                    {p.extraBarcodes.length > 0 && <span className="cell-sub">+{p.extraBarcodes.length} more</span>}
                  </td>
                  <td className="num strong">
                    {money(p.price)}
                    {p.uom === "kg" && <span className="muted"> /kg</span>}
                  </td>
                  <td className={p.onHand < 0 ? "num hide-xs bad" : "num hide-xs"}>
                    {qty(p.onHand)}
                    {p.reorderLevel !== null && p.onHand <= p.reorderLevel && (
                      <span className="badge warn">
                        <Icon name="alert" size={14} /> Low
                      </span>
                    )}
                  </td>
                  <td className="actions">
                    <button type="button" className="btn ghost sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                      <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {products.length === 500 && <p className="muted table-note">Showing the first 500. Search to narrow the list.</p>}
        </div>
      )}

      {editing && refs.data && (
        <ProductDialog
          product={editing === "new" ? null : editing}
          categories={refs.data.categories}
          taxes={refs.data.taxes}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void list.reload();
            void refs.reload();
          }}
        />
      )}
    </div>
  );
}

interface ImportResult {
  rows: number;
  create: number;
  update: number;
  newCategories: string[];
  errors: { row: number; message: string }[];
  saved: boolean;
}

/** Check the file first, show what will change, then save it all at once. */
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async (f: File) => {
    setError(null);
    setResult(null);
    if (f.size > 5_000_000) return setError("The file is larger than 5 MB. Split it into smaller files.");
    const text = await f.text();
    setFile({ name: f.name, text });
    setBusy(true);
    try {
      setResult(await api<ImportResult>("/products/import", { body: { csv: text, dryRun: true } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ImportResult>("/products/import", { body: { csv: file.text, dryRun: false } });
      if (!res.saved) {
        setResult(res);
        return;
      }
      toast(`Imported: ${res.create} added, ${res.update} updated`);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ok = result && result.errors.length === 0;
  return (
    <Modal onClose={onClose} label="Import products" wide>
      <h2>Import products</h2>
      <p className="muted">
        Use a CSV file with the columns <code>name</code> and <code>price</code>, plus any of <code>name_ar</code>, <code>category</code>,{" "}
        <code>barcode</code>, <code>extra_barcodes</code> (separate with |), <code>sku</code>, <code>cost</code>, <code>vat</code>,{" "}
        <code>unit</code> (unit or kg), <code>reorder_level</code> and <code>active</code> (yes or no). Rows with a known barcode or
        SKU update that product. Export first to get a file in the right shape.
      </p>
      <Field label="CSV file">
        {(p) => (
          <input {...p} type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void check(e.target.files[0])} />
        )}
      </Field>
      {busy && !result && (
        <p className="muted" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Checking the file…
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      {result && (
        <div aria-live="polite">
          {ok ? (
            <p className="import-ok">
              <Icon name="check" /> {result.rows} rows look good: <strong>{result.create}</strong> new and <strong>{result.update}</strong> to
              update.
              {result.newCategories.length > 0 && <> New categories: {result.newCategories.join(", ")}.</>}
            </p>
          ) : (
            <>
              <p className="form-error" role="alert">
                <Icon name="alert" /> Nothing was saved. Fix {result.errors.length === 1 ? "this row" : `these ${result.errors.length} rows`} and
                choose the file again.
              </p>
              <ul className="import-errors">
                {result.errors.slice(0, 50).map((e) => (
                  <li key={e.row}>
                    <strong>Row {e.row}:</strong> {e.message}
                  </li>
                ))}
                {result.errors.length > 50 && <li>…and {result.errors.length - 50} more</li>}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!ok || busy} onClick={save}>
          {busy && result && <span className="spinner" aria-hidden="true" />}
          {busy && result ? "Importing…" : ok ? `Import ${result.rows} products` : "Import"}
        </button>
      </div>
    </Modal>
  );
}

function ProductDialog({
  product,
  categories,
  taxes,
  me,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: Category[];
  taxes: Tax[];
  me: Me;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const defaultTax = taxes.find((t) => t.active)?.id ?? "";
  const [form, setForm] = useState({
    name: product?.name ?? "",
    nameAr: product?.nameAr ?? "",
    categoryId: product?.categoryId ?? "",
    taxId: product?.taxId ?? defaultTax,
    uom: product?.uom ?? ("unit" as "unit" | "kg"),
    price: product ? money(product.price).replace(/,/g, "") : "",
    cost: product?.cost != null ? money(product.cost).replace(/,/g, "") : "",
    barcode: product?.barcode ?? "",
    extraBarcodes: product?.extraBarcodes.join(", ") ?? "",
    sku: product?.sku ?? "",
    reorderLevel: product?.reorderLevel != null ? String(product.reorderLevel) : "",
    active: product?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const price = tryParseMoney(form.price);
    const cost = form.cost.trim() ? tryParseMoney(form.cost) : null;
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Enter the product name as it should print on the receipt.";
    if (price === null || price < 0) errs.price = "Enter a price like 4.50";
    if (form.cost.trim() && (cost === null || cost < 0)) errs.cost = "Enter a cost like 3.20, or leave it empty";
    const reorderLevel = form.reorderLevel.trim() ? Number(form.reorderLevel) : null;
    if (reorderLevel !== null && !(Number.isFinite(reorderLevel) && reorderLevel >= 0))
      errs.reorderLevel = "Enter a number like 10, or leave it empty";
    const extraBarcodes = form.extraBarcodes
      .split(/[\s,]+/)
      .map((b) => b.trim())
      .filter(Boolean);
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`pf-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    const body = {
      name: form.name,
      nameAr: form.nameAr || null,
      categoryId: form.categoryId || null,
      taxId: form.taxId || null,
      uom: form.uom,
      price,
      cost,
      barcode: form.barcode.trim() || null,
      extraBarcodes,
      sku: form.sku.trim() || null,
      reorderLevel,
      active: form.active,
    };
    try {
      if (product) await api(`/products/${product.id}`, { method: "PUT", body });
      else await api("/products", { body });
      toast(product ? `${form.name} saved` : `${form.name} added`);
      onSaved();
    } catch (err) {
      const msg = errorText(err);
      if (msg.toLowerCase().includes("barcode")) {
        const code = msg.match(/barcode (\S+)/)?.[1];
        setErrors(code && extraBarcodes.includes(code) ? { extraBarcodes: msg } : { barcode: msg });
      }
      else setFormError(msg);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={product ? `Edit ${product.name}` : "Add product"} wide>
      <h2>{product ? "Edit product" : "Add product"}</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field id="pf-name" label="Name" required error={errors.name}>
            {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={160} />}
          </Field>
          <Field label="Arabic name" hint="Prints under the English name on receipts.">
            {(p) => <input {...p} dir="rtl" lang="ar" value={form.nameAr} onChange={(e) => set("nameAr", e.target.value)} maxLength={160} />}
          </Field>
          <Field id="pf-price" label="Price (AED)" required error={errors.price} hint="VAT included.">
            {(p) => (
              <input {...p} inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} placeholder="0.00" />
            )}
          </Field>
          <Field label="Sold by">
            {(p) => (
              <select {...p} value={form.uom} onChange={(e) => set("uom", e.target.value as "unit" | "kg")}>
                <option value="unit">Piece</option>
                <option value="kg">Weight (per kg)</option>
              </select>
            )}
          </Field>
          <Field id="pf-barcode" label="Barcode" error={errors.barcode} hint="Scan it into this box or type it.">
            {(p) => (
              <input
                {...p}
                inputMode="numeric"
                value={form.barcode}
                onChange={(e) => set("barcode", e.target.value)}
                // Scanners end with Enter; that must not save a half-filled form.
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                maxLength={64}
              />
            )}
          </Field>
          <Field label="Category">
            {(p) => (
              <select {...p} value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="VAT">
            {(p) => (
              <select {...p} value={form.taxId} onChange={(e) => set("taxId", e.target.value)}>
                <option value="">No VAT</option>
                {taxes.filter((t) => t.active || t.id === form.taxId).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="pf-cost" label="Cost (AED)" error={errors.cost} hint="Optional. Used later for profit reports.">
            {(p) => <input {...p} inputMode="decimal" value={form.cost} onChange={(e) => set("cost", e.target.value)} placeholder="0.00" />}
          </Field>
          <Field label="SKU" hint="Optional internal code.">
            {(p) => <input {...p} value={form.sku} onChange={(e) => set("sku", e.target.value)} maxLength={64} />}
          </Field>
          <Field id="pf-extraBarcodes" label="More barcodes" error={errors.extraBarcodes} hint="Other packs that ring up as this product. Separate with commas.">
            {(p) => (
              <input
                {...p}
                value={form.extraBarcodes}
                onChange={(e) => set("extraBarcodes", e.target.value)}
                // A scanner's Enter adds a separator instead of saving.
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (form.extraBarcodes.trim() && !form.extraBarcodes.trim().endsWith(",")) set("extraBarcodes", `${form.extraBarcodes.trim()}, `);
                }}
              />
            )}
          </Field>
          <Field id="pf-reorderLevel" label="Low stock alert at" error={errors.reorderLevel} hint="Optional. Warns on the dashboard at or below this.">
            {(p) => (
              <input {...p} inputMode="decimal" value={form.reorderLevel} onChange={(e) => set("reorderLevel", e.target.value)} placeholder="10" />
            )}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          <span>
            On sale
            <span className="hint">Untick to hide it from the tills without deleting it.</span>
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
            {busy ? "Saving…" : product ? "Save changes" : "Add product"}
          </button>
        </div>
      </form>
      {product && <StockBox product={product} me={me} onChanged={onSaved} />}
    </Modal>
  );
}

function StockBox({ product, me, onChanged }: { product: Product; me: Me; onChanged: () => void }) {
  const toast = useToast();
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const [reason, setReason] = useState<"receive" | "adjust">("receive");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onHand, setOnHand] = useState(product.onHand);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!amount.trim() || !Number.isFinite(n) || n === 0) {
      setError(reason === "receive" ? "Enter how many came in, like 24" : "Enter the change, like -2 for two missing");
      return;
    }
    if (reason === "receive" && n < 0) {
      setError("Goods received must be more than zero. Use Correction for missing stock.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ onHand: number }>(`/products/${product.id}/stock`, { body: { storeId, qty: n, reason } });
      setOnHand(res.onHand);
      setAmount("");
      toast(`Stock for ${product.name} is now ${qty(res.onHand)}`);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stock-box" onSubmit={submit} noValidate>
      <h3>
        <Icon name="stock" /> Stock
        <span className="muted">
          {" "}
          · in stock now <strong className="num">{qty(onHand)}</strong>
        </span>
      </h3>
      <div className="stock-row">
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
        <Field label="Type">
          {(p) => (
            <select {...p} value={reason} onChange={(e) => setReason(e.target.value as "receive" | "adjust")}>
              <option value="receive">Goods received</option>
              <option value="adjust">Correction after count</option>
            </select>
          )}
        </Field>
        <Field label={reason === "receive" ? "Quantity received" : "Change (+ or −)"} error={error}>
          {(p) => <input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={reason === "receive" ? "24" : "-2"} />}
        </Field>
        <button type="submit" className="btn" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "Saving…" : "Update stock"}
        </button>
      </div>
    </form>
  );
}
