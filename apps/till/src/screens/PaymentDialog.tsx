import { checkPayments, type PaymentInput } from "@pos/core";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import type { Cart } from "../lib/cart.js";
import { db, type DeviceSetup, type LocalOrder, type PaymentMethod } from "../lib/db.js";
import { aed, money, tryParseMoney } from "../lib/format.js";
import { completeOrder } from "../lib/till.js";

interface Props {
  setup: DeviceSetup;
  cart: Cart;
  total: number;
  cashierId: string;
  onDone: (order: LocalOrder) => void;
  onCancel: () => void;
}

const QUICK_CASH = [1000, 2000, 5000, 10000, 20000];

/**
 * Split tender: add payments until the total is covered. For cash the cashier enters
 * what the customer handed over and the change is shown. Integrated card terminals
 * plug in here later; for now card is confirmed by the cashier.
 */
export function PaymentDialog({ setup, cart, total, cashierId, onDone, onCancel }: Props) {
  const methods = useLiveQuery(() => db.paymentMethods.filter((m) => m.active).toArray(), []) ?? [];
  const [payments, setPayments] = useState<PaymentInput[]>([]);
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refund = total < 0;
  const step = setup.store.cashRoundingStep;

  const check = checkPayments(total, payments, step);
  // What is still due if the next payment is cash (cash rounding applies only to all-cash orders).
  const dueIfCash = checkPayments(total, [...payments, { id: "x", methodId: "x", kind: "cash", amount: 0 }], step).remaining;

  const addPayment = (method: PaymentMethod, tenderedOverride?: number) => {
    setError(null);
    const remaining = method.kind === "cash" ? dueIfCash : check.remaining;
    const typed = entry ? tryParseMoney(entry) : null;
    const tendered = tenderedOverride ?? typed ?? remaining;
    if (!refund && tendered <= 0) return setError("Enter an amount");
    const amount = refund ? remaining : Math.min(tendered, remaining);
    if (method.kind !== "cash" && !refund && tendered > remaining) return setError("Card amount cannot be more than what is due");
    setPayments([
      ...payments,
      {
        id: crypto.randomUUID(),
        methodId: method.id,
        kind: method.kind,
        amount,
        tendered: method.kind === "cash" && !refund ? tendered : undefined,
      },
    ]);
    setEntry("");
  };

  const finish = async () => {
    setBusy(true);
    try {
      onDone(await completeOrder(cart, payments, cashierId));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? undefined : onCancel} wide label={refund ? "Refund" : "Payment"}>
      <div className="paydlg">
        <div>
          <h2>{refund ? "Refund" : "Payment"}</h2>
          <p className={check.complete ? "due done" : "due"} aria-live="polite">
            {check.complete ? "Paid in full" : refund ? "To refund" : "Amount due"}
            <strong>{aed(Math.abs(check.complete ? check.due : check.remaining))}</strong>
          </p>
          {check.cashRounding !== 0 && <p className="muted">Cash rounding {money(check.cashRounding)}</p>}
          <ul className="paylist">
            {payments.map((p) => (
              <li key={p.id}>
                <Icon name={p.kind === "cash" ? "cash" : "card"} />
                <span>{methods.find((m) => m.id === p.methodId)?.name}</span>
                <span className="amt">{money(p.amount)}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${methods.find((m) => m.id === p.methodId)?.name ?? "payment"} ${money(p.amount)}`}
                  onClick={() => setPayments(payments.filter((x) => x.id !== p.id))}
                  disabled={busy}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
          {check.change > 0 && (
            <p className="change" aria-live="polite">
              Give change <strong>{aed(check.change)}</strong>
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" size={18} />
              {error}
            </p>
          )}
        </div>
        <div>
          {!check.complete && (
            <>
              <label htmlFor="tendered">{refund ? "Refund amount" : "Amount received"}</label>
              <input
                id="tendered"
                inputMode="decimal"
                placeholder={money(Math.abs(dueIfCash))}
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                disabled={refund}
                aria-describedby="tendered-help"
                autoComplete="off"
                autoFocus
              />
              <p id="tendered-help" className="muted" style={{ marginTop: 8, fontSize: 14 }}>
                {refund ? "Refunds go back in full to the method you pick." : "Leave empty to pay exactly what is due, or tap a note."}
              </p>
              {!refund && (
                <div className="quick">
                  {QUICK_CASH.filter((q) => q >= dueIfCash).slice(0, 4).map((q) => {
                    const cash = methods.find((m) => m.kind === "cash");
                    return (
                      <button key={q} type="button" className="chip" disabled={!cash} onClick={() => cash && addPayment(cash, q)} aria-label={`Cash ${money(q)} AED`}>
                        {money(q)}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="methods">
                {methods.map((m) => (
                  <button key={m.id} type="button" className="btn method" onClick={() => addPayment(m)}>
                    <Icon name={m.kind === "cash" ? "cash" : "card"} />
                    {m.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn primary lg" disabled={!check.complete || busy} onClick={finish} autoFocus={check.complete}>
              <Icon name="check" />
              {busy ? "Saving…" : refund ? "Complete refund" : "Complete sale"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
