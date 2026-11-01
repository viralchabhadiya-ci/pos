import { useState } from "react";
import { PinPad } from "../components/PinPad.js";
import { db, type User } from "../lib/db.js";
import { verifyPin } from "../lib/pin.js";

/** Cashiers sign in with their PIN only; the PIN identifies them. Works offline. */
export function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (pin: string) => {
    setBusy(true);
    setError(null);
    const users = (await db.users.toArray()).filter((u) => u.active);
    for (const u of users) {
      if (await verifyPin(pin, u.pinSalt, u.pinHash)) {
        setBusy(false);
        return onLogin(u);
      }
    }
    setBusy(false);
    setError(users.length ? "Wrong PIN, try again" : "No staff loaded yet. Connect to the internet once to sync.");
  };
  return (
    <main className="center">
      <div className="card narrow">
        <PinPad title="Enter your PIN" error={error} busy={busy} onSubmit={submit} />
      </div>
    </main>
  );
}
