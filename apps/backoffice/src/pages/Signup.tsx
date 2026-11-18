import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { SkeletonRows } from "../components/States.js";
import { errorText, publicApi } from "../lib/api.js";
import { useLoad } from "../lib/useLoad.js";

interface Options {
  trialDays: number;
  businessTypes: { id: string; label: string }[];
  emirates: { id: string; label: string }[];
}

/**
 * A shop owner creates their business: one store, one till, VAT and payment methods set
 * up, and the categories of their kind of shop. They land in the back office, ready to pair a till.
 */
export function Signup({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const options = useLoad(() => publicApi<Options>("/signup/options"), []);
  const [form, setForm] = useState({
    businessName: "",
    businessType: "grocery",
    emirate: "dubai",
    trn: "",
    ownerName: "",
    phone: "",
    email: "",
    password: "",
    pin: "",
    samples: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (form.businessName.trim().length < 2) errs.businessName = "Enter the name of your business.";
    if (form.trn && !/^\d{15}$/.test(form.trn.trim())) errs.trn = "A TRN has 15 digits. Leave it empty if you are not VAT registered yet.";
    if (!form.ownerName.trim()) errs.ownerName = "Enter your name.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = "Enter an email you can sign in with.";
    if (form.password.length < 8) errs.password = "This password is too short.";
    if (!/^\d{4,6}$/.test(form.pin)) errs.pin = "The PIN must be 4 to 6 digits.";
    if (form.phone && !/^\+?[0-9 ]{7,20}$/.test(form.phone.trim())) errs.phone = "Enter a phone number, e.g. +971 50 123 4567.";
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) {
      document.getElementById(`su-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await publicApi<{ token: string }>("/signup", { body: form });
      window.location.hash = "#/dashboard";
      onSignedIn(res.token);
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card signup-card" onSubmit={submit} noValidate>
        <img src="/icon.svg" alt="" width={48} height={48} />
        <h1>Start your free trial</h1>
        <p className="muted">
          {options.data ? `${options.data.trialDays} days free, no card needed. ` : ""}
          You get a store, a till and UAE VAT set up, ready to pair a tablet or PC.
        </p>
        {!options.data ? (
          options.error ? (
            <p className="form-error" role="alert">
              <Icon name="alert" /> {options.error}
            </p>
          ) : (
            <SkeletonRows rows={4} />
          )
        ) : (
          <>
            <fieldset className="group">
              <legend>Your business</legend>
              <Field id="su-businessName" label="Business name" required error={errors.businessName} hint="As it should print on receipts.">
                {(p) => <input {...p} value={form.businessName} onChange={(e) => set("businessName", e.target.value)} autoComplete="organization" maxLength={120} autoFocus />}
              </Field>
              <div className="form-grid">
                <Field label="Kind of shop" hint="Sets up the usual categories.">
                  {(p) => (
                    <select {...p} value={form.businessType} onChange={(e) => set("businessType", e.target.value)}>
                      {options.data!.businessTypes.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Emirate">
                  {(p) => (
                    <select {...p} value={form.emirate} onChange={(e) => set("emirate", e.target.value)}>
                      {options.data!.emirates.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <Field id="su-trn" label="VAT number (TRN)" error={errors.trn} hint="Optional. You can add it later in Settings.">
                {(p) => <input {...p} value={form.trn} onChange={(e) => set("trn", e.target.value)} inputMode="numeric" maxLength={15} />}
              </Field>
              <label className="check">
                <input type="checkbox" checked={form.samples} onChange={(e) => set("samples", e.target.checked)} />
                <span>
                  Add a few sample products
                  <span className="hint">To try a sale straight away. Edit or switch them off later.</span>
                </span>
              </label>
            </fieldset>

            <fieldset className="group">
              <legend>You, the owner</legend>
              <div className="form-grid">
                <Field id="su-ownerName" label="Your name" required error={errors.ownerName}>
                  {(p) => <input {...p} value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} autoComplete="name" maxLength={80} />}
                </Field>
                <Field id="su-phone" label="Mobile" error={errors.phone}>
                  {(p) => <input {...p} type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} autoComplete="tel" placeholder="+971 50 123 4567" />}
                </Field>
              </div>
              <Field id="su-email" label="Email" required error={errors.email}>
                {(p) => (
                  <input {...p} type="email" inputMode="email" autoComplete="username" value={form.email} onChange={(e) => set("email", e.target.value)} />
                )}
              </Field>
              <div className="form-grid">
                <Field id="su-password" label="Password" required error={errors.password} hint="At least 8 characters.">
                  {(p) => <input {...p} type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password", e.target.value)} />}
                </Field>
                <Field id="su-pin" label="Till PIN" required error={errors.pin} hint="4 to 6 digits, to sign in on the till.">
                  {(p) => (
                    <input
                      {...p}
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={form.pin}
                      onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))}
                    />
                  )}
                </Field>
              </div>
            </fieldset>

            {formError && (
              <p className="form-error" role="alert">
                <Icon name="alert" /> {formError}
              </p>
            )}
            <button type="submit" className="btn primary block" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Setting up your business…" : "Create my business"}
            </button>
          </>
        )}
        <p className="muted small center-text">
          Already have an account? <a href="#/">Sign in</a>
        </p>
      </form>
    </main>
  );
}
