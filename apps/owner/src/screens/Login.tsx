import { useState, type FormEvent } from "react";
import { api, errorText, setToken } from "../lib/api.js";
import type { Me } from "../lib/types.js";

export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>("/login", { body: { email: email.trim(), password } });
      setToken(res.token);
      onSignedIn(await api<Me>("/me"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card" noValidate>
        <img src="/icon.svg" alt="" className="logo" />
        <h1>Owner app</h1>
        <p className="muted">Live sales, alerts and approvals for your shops. Use your back office sign-in.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button type="submit" className="btn primary block" disabled={busy || !email || !password}>
          {busy && <span className="spinner" aria-hidden />}
          Sign in
        </button>
      </form>
    </div>
  );
}
