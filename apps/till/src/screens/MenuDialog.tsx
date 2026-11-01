import { useState } from "react";
import { Modal } from "../components/Modal.js";
import type { Session, User } from "../lib/db.js";
import { tryParseMoney } from "../lib/format.js";
import { addCashMove } from "../lib/till.js";

interface Props {
  session: Session;
  user: User;
  onCloseShift: () => void;
  onLogout: () => void;
  onClose: () => void;
}

export function MenuDialog({ session, user, onCloseShift, onLogout, onClose }: Props) {
  const [cash, setCash] = useState<"in" | "out" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const saveCash = async () => {
    const minor = tryParseMoney(amount);
    if (!cash || minor === null || minor <= 0 || !reason.trim()) return;
    await addCashMove(session.id, user.id, cash, minor, reason.trim());
    setDone(`Recorded cash ${cash === "in" ? "in" : "out"} of ${amount}`);
    setCash(null);
    setAmount("");
    setReason("");
  };

  return (
    <Modal onClose={onClose}>
      {cash ? (
        <>
          <h2>Cash {cash}</h2>
          <label htmlFor="cm-amount">Amount (AED)</label>
          <input id="cm-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          <label htmlFor="cm-reason">Reason</label>
          <input id="cm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={cash === "out" ? "Bank drop, supplier payment…" : "Change top-up…"} />
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setCash(null)}>
              Back
            </button>
            <button type="button" className="btn primary" onClick={saveCash}>
              Save
            </button>
          </div>
        </>
      ) : (
        <div className="menu">
          <h2>Menu</h2>
          {done && <p className="good">{done}</p>}
          <button type="button" className="btn block" onClick={() => setCash("in")}>Cash in</button>
          <button type="button" className="btn block" onClick={() => setCash("out")}>Cash out</button>
          <button type="button" className="btn block" onClick={onCloseShift}>Close shift</button>
          <button type="button" className="btn block ghost" onClick={onLogout}>Switch cashier</button>
        </div>
      )}
    </Modal>
  );
}
