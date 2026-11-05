import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { dateTime, money } from "../lib/format.js";
import type { Customer } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const PAGE = 50;

export function Customers() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useLoad(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (search) p.set("q", search);
    return api<{ customers: Customer[]; count: number }>(`/customers?${p}`);
  }, [search, offset]);
  const data = list.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="muted">Customers added on the tills show up here. A TRN prints on a business customer's tax invoice.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" /> Add customer
        </button>
      </header>

      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search customers"
            placeholder="Name, email or phone digits"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="user" title={search ? "No customers match" : "No customers yet"}>
          <p className="muted">{search ? "Try fewer letters or the last digits of the phone." : "Cashiers can add customers while selling, or add one here."}</p>
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Customers</caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className="hide-sm">Phone</th>
                  <th scope="col" className="num hide-xs">Bills</th>
                  <th scope="col" className="num">Spent (AED)</th>
                  <th scope="col" className="hide-sm">Last visit</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button type="button" className="row-link plain" onClick={() => setViewing(c)}>
                        {c.name}
                      </button>
                      {c.trn && <span className="cell-sub tnum">TRN {c.trn}</span>}
                      {c.phone && <span className="cell-sub show-xs tnum">{c.phone}</span>}
                    </td>
                    <td className="hide-sm tnum">{c.phone ?? <span className="muted">None</span>}</td>
                    <td className="num hide-xs">{c.orders}</td>
                    <td className="num strong">{money(c.spent ?? 0)}</td>
                    <td className="hide-sm">{c.lastVisit ? dateTime(c.lastVisit) : <span className="muted">Never</span>}</td>
                    <td className="actions">
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                        <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                      </button>
                    </td>
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

      {editing && (
        <CustomerDialog
          customer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
      {viewing && <CustomerBills customer={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function CustomerDialog({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: customer?.name ?? "",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
    trn: customer?.trn ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Enter the customer's name.";
    if (form.trn.trim() && !/^\d{15}$/.test(form.trn.trim())) errs.trn = "A TRN has 15 digits.";
    if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = "Enter an email like name@example.com";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`cf-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    const body = { name: form.name, phone: form.phone.trim() || null, email: form.email.trim() || null, trn: form.trn.trim() || null };
    try {
      if (customer) await api(`/customers/${customer.id}`, { method: "PUT", body });
      else await api("/customers", { body });
      toast(customer ? `${form.name} saved` : `${form.name} added`);
      onSaved();
    } catch (err) {
      const msg = errorText(err);
      if (msg.toLowerCase().includes("phone")) setErrors({ phone: msg });
      else setFormError(msg);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={customer ? `Edit ${customer.name}` : "Add customer"}>
      <h2>{customer ? "Edit customer" : "Add customer"}</h2>
      <form onSubmit={submit} noValidate>
        <Field id="cf-name" label="Name" required error={errors.name}>
          {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={200} />}
        </Field>
        <Field id="cf-phone" label="Mobile" error={errors.phone}>
          {(p) => <input {...p} type="tel" inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="050 123 4567" maxLength={30} />}
        </Field>
        <Field id="cf-email" label="Email" error={errors.email}>
          {(p) => <input {...p} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={200} />}
        </Field>
        <Field id="cf-trn" label="TRN" error={errors.trn} hint="For businesses that need a full tax invoice. 15 digits.">
          {(p) => <input {...p} inputMode="numeric" value={form.trn} onChange={(e) => set("trn", e.target.value.replace(/\s/g, ""))} maxLength={15} />}
        </Field>
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
            {busy ? "Saving…" : customer ? "Save changes" : "Add customer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CustomerBills({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const detail = useLoad(
    () => api<Customer & { orders: { id: string; number: string; createdAt: string; total: number; isRefund: boolean }[] }>(`/customers/${customer.id}`),
    [customer.id],
  );
  return (
    <Modal onClose={onClose} label={`${customer.name}'s bills`} wide>
      <h2>{customer.name}</h2>
      <p className="muted">
        {[customer.phone, customer.email, customer.trn && `TRN ${customer.trn}`].filter(Boolean).join(" · ") || "No contact details"}
      </p>
      {detail.error ? (
        <ErrorState message={detail.error} onRetry={detail.reload} />
      ) : !detail.data ? (
        <SkeletonRows rows={3} />
      ) : detail.data.orders.length === 0 ? (
        <EmptyState icon="receipt" title="No bills yet" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Bills</caption>
            <thead>
              <tr>
                <th scope="col">Bill</th>
                <th scope="col">Time</th>
                <th scope="col" className="num">Total (AED)</th>
              </tr>
            </thead>
            <tbody>
              {detail.data.orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <a className="row-link num" href={`#/sales/${o.id}`} onClick={onClose}>
                      {o.number}
                    </a>
                    {o.isRefund && <span className="badge warn">Refund</span>}
                  </td>
                  <td>{dateTime(o.createdAt)}</td>
                  <td className={o.total < 0 ? "num strong bad" : "num strong"}>{money(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
