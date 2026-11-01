import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { ManagerPin } from "../components/ManagerPin.js";
import { Modal } from "../components/Modal.js";
import type { DeviceSetup, Session, User } from "../lib/db.js";
import { tryParseMoney } from "../lib/format.js";
import { openDrawerOnHub, printOnHub, shiftReportDoc } from "../lib/print.js";
import { addCashMove, shiftSummary } from "../lib/till.js";
import { useSyncStatus } from "../lib/useSync.js";

interface Props {
  setup: DeviceSetup;
  session: Session;
  user: User;
  onCloseShift: () => void;
  onLogout: () => void;
  onClose: () => void;
}

export function MenuDialog({ setup, session, user, onCloseShift, onLogout, onClose }: Props) {
  const [cash, setCash] = useState<"in" | "out" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerPin, setDrawerPin] = useState(false);
  const hasDrawer = !!useSyncStatus().hub?.printer;

  const openDrawer = async () => {
    setDrawerPin(false);
    try {
      await openDrawerOnHub();
      setDone("Drawer opened");
      setError(null);
    } catch (err) {
      setError(`Drawer: ${(err as Error).message}`);
    }
  };

  const printX = async () => {
    try {
      await printOnHub(shiftReportDoc(setup, session, await shiftSummary(session), { kind: "X", userName: user.name }));
      setDone("X report sent to the printer");
      setError(null);
    } catch (err) {
      setError(`Printer: ${(err as Error).message}`);
    }
  };

  const openCustomerScreen = () => {
    // Drag this window to the customer-facing screen and make it full screen.
    window.open(`${window.location.pathname}#display`, "pos-customer-display", "popup,width=1024,height=640");
    setDone("Customer screen opened in a new window");
  };

  if (drawerPin) {
    return <ManagerPin reason="Open the cash drawer without a sale" onApprove={() => void openDrawer()} onCancel={() => setDrawerPin(false)} />;
  }

  const saveCash = async () => {
    const minor = tryParseMoney(amount);
    if (!cash) return;
    if (minor === null || minor <= 0) return setError("Enter an amount, e.g. 200.00");
    if (!reason.trim()) return setError("Add a reason so the manager can match it later");
    setError(null);
    await addCashMove(session.id, user.id, cash, minor, reason.trim());
    setDone(`Recorded cash ${cash === "in" ? "in" : "out"} of ${amount}`);
    setCash(null);
    setAmount("");
    setReason("");
  };

  return (
    <Modal onClose={onClose} label={cash ? `Cash ${cash}` : "Menu"}>
      {cash ? (
        <>
          <h2>Cash {cash}</h2>
          <label htmlFor="cm-amount">Amount (AED)</label>
          <input id="cm-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          <label htmlFor="cm-reason">Reason</label>
          <input id="cm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={cash === "out" ? "Bank drop, supplier payment…" : "Change top-up…"} />
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" size={18} />
              {error}
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => { setCash(null); setError(null); }}>
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
          <div role="status" aria-live="polite">
            {done && (
              <p className="good" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                <Icon name="check" size={18} />
                {done}
              </p>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" size={18} />
              {error}
            </p>
          )}
          <button type="button" className="btn block" onClick={() => setCash("in")}>
            <Icon name="cash" />
            Cash in
          </button>
          <button type="button" className="btn block" onClick={() => setCash("out")}>
            <Icon name="cash" />
            Cash out
          </button>
          {hasDrawer && (
            <button type="button" className="btn block" onClick={() => setDrawerPin(true)}>
              <Icon name="drawer" />
              Open drawer
            </button>
          )}
          {hasDrawer && (
            <button type="button" className="btn block" onClick={() => void printX()}>
              <Icon name="printer" />
              Print X report
            </button>
          )}
          <button type="button" className="btn block" onClick={openCustomerScreen}>
            <Icon name="monitor" />
            Customer screen on this PC
          </button>
          <hr />
          <button type="button" className="btn block ghost" onClick={onLogout}>
            <Icon name="logout" />
            Switch cashier
          </button>
          <button type="button" className="btn block outline danger" onClick={onCloseShift}>
            <Icon name="lock" />
            Close shift
          </button>
        </div>
      )}
    </Modal>
  );
}
