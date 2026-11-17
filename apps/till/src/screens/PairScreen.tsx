import { useState, type FormEvent } from "react";
import { pairDevice } from "../lib/till.js";
import { pullCatalog } from "../lib/sync.js";
import { Icon } from "../components/Icon.js";
import { LangSwitch } from "../components/LangSwitch.js";
import { t } from "../lib/i18n.js";

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
        <div className="card-top">
          <h1>{t("Set up this till")}</h1>
          <LangSwitch />
        </div>
        <p className="lead">{t("Enter the 6-digit pairing code shown in the back office (Devices, Add device).")}</p>
        <label htmlFor="api">{t("Server address")}</label>
        <input id="api" type="url" inputMode="url" autoComplete="off" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} aria-describedby="api-help" required />
        <p id="api-help" className="muted" style={{ marginTop: 8, fontSize: 14 }}>
          {t("The store hub (http://hub-pc:4100) or the cloud address.")}
        </p>
        <label htmlFor="code">{t("Pairing code")}</label>
        <input
          id="code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
          autoComplete="one-time-code"
          autoFocus
        />
        <label htmlFor="name">{t("Device name")}</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" size={18} />
            {error}
          </p>
        )}
        <button className="btn primary block" disabled={busy || code.length !== 6}>
          {busy ? t("Pairing…") : t("Pair device")}
        </button>
      </form>
    </main>
  );
}
