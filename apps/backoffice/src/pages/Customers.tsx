import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, dateTime, money } from "../lib/format.js";
import type { Customer, CustomerLoyalty, Me, PriceList } from "../lib/types.js";
import { AdjustDialog, MOVE_LABEL, signedPts } from "./Loyalty.js";
import { useLoad } from "../lib/useLoad.js";

const PAGE = 50;

export function Customers({ me }: { me: Me }) {
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
                  <th scope="col" className="num hide-sm">Points</th>
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
                      {c.priceListName && (
                        <span className="cell-sub">
                          <Icon name="list" size={14} /> {c.priceListName} prices
                        </span>
                      )}
                      {c.phone && <span className="cell-sub show-xs tnum">{c.phone}</span>}
                    </td>
                    <td className="hide-sm tnum">{c.phone ?? <span className="muted">None</span>}</td>
                    <td className="num hide-xs">{c.orders}</td>
                    <td className="num strong">{money(c.spent ?? 0)}</td>
                    <td className="num hide-sm">{c.points ? c.points.toLocaleString("en-AE") : <span className="muted">0</span>}</td>
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
      {viewing && <CustomerBills customer={viewing} owner={me.user.role === "owner"} onClose={() => setViewing(null)} onChanged={list.reload} />}
    </div>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CONSENT_FROM: Record<string, string> = { till: "at the till", back_office: "in the back office", unsubscribe_link: "by the customer's unsubscribe link" };

/** Editing needs the full record (birthday, tags, consent), which the list does not carry. */
function CustomerDialog({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
  const full = useLoad(() => (customer ? api<Customer>(`/customers/${customer.id}`) : Promise.resolve(null)), [customer?.id]);
  if (customer && !full.data) {
    return (
      <Modal onClose={onClose} label={`Edit ${customer.name}`}>
        <h2>Edit customer</h2>
        {full.error ? <ErrorState message={full.error} onRetry={full.reload} /> : <SkeletonRows rows={4} />}
      </Modal>
    );
  }
  return <CustomerForm customer={full.data ?? null} onClose={onClose} onSaved={onSaved} />;
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: customer?.name ?? "",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
    trn: customer?.trn ?? "",
    priceListId: customer?.priceListId ?? "",
    birthMonth: customer?.birthMonth ? String(customer.birthMonth) : "",
    birthDay: customer?.birthDay ? String(customer.birthDay) : "",
    tags: (customer?.tags ?? []).join(", "),
  });
  const [consent, setConsent] = useState(customer?.consent ?? { email: false, sms: false, whatsapp: false });
  const lists = useLoad(() => api<{ priceLists: PriceList[] }>("/price-lists"), []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const maxDay = form.birthMonth ? DAYS_IN[Number(form.birthMonth) - 1]! : 31;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Enter the customer's name.";
    if (form.trn.trim() && !/^\d{15}$/.test(form.trn.trim())) errs.trn = "A TRN has 15 digits.";
    if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = "Enter an email like name@example.com";
    if (!!form.birthMonth !== !!form.birthDay) errs.birthMonth = "Pick both the day and the month, or neither.";
    if (consent.email && !form.email.trim()) errs.email = "Add an email address, or untick offers by email.";
    if ((consent.sms || consent.whatsapp) && !form.phone.trim()) errs.phone = "Add a mobile number, or untick offers by SMS and WhatsApp.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`cf-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    const tags = [...new Set(form.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const body = {
      name: form.name,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      trn: form.trn.trim() || null,
      priceListId: form.priceListId || null,
      birthMonth: form.birthMonth ? Number(form.birthMonth) : null,
      birthDay: form.birthDay ? Number(form.birthDay) : null,
      tags,
      consent,
    };
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
        {(lists.data?.priceLists.length ?? 0) > 0 && (
          <Field label="Price list" hint="Their own prices on the till, e.g. wholesale. Products not on the list keep normal prices.">
            {(p) => (
              <select {...p} value={form.priceListId} onChange={(e) => set("priceListId", e.target.value)}>
                <option value="">Normal prices</option>
                {lists.data!.priceLists.map((l) => (
                  <option key={l.id} value={l.id} disabled={!l.active && l.id !== form.priceListId}>
                    {l.name}
                    {l.active ? "" : " (off)"}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <fieldset className="plain-fieldset">
          <legend className="field-label">Birthday</legend>
          <div className="form-grid">
            <Field id="cf-birthMonth" label="Month" error={errors.birthMonth}>
              {(p) => (
                <select
                  {...p}
                  value={form.birthMonth}
                  onChange={(e) => {
                    const m = e.target.value;
                    // 31 April does not exist, so the day is cleared when it no longer fits.
                    setForm((f) => ({ ...f, birthMonth: m, birthDay: m && Number(f.birthDay) > DAYS_IN[Number(m) - 1]! ? "" : f.birthDay }));
                  }}
                >
                  <option value="">Not given</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="cf-birthDay" label="Day">
              {(p) => (
                <select {...p} value={form.birthDay} onChange={(e) => set("birthDay", e.target.value)}>
                  <option value="">Not given</option>
                  {Array.from({ length: maxDay }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </fieldset>
        <Field id="cf-tags" label="Tags" hint="Separate with commas, e.g. vip, wholesale. Segments in Marketing can pick customers by tag.">
          {(p) => <input {...p} value={form.tags} onChange={(e) => set("tags", e.target.value)} maxLength={400} />}
        </Field>
        <fieldset className="plain-fieldset">
          <legend className="field-label">Offers and news</legend>
          <p className="hint">Tick only what the customer agreed to. Receipts are sent either way.</p>
          {(
            [
              ["email", "By email"],
              ["sms", "By SMS"],
              ["whatsapp", "By WhatsApp"],
            ] as const
          ).map(([k, label]) => (
            <label className="check" key={k}>
              <input type="checkbox" checked={consent[k]} onChange={(e) => setConsent((c) => ({ ...c, [k]: e.target.checked }))} />
              <span>{label}</span>
            </label>
          ))}
          {customer?.consentAt && (
            <p className="hint">
              Last changed {CONSENT_FROM[customer.consentSource ?? ""] ?? ""} on {dateTime(customer.consentAt)}.
            </p>
          )}
        </fieldset>
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

function CustomerBills({ customer, owner, onClose, onChanged }: { customer: Customer; owner: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const loyalty = useLoad(() => api<CustomerLoyalty>(`/customers/${customer.id}/loyalty`), [customer.id]);
  const [adjusting, setAdjusting] = useState(false);
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
      {loyalty.data && (
        <section className="points-box" aria-label="Points and gift cards">
          <div className="points-head">
            <span>
              <Icon name="star" size={18} /> <strong>{loyalty.data.points.toLocaleString("en-AE")}</strong> points
            </span>
            {owner && (
              <button type="button" className="btn ghost sm" onClick={() => setAdjusting(true)}>
                <Icon name="edit" size={16} /> Change points
              </button>
            )}
          </div>
          {loyalty.data.giftCards.length > 0 && (
            <p className="muted">
              Gift cards:{" "}
              {loyalty.data.giftCards.map((g, i) => (
                <span key={g.id}>
                  {i > 0 && ", "}
                  <a className="row-link tnum" href={`#/loyalty/cards/${g.id}`} onClick={onClose}>
                    {g.code}
                  </a>{" "}
                  ({aed(g.balance)})
                </span>
              ))}
            </p>
          )}
          {loyalty.data.moves.length > 0 && (
            <details>
              <summary>Points history</summary>
              <ul className="plain-list points-moves">
                {loyalty.data.moves.map((m) => (
                  <li key={m.id}>
                    <span>
                      {MOVE_LABEL[m.kind] ?? m.kind}
                      {m.orderNumber && (
                        <>
                          {" "}
                          <a className="row-link tnum" href={`#/sales/${m.orderId}`} onClick={onClose}>
                            {m.orderNumber}
                          </a>
                        </>
                      )}
                      {m.note && <span className="muted"> · {m.note}</span>}
                      <span className="cell-sub">{dateTime(m.at)}</span>
                    </span>
                    <span className={m.points < 0 ? "num strong bad" : "num strong good"}>{signedPts(m.points)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {adjusting && loyalty.data && (
        <AdjustDialog
          title={`Change ${customer.name}'s points`}
          unit="points"
          current={`${loyalty.data.points.toLocaleString("en-AE")} points`}
          onClose={() => setAdjusting(false)}
          onSave={async (value, note) => {
            const points = Number(value.replace(/[\s,+]/g, ""));
            if (!Number.isInteger(points) || points === 0) throw new Error("Enter whole points, like 500 to add or -500 to take off");
            const res = await api<{ points: number }>(`/customers/${customer.id}/points`, { body: { points, note } });
            toast(`${customer.name} now has ${res.points.toLocaleString("en-AE")} points`);
            setAdjusting(false);
            await loyalty.reload();
            onChanged();
          }}
        />
      )}
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
