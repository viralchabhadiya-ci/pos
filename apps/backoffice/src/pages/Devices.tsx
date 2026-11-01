import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { ago, time } from "../lib/format.js";
import type { Device, Me, Register } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

export function Devices({ me }: { me: Me }) {
  const list = useLoad(() => api<{ registers: Register[] }>("/registers"), []);
  const [pairing, setPairing] = useState<Register | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [adding, setAdding] = useState(false);

  // Online status changes on its own, so refresh it every half minute while the page is open.
  useEffect(() => {
    const t = setInterval(() => void list.reload(), 30_000);
    return () => clearInterval(t);
  }, [list.reload]);

  const registers = list.data?.registers ?? [];
  const stores = me.stores.map((s) => ({ ...s, registers: registers.filter((r) => r.storeId === s.id) }));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Tills and devices</h1>
          <p className="muted">Each counter is a register. Pair a tablet or PC to a register with a one-time code.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add register
        </button>
      </header>
      {list.error && !list.data ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows rows={3} />
      ) : (
        stores.map((s) => (
          <section key={s.id} className="store-block" aria-labelledby={`st-${s.id}`}>
            {stores.length > 1 && <h2 id={`st-${s.id}`}>{s.name}</h2>}
            {stores.length === 1 && (
              <h2 id={`st-${s.id}`} className="sr-only">
                {s.name}
              </h2>
            )}
            {s.registers.length === 0 && <EmptyState icon="monitor" title="No registers in this store yet" />}
            <div className="reg-grid">
              {s.registers.map((r) => (
                <article key={r.id} className="panel reg">
                  <header className="reg-head">
                    <div>
                      <h3>{r.name}</h3>
                      <span className="muted small">Code {r.code}</span>
                    </div>
                    {r.openSession ? (
                      <span className="badge good">
                        <Icon name="check" size={14} /> Shift open
                      </span>
                    ) : (
                      <span className="badge">Shift closed</span>
                    )}
                  </header>
                  {r.openSession && (
                    <p className="small muted">
                      Opened by {r.openSession.openedBy} at {time(r.openSession.openedAt)}
                    </p>
                  )}
                  {r.devices.length === 0 ? (
                    <p className="muted">No device paired yet.</p>
                  ) : (
                    <ul className="dev-list">
                      {r.devices.map((d) => (
                        <li key={d.id}>
                          <span className={d.online ? "dot on" : "dot"} aria-hidden="true" />
                          <span className="dev-main">
                            <span className="cell-main">
                              {d.name} <span className="muted small">· {d.role === "till" ? "Till" : "Customer display"}</span>
                            </span>
                            <span className="cell-sub">{d.online ? "Online now" : `Last seen ${ago(d.lastSeenAt).toLowerCase()}`}</span>
                          </span>
                          <button type="button" className="btn ghost sm danger" onClick={() => setRevoking(d)}>
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="btn block" onClick={() => setPairing(r)}>
                    <Icon name="key" /> Pair a device
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))
      )}
      {pairing && <PairDialog register={pairing} onClose={() => (setPairing(null), void list.reload())} />}
      {revoking && (
        <RevokeDialog
          device={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            void list.reload();
          }}
        />
      )}
      {adding && (
        <RegisterDialog
          me={me}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function PairDialog({ register, onClose }: { register: Register; onClose: () => void }) {
  const [role, setRole] = useState<"till" | "display">("till");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await api(`/registers/${register.id}/pairing-code`, { body: { role } }));
      setNow(Date.now());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const left = code ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = code && left === 0;

  return (
    <Modal onClose={onClose} label={`Pair a device to ${register.name}`}>
      <h2>Pair a device to {register.name}</h2>
      {!code ? (
        <>
          <Field label="This device will be a">
            {(p) => (
              <select {...p} value={role} onChange={(e) => setRole(e.target.value as "till" | "display")} autoFocus>
                <option value="till">Till (for the cashier)</option>
                <option value="display">Customer display</option>
              </select>
            )}
          </Field>
          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert" /> {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={create} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Get pairing code
            </button>
          </div>
        </>
      ) : (
        <>
          <ol className="steps">
            <li>Open the till app on the new device.</li>
            <li>Type this code on its pairing screen.</li>
          </ol>
          <p className={expired ? "pair-code expired" : "pair-code"} aria-live="polite">
            <span className="sr-only">Pairing code </span>
            {code.code.slice(0, 3)}
            <span aria-hidden="true"> </span>
            {code.code.slice(3)}
          </p>
          <p className="center-text muted" aria-live="off">
            {expired ? "This code has expired." : `Works once. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} min.`}
          </p>
          <div className="dialog-actions">
            {expired && (
              <button type="button" className="btn" onClick={create} disabled={busy}>
                <Icon name="refresh" /> New code
              </button>
            )}
            <button type="button" className="btn primary" onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function RevokeDialog({ device, onClose, onDone }: { device: Device; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    setBusy(true);
    try {
      await api(`/devices/${device.id}/revoke`, { body: {} });
      toast(`${device.name} removed`);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={`Remove ${device.name}`}>
      <h2>Remove {device.name}?</h2>
      <p>
        It stops working straight away. Bills it has not sent yet stay on the device, so only remove a device that is lost, broken or
        already synced. To use it again, pair it with a new code.
      </p>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>
          Keep it
        </button>
        <button type="button" className="btn danger-solid" onClick={revoke} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Remove device
        </button>
      </div>
    </Modal>
  );
}

function RegisterDialog({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Enter a name, like Counter 2";
    if (!/^[A-Za-z0-9-]{1,12}$/.test(code.trim())) errs.code = "Use up to 12 letters or numbers, like R2";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("/registers", { body: { storeId, name, code: code.trim() } });
      toast(`${name} added. Pair a device to start selling on it.`);
      onSaved();
    } catch (err) {
      setErrors({ code: errorText(err) });
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Add register">
      <h2>Add register</h2>
      <form onSubmit={submit} noValidate>
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
        <Field label="Name" required error={errors.name}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Counter 2" />}
        </Field>
        <Field label="Short code" required error={errors.code} hint="Printed in every bill number from this register.">
          {(p) => <input {...p} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} placeholder="R2" />}
        </Field>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Add register
          </button>
        </div>
      </form>
    </Modal>
  );
}
