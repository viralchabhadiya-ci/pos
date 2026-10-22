import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { ago } from "../lib/format.js";
import type { Me, Staff as Person } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const ROLE_LABEL = { cashier: "Cashier", manager: "Manager", owner: "Owner" } as const;
type Role = keyof typeof ROLE_LABEL;

export function Staff({ me }: { me: Me }) {
  const list = useLoad(() => api<{ staff: Person[] }>("/staff"), []);
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const canEdit = (p: Person) => me.user.role === "owner" || p.role === "cashier";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Staff</h1>
          <p className="muted">Everyone signs in on the till with their own PIN. Owners and managers can also use this back office.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" /> Add person
        </button>
      </header>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows rows={4} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Staff</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col" className="hide-sm">Back office sign-in</th>
                <th scope="col" className="hide-xs">Status</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.staff.map((p) => (
                <tr key={p.id} className={p.active ? undefined : "dim"}>
                  <td>
                    <span className="cell-main">
                      {p.name}
                      {p.id === me.user.id && <span className="muted"> (you)</span>}
                    </span>
                  </td>
                  <td>{ROLE_LABEL[p.role]}</td>
                  <td className="hide-sm">
                    {p.canSignIn ? (
                      <>
                        <span className="cell-main">{p.email}</span>
                        <span className="cell-sub">Last sign-in: {ago(p.lastLoginAt)}</span>
                      </>
                    ) : (
                      <span className="muted">Till only</span>
                    )}
                  </td>
                  <td className="hide-xs">
                    {p.active ? (
                      <span className="badge good">
                        <Icon name="check" size={14} /> Active
                      </span>
                    ) : (
                      <span className="badge">Switched off</span>
                    )}
                  </td>
                  <td className="actions">
                    {canEdit(p) ? (
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                        <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                      </button>
                    ) : (
                      <span className="muted small">Owner only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <PersonDialog
          person={editing === "new" ? null : editing}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function PersonDialog({ person, me, onClose, onSaved }: { person: Person | null; me: Me; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const self = person?.id === me.user.id;
  const roles: Role[] = me.user.role === "owner" ? ["cashier", "manager", "owner"] : ["cashier"];
  const [name, setName] = useState(person?.name ?? "");
  const [role, setRole] = useState<Role>(person?.role ?? "cashier");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState(person?.email ?? "");
  const [password, setPassword] = useState("");
  const [active, setActive] = useState(person?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const backOffice = role !== "cashier";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Enter their name as it should show on receipts.";
    if ((!person || pin) && !/^\d{4,8}$/.test(pin)) errs.pin = "Use 4 to 8 digits.";
    if (backOffice && email && !/^\S+@\S+\.\S+$/.test(email)) errs.email = "Enter an email like name@shop.ae";
    if (backOffice && password && password.length < 8) errs.password = "Use at least 8 characters.";
    if (backOffice && password && !email) errs.email = "Add an email so they can sign in with this password.";
    if (backOffice && email && !password && !person?.canSignIn) errs.password = "Set a password so they can sign in.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`sf-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      name,
      role,
      pin: pin || null,
      email: backOffice ? email.trim() || null : null,
      password: backOffice ? password || null : null,
      ...(person ? { active } : {}),
    };
    try {
      if (person) await api(`/staff/${person.id}`, { method: "PUT", body });
      else await api("/staff", { body });
      toast(person ? `${name} saved` : `${name} added. They can sign in on the till with their PIN.`);
      onSaved();
    } catch (err) {
      const msg = errorText(err);
      if (msg.includes("PIN")) setErrors({ pin: msg });
      else if (msg.toLowerCase().includes("email")) setErrors({ email: msg });
      else setError(msg);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={person ? `Edit ${person.name}` : "Add person"}>
      <h2>{person ? "Edit person" : "Add person"}</h2>
      <form onSubmit={submit} noValidate>
        <Field id="sf-name" label="Name" required error={errors.name}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} autoComplete="off" />}
        </Field>
        <Field label="Role" hint={self ? "You cannot change your own role." : role === "cashier" ? "Sells and refunds on the till." : role === "manager" ? "Approves discounts, refunds and drawer opens; manages cashiers here." : "Full access, including managers and settings."}>
          {(p) => (
            <select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={self}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="sf-pin"
          label={person ? "New PIN" : "Till PIN"}
          required={!person}
          error={errors.pin}
          hint={person ? "Leave empty to keep their current PIN." : "4 to 8 digits. Each person needs a different PIN."}
        >
          {(p) => (
            <input
              {...p}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
          )}
        </Field>
        {backOffice && (
          <fieldset className="group">
            <legend>Back office sign-in</legend>
            <Field id="sf-email" label="Email" error={errors.email}>
              {(p) => <input {...p} type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field
              id="sf-password"
              label={person?.canSignIn ? "New password" : "Password"}
              error={errors.password}
              hint={person?.canSignIn ? "Leave empty to keep the current password." : "At least 8 characters."}
            >
              {(p) => <input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          </fieldset>
        )}
        {person && !self && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>
              Active
              <span className="hint">
                {active ? "Untick when someone leaves. Their PIN stops working on every till." : "Their PIN will stop working and they are signed out everywhere."}
              </span>
            </span>
          </label>
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
          <button type="submit" className={person && !active && person.active ? "btn danger-solid" : "btn primary"} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : person && !active && person.active ? "Switch off" : person ? "Save changes" : "Add person"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
