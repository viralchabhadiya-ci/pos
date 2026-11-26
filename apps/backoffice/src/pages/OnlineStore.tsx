import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { dateTime, money, time, tryParseMoney } from "../lib/format.js";
import type { Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

type Status = "new" | "accepted" | "ready" | "collected" | "cancelled";
interface WebOrder {
  id: string;
  number: string;
  status: Status;
  name: string;
  phone: string;
  email: string | null;
  note: string | null;
  lines: { variantId: string; name: string; qty: number; unitPrice: number }[];
  total: number;
  taxTotal: number;
  pickupCode: string;
  storeId: string;
  storeName: string;
  orderId: string | null;
  orderNumber: string | null;
  cancelReason: string | null;
  createdAt: string;
  readyAt: string | null;
  collectedAt: string | null;
  cancelledAt: string | null;
  customerLink?: string | null;
}
interface Settings {
  slug: string;
  enabled: boolean;
  pickupStoreIds: string[];
  notice: string | null;
  minOrder: number;
  readyMinutes: number;
  checkStock: boolean;
  isNew?: boolean;
}
interface Overview {
  settings: Settings;
  products: { online: number; active: number };
  shopUrl: string | null;
  shopAppConfigured: boolean;
}

const STATUS: Record<Status, { label: string; tone?: "good" | "warn" }> = {
  new: { label: "New", tone: "warn" },
  accepted: { label: "Being packed" },
  ready: { label: "Ready", tone: "good" },
  collected: { label: "Collected" },
  cancelled: { label: "Cancelled" },
};
const Badge = ({ s }: { s: Status }) => <span className={`badge${STATUS[s].tone ? ` ${STATUS[s].tone}` : ""}`}>{STATUS[s].label}</span>;

/** Online store: click-and-collect orders, which products are sold online, and the shop's settings. */
export function OnlineStore({ me, tab }: { me: Me; tab?: string }) {
  const hq = me.user.storeIds === null;
  const current = hq && (tab === "products" || tab === "settings") ? tab : "orders";
  const overview = useLoad(() => api<Overview>("/online-store"), []);
  const o = overview.data;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Online store</h1>
          <p className="muted">Customers order on your shop page and pay when they collect. The till rings the order up, so stock, VAT and receipts work as usual.</p>
        </div>
        {o?.shopUrl && o.settings.enabled && (
          <a className="btn" href={o.shopUrl} target="_blank" rel="noreferrer">
            <Icon name="send" /> Open the shop
          </a>
        )}
      </header>
      {o && !o.settings.enabled && hq && (
        <div className="callout" role="note">
          <p>
            {o.settings.isNew ? "Your shop is not open yet." : "Your shop is switched off."} Pick the products to sell, then switch it on in Settings.
          </p>
          <a className="btn sm" href="#/online-store/settings">
            Settings
          </a>
        </div>
      )}
      {hq && (
        <div className="tabs" role="tablist" aria-label="Online store">
          {(
            [
              ["orders", "Orders", "#/online-store"],
              ["products", `Products${o ? ` (${o.products.online})` : ""}`, "#/online-store/products"],
              ["settings", "Settings", "#/online-store/settings"],
            ] as const
          ).map(([id, label, href]) => (
            <a key={id} role="tab" className="tab tab-link" aria-selected={current === id} href={href}>
              {label}
            </a>
          ))}
        </div>
      )}
      {current === "orders" ? (
        <Orders />
      ) : current === "products" ? (
        <Products onChanged={overview.reload} />
      ) : overview.error ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : !o ? (
        <SkeletonRows rows={4} />
      ) : (
        <SettingsForm overview={o} me={me} onSaved={overview.reload} />
      )}
    </div>
  );
}

// Orders

