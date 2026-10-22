import { useState } from "react";
import { db } from "../lib/db.js";
import { verifyPin } from "../lib/pin.js";
import { Modal } from "./Modal.js";
import { PinPad } from "./PinPad.js";

/** Asks for any manager's PIN; resolves with that manager's id. */
export function ManagerPin({ reason, onApprove, onCancel }: { reason: string; onApprove: (managerId: string) => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (pin: string) => {
    setBusy(true);
    const managers = (await db.users.toArray()).filter((u) => u.active && u.role !== "cashier");
    for (const m of managers) {
      if (await verifyPin(pin, m.pinSalt, m.pinHash)) {
        setBusy(false);
        return onApprove(m.id);
      }
    }
    setBusy(false);
    setError("That PIN is not a manager PIN");
  };
  return (
    <Modal onClose={onCancel}>
      <PinPad title="Manager approval" hint={reason} error={error} busy={busy} onSubmit={submit} onCancel={onCancel} />
    </Modal>
  );
}
