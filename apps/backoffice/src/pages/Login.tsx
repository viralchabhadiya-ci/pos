import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { api, errorText } from "../lib/api.js";

export function Login({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>("/login", { body: { email, password } });
      onSignedIn(res.token);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit} noValidate={false}>
        <img src="/icon.svg" alt="" width={48} height={48} />
        <h1>Sign in to the back office</h1>
        <p className="muted">For owners and managers. Cashiers sign in on the till with their PIN.</p>
        <Field label="Email" required>
          {(p) => (
            <input {...p} type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Password" required>
          {(p) => (
            <input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <button type="submit" className="btn primary block" disabled={busy || !email || !password}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
