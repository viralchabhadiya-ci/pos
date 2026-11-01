import { useState, type FormEvent } from "react";
import { pairDevice } from "../lib/till.js";
import { pullCatalog } from "../lib/sync.js";

export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [apiUrl, setApiUrl] = useState(() => import.meta.env.VITE_API_URL ?? "http://localhost:3000");
  const [code, setCode] = useState("");
  const [name, setName] = useState("Till 1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await pairDevice(apiUrl, code.trim(), name.trim());
      await pullCatalog();
      onPaired();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>Set up this till</h1>
        <p className="muted">Enter the 6-digit pairing code shown in the back office (Devices, Add device).</p>
        <label htmlFor="api">Server address</label>
        <input id="api" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} required />
        <label htmlFor="code">Pairing code</label>
        <input
          id="code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
          autoFocus
        />
        <label htmlFor="name">Device name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={busy || code.length !== 6}>
          {busy ? "Pairing…" : "Pair device"}
        </button>
      </form>
    </main>
  );
}
