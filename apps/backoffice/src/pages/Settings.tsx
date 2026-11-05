import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { bp } from "../lib/format.js";
import type { Me, Store, Tax, TaxKind } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const ROUNDING = [
  { value: 0, label: "No rounding" },
  { value: 5, label: "To 0.05" },
  { value: 10, label: "To 0.10" },
  { value: 25, label: "To 0.25 (usual in the UAE)" },
  { value: 50, label: "To 0.50" },
  { value: 100, label: "To 1.00" },
];

const KIND_LABEL: Record<TaxKind, string> = { standard: "Standard rated", zero: "Zero rated", exempt: "Exempt" };

export function Settings({ me }: { me: Me }) {
  const owner = me.user.role === "owner";
  const stores = useLoad(() => api<{ stores: Store[] }>("/stores"), []);
  const taxes = useLoad(() => api<{ taxes: Tax[] }>("/taxes"), []);
  const [editingTax, setEditingTax] = useState<Tax | "new" | null>(null);

  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            {owner ? "Store details print on every receipt. Changes reach the tills within a minute." : "Only the owner can change these settings."}
          </p>
        </div>
      </header>

      {stores.error ? (
        <ErrorState message={stores.error} onRetry={stores.reload} />
      ) : !stores.data ? (
        <SkeletonRows rows={4} />
      ) : (
        stores.data.stores.map((s) => <StoreForm key={s.id} store={s} owner={owner} onSaved={stores.reload} />)
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>VAT rates</h2>
          {owner && (
            <button type="button" className="btn sm" onClick={() => setEditingTax("new")}>
              <Icon name="plus" /> Add rate
            </button>
          )}
        </div>
        <p className="muted small">
          Zero rated and exempt both charge 0%, but they go in different boxes on the VAT return. Basic food and exports are usually zero
          rated; some financial services and residential rent are exempt. Ask your tax agent when unsure.
        </p>
        {taxes.error ? (
          <ErrorState message={taxes.error} onRetry={taxes.reload} />
        ) : !taxes.data ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">VAT rates</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="hide-xs">Type</th>
                  <th scope="col" className="num">Rate</th>
                  <th scope="col" className="num hide-xs">Products</th>
                  {owner && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {taxes.data.taxes.map((t) => (
                  <tr key={t.id} className={t.active ? undefined : "dim"}>
                    <td>
                      {t.name}
                      {!t.active && <span className="badge">Off</span>}
                      <span className="cell-sub show-xs">{KIND_LABEL[t.kind]}</span>
                    </td>
                    <td className="hide-xs">{KIND_LABEL[t.kind]}</td>
                    <td className="num">{bp(t.rateBp)}</td>
                    <td className="num hide-xs">{t.productCount}</td>
                    {owner && (
                      <td className="actions">
                        <button type="button" className="btn ghost sm" onClick={() => setEditingTax(t)} aria-label={`Edit ${t.name}`}>
                          <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editingTax && (
        <TaxDialog
          tax={editingTax === "new" ? null : editingTax}
          onClose={() => setEditingTax(null)}
          onSaved={() => {
            setEditingTax(null);
            void taxes.reload();
          }}
        />
      )}
    </div>
  );
}

function StoreForm({ store, owner, onSaved }: { store: Store; owner: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: store.name,
    nameAr: store.nameAr ?? "",
    address: store.address ?? "",
    phone: store.phone ?? "",
    trn: store.trn ?? "",
    receiptFooter: store.receiptFooter ?? "",
    cashRoundingStep: store.cashRoundingStep,
    timezone: store.timezone,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const id = (k: string) => `sf-${store.id}-${k}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Enter the store name as it should print on receipts.";
    if (form.trn.trim() && !/^\d{15}$/.test(form.trn.trim())) errs.trn = "A TRN has 15 digits.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(id(Object.keys(errs)[0]!))?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api(`/stores/${store.id}`, {
        method: "PUT",
        body: {
          ...form,
          nameAr: form.nameAr || null,
          address: form.address || null,
          phone: form.phone || null,
          trn: form.trn.trim() || null,
          receiptFooter: form.receiptFooter || null,
        },
      });
      toast("Store details saved");
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <div className="panel-head">
        <h2>
          {store.name} <span className="muted small">· {store.code}</span>
        </h2>
      </div>
      <fieldset disabled={!owner} className="plain-fieldset">
        <div className="form-grid">
          <Field id={id("name")} label="Store name" required error={errors.name}>
            {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />}
          </Field>
          <Field label="Arabic name">
            {(p) => <input {...p} dir="rtl" lang="ar" value={form.nameAr} onChange={(e) => set("nameAr", e.target.value)} maxLength={120} />}
          </Field>
          <Field label="Address">
            {(p) => <input {...p} value={form.address} onChange={(e) => set("address", e.target.value)} maxLength={300} />}
          </Field>
          <Field label="Phone">
            {(p) => <input {...p} type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={30} />}
          </Field>
          <Field id={id("trn")} label="TRN" error={errors.trn} hint="Your VAT registration number, 15 digits. Prints on every tax invoice.">
            {(p) => <input {...p} inputMode="numeric" value={form.trn} onChange={(e) => set("trn", e.target.value.replace(/\s/g, ""))} maxLength={15} />}
          </Field>
          <Field label="Cash rounding" hint="Cash totals round to the nearest coin. Card payments are never rounded.">
            {(p) => (
              <select {...p} value={form.cashRoundingStep} onChange={(e) => set("cashRoundingStep", Number(e.target.value))}>
                {ROUNDING.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label="Receipt footer" hint="A thank-you line, return policy or both. Use | to start a new line, e.g. English | Arabic.">
          {(p) => <textarea {...p} rows={2} value={form.receiptFooter} onChange={(e) => set("receiptFooter", e.target.value)} maxLength={300} />}
        </Field>
        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        {owner && (
          <div className="dialog-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Saving…" : "Save store details"}
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

function TaxDialog({ tax, onClose, onSaved }: { tax: Tax | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: tax?.name ?? "",
    kind: tax?.kind ?? ("standard" as TaxKind),
    rate: tax ? String(tax.rateBp / 100) : "5",
    active: tax?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const rate = form.kind === "standard" ? Number(form.rate) : 0;
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Enter a name like VAT 5%";
    if (form.kind === "standard" && !(rate > 0 && rate <= 100 && Number.isInteger(Math.round(rate * 100))))
      errs.rate = "Enter a rate above 0, like 5";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError(null);
    const body = { name: form.name, kind: form.kind, rateBp: Math.round(rate * 100), active: form.active };
    try {
      if (tax) await api(`/taxes/${tax.id}`, { method: "PUT", body });
      else await api("/taxes", { body });
      toast(`${form.name} saved`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={tax ? `Edit ${tax.name}` : "Add VAT rate"}>
      <h2>{tax ? "Edit VAT rate" : "Add VAT rate"}</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Name" required error={errors.name}>
          {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={60} />}
        </Field>
        <Field label="Type">
          {(p) => (
            <select {...p} value={form.kind} onChange={(e) => set("kind", e.target.value as TaxKind)}>
              <option value="standard">Standard rated</option>
              <option value="zero">Zero rated (0%)</option>
              <option value="exempt">Exempt (0%)</option>
            </select>
          )}
        </Field>
        {form.kind === "standard" && (
          <Field label="Rate (%)" required error={errors.rate}>
            {(p) => <input {...p} inputMode="decimal" value={form.rate} onChange={(e) => set("rate", e.target.value)} />}
          </Field>
        )}
        {tax && tax.productCount > 0 && Math.round(Number(form.rate) * 100) !== tax.rateBp && form.kind === "standard" && (
          <p className="form-error" role="status">
            <Icon name="alert" /> {tax.productCount} products use this rate. Their prices stay the same, so the VAT inside them changes from{" "}
            {bp(tax.rateBp)} to {form.rate}%.
          </p>
        )}
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          <span>
            In use
            <span className="hint">Untick to stop offering it for new products. Products already using it keep it.</span>
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