function Orders() {
  const [filter, setFilter] = useState<"open" | "collected" | "cancelled">("open");
  const list = useLoad(() => api<{ orders: WebOrder[]; counts: { new: number; open: number } }>(`/web-orders?status=${filter}`), [filter]);
  const [open, setOpen] = useState<string | null>(null);
  // New orders arrive while the page is open.
  useEffect(() => {
    if (filter !== "open") return;
    const timer = setInterval(() => list.reload(), 30_000);
    return () => clearInterval(timer);
  }, [filter, list.reload]);

  return (
    <>
      <div className="chips" role="group" aria-label="Show">
        {(
          [
            ["open", `Waiting${list.data ? ` (${list.data.counts.open})` : ""}`],
            ["collected", "Collected"],
            ["cancelled", "Cancelled"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="spacer" />
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows rows={4} />
      ) : list.data.orders.length === 0 ? (
        <EmptyState icon="receipt" title={filter === "open" ? "No orders waiting" : "Nothing here yet"}>
          {filter === "open" && <p className="muted">New online orders show up here and on the tills of the store they are collected from.</p>}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Online orders</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Customer</th>
                <th scope="col" className="hide-sm">Store</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Total (AED)</th>
              </tr>
            </thead>
            <tbody>
              {list.data.orders.map((w) => (
                <tr key={w.id}>
                  <td>
                    <button type="button" className="row-link plain" onClick={() => setOpen(w.id)}>
                      {w.number}
                    </button>
                    <span className="cell-sub">{filter === "open" ? time(w.createdAt) : dateTime(w.createdAt)}</span>
                  </td>
                  <td>
                    {w.name}
                    <span className="cell-sub tnum">{w.phone}</span>
                  </td>
                  <td className="hide-sm">{w.storeName}</td>
                  <td>
                    <Badge s={w.status} />
                  </td>
                  <td className="num strong">{money(w.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderPanel id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </>
  );
}

function OrderPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const detail = useLoad(() => api<WebOrder>(`/web-orders/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const step = async (s: "accept" | "ready" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/web-orders/${id}/${s}`, { method: "POST", body: s === "cancel" ? { reason: reason.trim() || null } : {} });
      toast(s === "accept" ? "Accepted" : s === "ready" ? "Marked ready. The customer has been told." : "Cancelled. The customer has been told.");
      setCancelling(false);
      await detail.reload();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const w = detail.data;
  return (
    <Modal onClose={onClose} label={w ? `Order ${w.number}` : "Online order"} wide>
      {detail.error ? (
        <ErrorState message={detail.error} onRetry={detail.reload} />
      ) : !w ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <div className="panel-title">
            <h2>
              {w.number} <Badge s={w.status} />
            </h2>
          </div>
          <p className="muted">
            {w.name} · <span className="tnum">{w.phone}</span>
            {w.email && ` · ${w.email}`} · Collect at {w.storeName} · Code <strong className="tnum">{w.pickupCode}</strong>
          </p>
          {w.note && <p className="message-preview">“{w.note}”</p>}
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Items</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="num">Qty</th>
                  <th scope="col" className="num">Price (AED)</th>
                </tr>
              </thead>
              <tbody>
                {w.lines.map((l) => (
                  <tr key={l.variantId}>
                    <td>{l.name}</td>
                    <td className="num">{l.qty}</td>
                    <td className="num">{money(l.unitPrice)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total, VAT {money(w.taxTotal)} included</td>
                  <td className="num strong">{money(w.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="hint">
            Placed {dateTime(w.createdAt)}
            {w.readyAt && ` · Ready ${dateTime(w.readyAt)}`}
            {w.collectedAt && ` · Collected ${dateTime(w.collectedAt)}`}
            {w.orderNumber && w.orderId && (
              <>
                {" "}
                as bill{" "}
                <a className="row-link tnum" href={`#/sales/${w.orderId}`} onClick={onClose}>
                  {w.orderNumber}
                </a>
              </>
            )}
            {w.cancelledAt && ` · Cancelled ${dateTime(w.cancelledAt)}${w.cancelReason ? `: ${w.cancelReason}` : ""}`}
          </p>
          {["new", "accepted", "ready"].includes(w.status) && (
            <p className="hint">The customer pays at the till when they collect. Ring it up from Online orders on the till.</p>
          )}
          {cancelling && (
            <Field label="Reason for the customer" hint="Sent to them by message, e.g. Out of stock today.">
              {(p) => <input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />}
            </Field>
          )}
          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert" /> {error}
            </p>
          )}
          {["new", "accepted", "ready"].includes(w.status) && (
            <div className="dialog-actions">
              {cancelling ? (
                <>
                  <button type="button" className="btn" onClick={() => setCancelling(false)} disabled={busy}>
                    Keep the order
                  </button>
                  <button type="button" className="btn danger-solid" onClick={() => step("cancel")} disabled={busy}>
                    Cancel order
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn ghost danger push-start" onClick={() => setCancelling(true)} disabled={busy}>
                    Cancel order
                  </button>
                  {w.status === "new" && (
                    <button type="button" className="btn" onClick={() => step("accept")} disabled={busy}>
                      Accept
                    </button>
                  )}
                  {w.status !== "ready" && (
                    <button type="button" className="btn primary" onClick={() => step("ready")} disabled={busy}>
                      {busy && <span className="spinner" aria-hidden="true" />} Packed and ready
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// Products

interface ShopProduct {
  id: string;
  name: string;
  description: string | null;
  online: boolean;
  categoryName: string | null;
  price: number;
}

function Products({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "online" | "offline">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ShopProduct | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => api<{ products: ShopProduct[] }>(`/online-store/products?filter=${filter}&q=${encodeURIComponent(search)}`), [filter, search]);
  const rows = list.data?.products ?? [];

  const setOnline = async (ids: string[], online: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ changed: number }>("/online-store/products", { body: { productIds: ids, online } });
      toast(online ? `${r.changed} ${r.changed === 1 ? "product is" : "products are"} on the shop` : `${r.changed} taken off the shop`);
      setPicked(new Set());
      await list.reload();
      onChanged();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  return (
    <>
      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search products" placeholder="Product name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="chips" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["online", "On the shop"],
              ["offline", "Not on the shop"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {picked.size > 0 && (
        <div className="callout" role="region" aria-label="Selected products">
          <p>
            <strong>{picked.size}</strong> selected
          </p>
          <div className="head-actions">
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => setOnline([...picked], true)}>
              Put on the shop
            </button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => setOnline([...picked], false)}>
              Take off
            </button>
          </div>
        </div>
      )}
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <EmptyState icon="box" title="No products match" />
      ) : (
        <div className="table-wrap" aria-busy={list.loading}>
          <table className="table">
            <caption className="sr-only">Products on the shop</caption>
            <thead>
              <tr>
                <th scope="col" className="check-col">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
                <th scope="col">Product</th>
                <th scope="col" className="hide-sm">Category</th>
                <th scope="col" className="num hide-xs">Price (AED)</th>
                <th scope="col">On the shop</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="check-col">
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.name}`}
                      checked={picked.has(p.id)}
                      onChange={() =>
                        setPicked((s) => {
                          const n = new Set(s);
                          if (n.has(p.id)) n.delete(p.id);
                          else n.add(p.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button type="button" className="row-link plain" onClick={() => setEditing(p)}>
                      {p.name}
                    </button>
                    {p.description && <span className="cell-sub clamp">{p.description}</span>}
                  </td>
                  <td className="hide-sm">{p.categoryName ?? <span className="muted">None</span>}</td>
                  <td className="num hide-xs">{money(p.price)}</td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={p.online} disabled={busy} onChange={(e) => setOnline([p.id], e.target.checked)} />
                      <span className="sr-only">Sell {p.name} online</span>
                      <span aria-hidden="true">{p.online ? "Yes" : "No"}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ProductDialog
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function ProductDialog({ product, onClose, onSaved }: { product: ShopProduct; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [online, setOnline] = useState(product.online);
  const [description, setDescription] = useState(product.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/online-store/products/${product.id}`, { method: "PUT", body: { online, description } });
      toast(`${product.name} saved`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={`${product.name} on the shop`}>
      <h2>{product.name}</h2>
      <form onSubmit={submit} noValidate>
        <label className="check">
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
          <span>Sell on the online shop</span>
        </label>
        <Field label="Description" hint="Shown to customers under the name, e.g. size or origin. Optional.">
          {(p) => <textarea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />}
        </Field>
        <p className="hint">Name, price and category come from Products. Each store's own prices and range apply.</p>
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
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Settings

function SettingsForm({ overview, me, onSaved }: { overview: Overview; me: Me; onSaved: () => void }) {
  const toast = useToast();
  const s = overview.settings;
  const [form, setForm] = useState({
    slug: s.slug,
    enabled: s.enabled,
    pickupStoreIds: s.pickupStoreIds,
    notice: s.notice ?? "",
    minOrder: s.minOrder ? money(s.minOrder).replace(/,/g, "") : "",
    readyMinutes: String(s.readyMinutes),
    checkStock: s.checkStock,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = me.user.role === "owner";
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const slug = form.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) errs.slug = "Use 3 to 40 lowercase letters, numbers and dashes, e.g. al-noor";
    const minOrder = form.minOrder.trim() ? tryParseMoney(form.minOrder) : 0;
    if (minOrder === null || minOrder < 0) errs.minOrder = "Enter an amount in AED, like 50";
    const ready = Number(form.readyMinutes);
    if (!Number.isInteger(ready) || ready < 5 || ready > 1440) errs.readyMinutes = "Between 5 and 1440 minutes";
    if (form.enabled && !form.pickupStoreIds.length) errs.stores = "Pick at least one store.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`os-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api("/online-store", {
        method: "PUT",
        body: { slug, enabled: form.enabled, pickupStoreIds: form.pickupStoreIds, notice: form.notice, minOrder, readyMinutes: ready, checkStock: form.checkStock },
      });
      toast(form.enabled ? "Shop saved. It is open." : "Shop saved");
      onSaved();
    } catch (err) {
      const msg = errorText(err);
      if (/address/i.test(msg)) setErrors({ slug: msg });
      else setFormError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <fieldset className="plain-fieldset" disabled={!isOwner}>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>
            Shop is open
            <span className="hint">Switch off to stop new orders. Customers can still see orders they placed.</span>
          </span>
        </label>
        <Field
          id="os-slug"
          label="Shop address"
          required
          error={errors.slug}
          hint={overview.shopAppConfigured ? `Customers open ${overview.shopUrl?.replace(/#\/.*$/, "") ?? ""}#/${form.slug || "your-name"}` : "The part after the shop's web address."}
        >
          {(p) => <input {...p} value={form.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} maxLength={40} autoCapitalize="none" spellCheck={false} />}
        </Field>
        <fieldset className="plain-fieldset">
          <legend className="field-label">Collect from</legend>
          {errors.stores && (
            <p className="form-error" role="alert" id="os-stores">
              {errors.stores}
            </p>
          )}
          {me.stores.map((st) => (
            <label className="check" key={st.id}>
              <input
                type="checkbox"
                checked={form.pickupStoreIds.includes(st.id)}
                onChange={(e) => set("pickupStoreIds", e.target.checked ? [...form.pickupStoreIds, st.id] : form.pickupStoreIds.filter((x) => x !== st.id))}
              />
              <span>{st.name}</span>
            </label>
          ))}
        </fieldset>
        <div className="form-grid">
          <Field id="os-readyMinutes" label="Ready within (minutes)" error={errors.readyMinutes} hint="What the shop page promises.">
            {(p) => <input {...p} inputMode="numeric" value={form.readyMinutes} onChange={(e) => set("readyMinutes", e.target.value)} />}
          </Field>
          <Field id="os-minOrder" label="Minimum order (AED)" error={errors.minOrder} hint="Empty for none.">
            {(p) => <input {...p} inputMode="decimal" value={form.minOrder} onChange={(e) => set("minOrder", e.target.value)} />}
          </Field>
        </div>
        <Field label="Note on the shop page" hint="e.g. Open 8 am to 11 pm. Collect from the counter by the entrance.">
          {(p) => <textarea {...p} rows={2} value={form.notice} onChange={(e) => set("notice", e.target.value)} maxLength={300} />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.checkStock} onChange={(e) => set("checkStock", e.target.checked)} />
          <span>
            Only sell what is in stock
            <span className="hint">Untick if your stock figures are not kept up to date; everything will show as available.</span>
          </span>
        </label>
      </fieldset>
      {!overview.shopAppConfigured && (
        <p className="hint">The server needs SHOP_URL, the shop app's web address, to put order links in customers' messages.</p>
      )}
      {formError && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {formError}
        </p>
      )}
      {isOwner ? (
        <div className="dialog-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />} Save
          </button>
        </div>
      ) : (
        <p className="hint">Only the owner can change these.</p>
      )}
    </form>
  );
}
