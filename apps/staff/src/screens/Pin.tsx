import { useEffect, useState } from "react";
import { api, errorText, setSession } from "../lib/api.js";
import type { DeviceSetup, StaffUser } from "../lib/types.js";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

/** Staff sign in with the same PIN they use on the till. */
export function Pin({ setup, onSignedIn }: { setup: DeviceSetup | null; onSignedIn: (u: StaffUser) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const press = (k: string) => {
    if (busy) return;
    setError(null);
    if (k === "⌫") setPin((p) => p.slice(0, -1));
    else if (k) setPin((p) => (p.length < 8 ? p + k : p));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("⌫");
      else if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function submit() {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      const res = await api<{ token: string; user: StaffUser }>("/staff/login", { body: { pin } });
      setSession(res.token);
      onSignedIn(res.user);
    } catch (err) {
      setError(errorText(err));
      setPin("");
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card" style={{ width: "min(400px, 100%)" }}>
        <h1>Enter your PIN</h1>
        <p className="muted">{setup ? `${setup.store.name} · ${setup.tenant.name}` : "Your till PIN"}</p>
        <div className="pin-dots" aria-label={`${pin.length} digits entered`} role="status">
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <span key={i} className={i < pin.length ? "on" : ""} />
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="keypad">
          {KEYS.map((k, i) =>
            k ? (
              <button key={i} type="button" onClick={() => press(k)} aria-label={k === "⌫" ? "Delete" : k}>
                {k}
              </button>
            ) : (
              <span key={i} />
            ),
          )}
        </div>
        <button type="button" className="btn primary block" style={{ marginTop: 12 }} onClick={submit} disabled={pin.length < 4 || busy}>
          {busy && <span className="spinner" aria-hidden />}
          Sign in
        </button>
      </div>
    </div>
  );
}
