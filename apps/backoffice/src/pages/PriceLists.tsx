import { useMemo, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, money, tryParseMoney } from "../lib/format.js";
import type { PriceList, PriceListItem, Product } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

/**
 * Price lists: other prices for some products, for a kind of customer (wholesale, staff) or
 * for a store. Products not on a list keep their normal price.
 */
export function PriceLists({ id }: { id?: string }) {
  return id ? <PriceListDetail id={id} /> : <PriceListIndex />;
}

function PriceListIndex() {
  const list = useLoad(() => api<{ priceLists: PriceList[] }>("/price-lists"), []);
  const [creating, setCreating] = useState(false);
  const lists = list.data?.priceLists ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Price lists</h1>
          <p className="muted">
            Other prices for wholesale customers, staff or one store. Give a list to a customer (Customers) or a store (Settings). A customer's list wins over the store's.
          </p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New price list
        </button>
      </header>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <SkeletonRows rows={3} />
      ) : lists.length === 0 ? (
        <EmptyState icon="list" title="No price lists yet">
          <p className="muted">A wholesale list for trade customers is the usual first one.</p>
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Create a price list
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Price lists</caption>
            <thead>
              <tr>
                <th scope="col">Price list</th>
                <th scope="col" className="num">Products</th>
                <th scope="col" className="num">Customers</th>
                <th scope="col" className="hide-xs">Stores</th>
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr key={l.id} className={l.active ? "clickable" : "clickable dim"}>
                  <td>
                    <a className="row-link" href={`#/price-lists/${l.id}`}>
                      {l.name}
                    </a>
                    {!l.active && <span className="badge">Off</span>}
                  </td>
                  <td className="num">{l.itemCount}</td>
                  <td className="num">{l.customerCount}</td>
                  <td className="hide-xs">{l.stores.map((s) => s.name).join(", ") || <span className="muted">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <ListDialog
          list={null}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            window.location.hash = `#/price-lists/${id}`;
          }}
        />
      )}
    </div>
  );
}

