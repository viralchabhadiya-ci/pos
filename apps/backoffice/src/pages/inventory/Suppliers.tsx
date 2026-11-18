import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../../components/Field.js";
import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, errorText } from "../../lib/api.js";
import { dateTime, money } from "../../lib/format.js";
import type { Supplier } from "../../lib/inventory.js";
import { useLoad } from "../../lib/useLoad.js";

export function Suppliers() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useLoad(() => {
    const p = new URLSearchParams({ status });
    if (search) p.set("q", search);
    return api<{ suppliers: Supplier[] }>(`/suppliers?${p}`);
  }, [search, status]);
  const rows = list.data?.suppliers ?? [];

  return (
    <>
      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search suppliers" placeholder="Name, contact, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="inactive">Switched off</option>
          <option value="all">All</option>
        </select>
        <div className="head-actions">
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> Add supplier
          </button>
        </div>
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <EmptyState icon="truck" title={search || status !== "active" ? "No suppliers match" : "No suppliers yet"}>
          {!search && (
            <button type="button" className="btn primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> Add your first supplier
            </button>
          )}
        </EmptyState>
      ) : (
        <div className="table-wrap" aria-busy={list.loading}>
          <table className="table">
            <caption className="sr-only">Suppliers</caption>
            <thead>
              <tr>
                <th scope="col">Supplier</th>
                <th scope="col" className="hide-sm">Phone</th>
                <th scope="col" className="num hide-xs">Open orders</th>
                <th scope="col" className="hide-sm">Last delivery</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.active ? undefined : "dim"}>
                  <td>
                    <button type="button" className="row-link plain" onClick={() => setEditing(s)}>
                      {s.name}
                    </button>
                    <span className="cell-sub">
                      {[s.contactName, s.paymentTermsDays ? `Pays in ${s.paymentTermsDays} days` : "Pays on delivery", `Delivers in ${s.leadTimeDays} days`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {!s.active && <span className="badge">Off</span>}
                  </td>
                  <td className="hide-sm tnum">{s.phone ?? <span className="muted">None</span>}</td>
                  <td className="num hide-xs">
                    {s.openOrders || <span className="muted">0</span>}
                  </td>
                  <td className="hide-sm">{s.lastDelivery ? dateTime(s.lastDelivery) : <span className="muted">Never</span>}</td>
                  <td className="actions">
                    <button type="button" className="btn ghost sm" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                      <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SupplierDialog
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

export function SupplierDialog({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: supplier?.name ?? "",
    contactName: supplier?.contactName ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    trn: supplier?.trn ?? "",
    address: supplier?.address ?? "",
    paymentTermsDays: String(supplier?.paymentTermsDays ?? 0),
    leadTimeDays: String(supplier?.leadTimeDays ?? 3),
    notes: supplier?.notes ?? "",
    active: supplier?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const items = useLoad(
    () => (supplier ? api<{ items: { variantId: string; name: string; barcode: string | null; supplierSku: string | null; unitCost: number | null }[] }>(`/suppliers/${supplier.id}`) : Promise.resolve({ items: [] })),
    [supplier?.id],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = "Enter the supplier's name.";
    if (f.trn.trim() && !/^\d{15}$/.test(f.trn.trim())) errs.trn = "A TRN has 15 digits.";
    if (f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) errs.email = "Enter an email like orders@example.com";
    const terms = Number(f.paymentTermsDays);
    const lead = Number(f.leadTimeDays);
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) errs.paymentTermsDays = "Enter days from 0 to 365.";
    if (!Number.isInteger(lead) || lead < 0 || lead > 120) errs.leadTimeDays = "Enter days from 0 to 120.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`sf-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    const body = {
      name: f.name.trim(),
      contactName: f.contactName.trim() || null,
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      trn: f.trn.trim() || null,
      address: f.address.trim() || null,
      paymentTermsDays: terms,
      leadTimeDays: lead,
      notes: f.notes.trim() || null,
      active: f.active,
    };
    try {
      const res = supplier
        ? await api<{ id: string }>(`/suppliers/${supplier.id}`, { method: "PUT", body })
        : await api<{ id: string }>("/suppliers", { body });
      toast(supplier ? `${body.name} saved` : `${body.name} added`);
      onSaved(res.id);
    } catch (err) {
      const msg = errorText(err);
      if (msg.includes("name")) setErrors({ name: msg });
      else setFormError(msg);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={supplier ? `Edit ${supplier.name}` : "Add supplier"} wide>
      <h2>{supplier ? "Edit supplier" : "Add supplier"}</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field id="sf-name" label="Name" required error={errors.name}>
            {(p) => <input {...p} value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={160} />}
          </Field>
          <Field id="sf-contactName" label="Contact person">
            {(p) => <input {...p} value={f.contactName} onChange={(e) => set("contactName", e.target.value)} maxLength={120} />}
          </Field>
          <Field id="sf-phone" label="Phone">
            {(p) => <input {...p} type="tel" inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} />}
          </Field>
          <Field id="sf-email" label="Email for orders" error={errors.email}>
            {(p) => <input {...p} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} maxLength={200} />}
          </Field>
          <Field id="sf-trn" label="TRN" error={errors.trn} hint="Their VAT number, printed on the purchase order.">
            {(p) => <input {...p} inputMode="numeric" value={f.trn} onChange={(e) => set("trn", e.target.value.replace(/\s/g, ""))} maxLength={15} />}
          </Field>
          <Field id="sf-address" label="Address">
            {(p) => <input {...p} value={f.address} onChange={(e) => set("address", e.target.value)} maxLength={400} />}
          </Field>
          <Field id="sf-paymentTermsDays" label="Payment terms (days)" error={errors.paymentTermsDays} hint="0 means paid on delivery.">
            {(p) => <input {...p} inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => set("paymentTermsDays", e.target.value)} />}
          </Field>
          <Field id="sf-leadTimeDays" label="Delivery time (days)" error={errors.leadTimeDays} hint="From ordering to delivery. Used for reorder suggestions.">
            {(p) => <input {...p} inputMode="numeric" value={f.leadTimeDays} onChange={(e) => set("leadTimeDays", e.target.value)} />}
          </Field>
        </div>
        <Field id="sf-notes" label="Notes">
          {(p) => <textarea {...p} rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={1000} />}
        </Field>
        {supplier && (
          <label className="check-row">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
            Active (switched-off suppliers cannot get new orders)
          </label>
        )}
        {items.data && items.data.items.length > 0 && (
          <section className="stock-box">
            <h3>
              <Icon name="box" /> Products from this supplier
            </h3>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Products</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="hide-xs">Their code</th>
                    <th scope="col" className="num">Last cost (AED)</th>
                  </tr>
                </thead>
                <tbody>
                  {items.data.items.map((it) => (
                    <tr key={it.variantId}>
                      <td>
                        {it.name}
                        {it.barcode && <span className="cell-sub">{it.barcode}</span>}
                      </td>
                      <td className="hide-xs">{it.supplierSku ?? <span className="muted">None</span>}</td>
                      <td className="num">{it.unitCost === null ? <span className="muted">Not set</span> : money(it.unitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
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
            {busy ? "Saving…" : supplier ? "Save changes" : "Add supplier"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
