import { useState, type FormEvent } from "react";
import type { Session, User } from "../lib/db.js";
import { tryParseMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { openSession } from "../lib/till.js";
import { Icon } from "../components/Icon.js";

export function OpenShiftScreen({ user, onOpened, onLogout }: { user: User; onOpened: (s: Session) => void; onLogout: () => void }) {
  const [amount, setAmount] = useState("500.00");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const minor = tryParseMoney(amount);
    if (minor === null || minor < 0) return setError(t("Enter the cash in the drawer, e.g. 500.00"));
    onOpened(await openSession(user.id, minor));
  };
  return (
    <main className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>{t("Open shift")}</h1>
        <p className="lead">{t("Count the cash in the drawer before the first sale.")}</p>
        <label htmlFor="float">{t("Opening cash (AED)")}</label>
        <input id="float" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} autoFocus />
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" size={18} />
            {error}
          </p>
        )}
        <button className="btn primary block">{t("Open shift")}</button>
        <button type="button" className="link" onClick={onLogout}>
          <Icon name="logout" size={18} />
          {t("Sign out")}
        </button>
      </form>
    </main>
  );
}