function ListDialog({ list, onClose, onSaved }: { list: { id: string; name: string; active: boolean } | null; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(list?.name ?? "");
  const [active, setActive] = useState(list?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter a name, like Wholesale");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), active };
      const res = list ? await api<{ id: string }>(`/price-lists/${list.id}`, { method: "PUT", body }) : await api<{ id: string }>("/price-lists", { body });
      toast(list ? `${body.name} saved` : `${body.name} created`);
      onSaved(res.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={list ? `Edit ${list.name}` : "New price list"}>
      <h2>{list ? "Edit price list" : "New price list"}</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Name" required>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>
            On
            <span className="hint">Switched off, customers and stores on this list get normal prices.</span>
          </span>
        </label>
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
            {busy ? "Saving…" : list ? "Save changes" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PriceListDetail({ id }: { id: string }) {
  const toast = useToast();
  const detail = useLoad(() => api<{ id: string; name: string; active: boolean; items: PriceListItem[] }>(`/price-lists/${id}`), [id]);
  const products = useLoad(() => api<{ products: Product[] }>("/products"), []);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<Product | null>(null);
  const [newPrice, setNewPrice] = useState("");
  const [percent, setPercent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = detail.data?.items ?? [];
  const onList = useMemo(() => new Set(items.map((i) => i.variantId)), [items]);
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return (products.data?.products ?? [])
      .filter((p) => !onList.has(p.variantId) && (p.name.toLowerCase().includes(q) || p.barcode === q || p.sku?.toLowerCase() === q))
      .slice(0, 8);
  }, [search, products.data, onList]);

  const save = async (rows: { variantId: string; price: number }[], message: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/price-lists/${id}/items`, { method: "PUT", body: { items: rows } });
      toast(message);
      await detail.reload();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!adding) return;
    const price = tryParseMoney(newPrice);
    if (price === null || price < 0) return setError("Enter the price on this list, like 4.50");
    if (await save([{ variantId: adding.variantId, price }], `${adding.name} added at ${aed(price)}`)) {
      setAdding(null);
      setNewPrice("");
      setSearch("");
      document.getElementById("pl-search")?.focus();
    }
  };

  /** Sets every product on the list to a percentage below its normal price. */
  const applyPercent = async () => {
    const pc = Number(percent);
    if (!Number.isFinite(pc) || pc <= 0 || pc >= 100) return setError("Enter a percentage between 0 and 100");
    await save(
      items.map((i) => ({ variantId: i.variantId, price: Math.round((i.basePrice * (100 - pc)) / 100) })),
      `${items.length} prices set to ${pc}% below normal`,
    );
    setPercent("");
  };

  const remove = async (i: PriceListItem) => {
    try {
      await api(`/price-lists/${id}/items/${i.variantId}`, { method: "DELETE" });
      toast(`${i.name} back to its normal price`);
      await detail.reload();
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  if (detail.error) return <div className="page"><ErrorState message={detail.error} onRetry={detail.reload} /></div>;
  if (!detail.data) return <div className="page"><SkeletonRows rows={5} /></div>;
  const d = detail.data;
  return (
    <div className="page">
      <a className="back-link" href="#/price-lists">
        ← Price lists
      </a>
      <header className="page-head">
        <div>
          <h1>
            {d.name}
            {!d.active && <span className="badge">Off</span>}
          </h1>
          <p className="muted">{items.length} product{items.length === 1 ? "" : "s"} with their own price on this list.</p>
        </div>
        <button type="button" className="btn" onClick={() => setEditing(true)}>
          <Icon name="edit" /> Rename or switch off
        </button>
      </header>

      <form className="panel" onSubmit={add}>
        <h2>Add a product</h2>
        <div className="add-row">
          {!adding ? (
            <Field id="pl-search" label="Product" hint="Search by name, barcode or SKU.">
              {(p) => <input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" placeholder="Search products" />}
            </Field>
          ) : (
            <>
              <div className="field">
                <span className="field-label">Product</span>
                <p className="picked-one">
                  <strong>{adding.name}</strong> <span className="muted">normally {aed(adding.price)}</span>
                  <button type="button" className="btn ghost sm" onClick={() => setAdding(null)}>
                    Change
                  </button>
                </p>
              </div>
              <Field id="pl-price" label="Price on this list (AED)" required>
                {(p) => <input {...p} inputMode="decimal" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} autoFocus placeholder="0.00" />}
              </Field>
              <button type="submit" className="btn primary" disabled={busy}>
                <Icon name="plus" /> Add
              </button>
            </>
          )}
        </div>
        {!adding && matches.length > 0 && (
          <ul className="pick-results">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setAdding(m);
                    setNewPrice(money(m.price).replace(/,/g, ""));
                  }}
                >
                  <Icon name="plus" size={16} /> {m.name} <span className="muted">{aed(m.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
      </form>

      {items.length === 0 ? (
        <EmptyState icon="list" title="No products on this list yet">
          <p className="muted">Add the products that should cost something else for these customers.</p>
        </EmptyState>
      ) : (
        <>
          <div className="panel bulk-row">
            <label htmlFor="pl-pct">Set all to</label>
            <input id="pl-pct" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10" />
            <span>% below normal price</span>
            <button type="button" className="btn" disabled={busy || !percent} onClick={() => void applyPercent()}>
              Apply
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Prices on {d.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="num hide-xs">Normal</th>
                  <th scope="col" className="num">On this list</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <ItemRow key={`${i.variantId}:${i.price}`} item={i} busy={busy} onSave={(price) => save([{ variantId: i.variantId, price }], `${i.name} now ${aed(price)}`)} onRemove={() => void remove(i)} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && (
        <ListDialog
          list={d}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void detail.reload();
          }}
        />
      )}
    </div>
  );
}

function ItemRow({ item, busy, onSave, onRemove }: { item: PriceListItem; busy: boolean; onSave: (price: number) => Promise<boolean>; onRemove: () => void }) {
  const [value, setValue] = useState(money(item.price).replace(/,/g, ""));
  const parsed = tryParseMoney(value);
  const changed = parsed !== null && parsed !== item.price;
  const diff = item.basePrice ? Math.round(((item.price - item.basePrice) / item.basePrice) * 1000) / 10 : 0;
  return (
    <tr className={item.productActive ? undefined : "dim"}>
      <td>
        <span className="cell-main">{item.name}</span>
        <span className="cell-sub">
          {item.barcode ?? item.sku ?? ""}
          {diff !== 0 && <span className={diff < 0 ? "good" : "bad"}> {diff > 0 ? "+" : ""}{diff}%</span>}
        </span>
      </td>
      <td className="num hide-xs">{money(item.basePrice)}</td>
      <td className="num">
        <form
          className="price-cell"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed && parsed !== null) void onSave(parsed);
          }}
        >
          <label className="sr-only" htmlFor={`pl-${item.variantId}`}>
            Price of {item.name} on this list
          </label>
          <input id={`pl-${item.variantId}`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={parsed === null || undefined} />
          {changed && (
            <button type="submit" className="btn primary sm" disabled={busy}>
              Save
            </button>
          )}
        </form>
      </td>
      <td className="actions">
        <button type="button" className="btn ghost sm" onClick={onRemove} aria-label={`Remove ${item.name} from the list`}>
          <Icon name="close" size={18} /> <span className="hide-xs">Remove</span>
        </button>
      </td>
    </tr>
  );
}
