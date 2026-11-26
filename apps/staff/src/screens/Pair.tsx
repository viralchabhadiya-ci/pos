import { useState, type FormEvent } from "react";
import { api, errorText, setDeviceToken } from "../lib/api.js";

/** Pairs this phone with a store once, with a code from the back office (role: staff phone). */
export function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("code") ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError("The pairing code has 6 digits");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; device?: { role: string } }>("/pairing/claim", {
        body: { code, deviceId: crypto.randomUUID(), deviceName: name.trim() || "Staff phone" },
      });
      setDeviceToken(res.token);
      history.replaceState(null, "", location.pathname + location.hash);
      onPaired();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card" noValidate>
        <img src="/icon.svg" alt="" className="logo" />
        <h1>Staff app</h1>
        <p className="muted">
          Price checks, stock counts, deliveries and shelf labels. In the back office open Tills &amp; devices, choose Pair a device, pick{" "}
          <strong>Staff phone</strong> and type the code here.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="code">Pairing code</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
        </div>
        <div className="field">
          <label htmlFor="name">Name for this phone</label>
          <input id="name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Stockroom phone" />
        </div>
        <button type="submit" className="btn primary block" disabled={busy || code.length !== 6}>
          {busy && <span className="spinner" aria-hidden />}
          Pair this phone
        </button>
      </form>
    </div>
  );
}
