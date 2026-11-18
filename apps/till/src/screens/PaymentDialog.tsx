import { checkPayments, type AppliedPromotion, type PaymentInput } from "@pos/core";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useState } from "react";
import { CardPanel } from "../components/CardPanel.js";
import { StoredValuePanel } from "../components/StoredValuePanel.js";
import { giftCardError, releaseGiftCard } from "../lib/giftCards.js";
import { useLoyalty } from "../lib/loyalty.js";
import { paymentLabel } from "../lib/print.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import type { Cart } from "../lib/cart.js";
import { db, type DeviceSetup, type LocalOrder, type PaymentMethod } from "../lib/db.js";
import { aed, money, tryParseMoney } from "../lib/format.js";
import { completeOrder } from "../lib/till.js";
import { t } from "../lib/i18n.js";
import { loadTerminal, originalCardPayment, type CardResult, type Terminal } from "../lib/card.js";

interface Props {
  setup: DeviceSetup;
  /** The cart with promotions already worked into its lines. */
  cart: Cart;
  promotions?: AppliedPromotion[];
  total: number;
  cashierId: string;
  onDone: (order: LocalOrder) => void;
  onCancel: () => void;
}

const QUICK_CASH = [1000, 2000, 5000, 10000, 20000];

/**
 * Split tender: add payments until the total is covered. For cash the cashier enters
 * what the customer handed over and the change is shown. "Card" goes to the register's
 * integrated terminal when it has one; "Card (manual terminal)" is confirmed by the cashier.
 */
export function PaymentDialog({ setup, cart, promotions = [], total, cashierId, onDone, onCancel }: Props) {
  const methods = useLiveQuery(() => db.paymentMethods.filter((m) => m.active).toArray(), []) ?? [];
  const [payments, setPayments] = useState<PaymentInput[]>([]);
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refund = total < 0;
  const step = setup.store.cashRoundingStep;
  // The order id exists before the sale is saved, so terminal payments can point at it.
  const [orderId] = useState(() => crypto.randomUUID());
  const [terminal, setTerminal] = useState<{ terminal: Terminal | null; online: boolean } | null>(null);
  const [card, setCard] = useState<{ method: PaymentMethod; amount: number; refundOf?: string } | null>(null);
  // Gift card or points being added.
  const [stored, setStored] = useState<PaymentMethod | null>(null);
  const loyalty = useLoyalty();
  const pointsRefunded = payments.reduce((s, p) => s + (p.kind === "points" && p.amount < 0 ? -p.amount : 0), 0);
  const pointsRoom = Math.max(0, (cart.refundPointsRoom ?? 0) - pointsRefunded);
  // Points show while the programme is on, and on a refund of a sale paid with points.
  const shown = methods.filter((m) => m.kind !== "points" || (refund ? pointsRoom > 0 : loyalty.enabled));

  useEffect(() => {
    loadTerminal()
      .then(setTerminal)
      .catch(() => setTerminal({ terminal: null, online: false }));
  }, []);
  const cardPaid = payments.some((p) => p.cardTransactionId);

  const check = checkPayments(total, payments, step);
  // What is still due if the next payment is cash (cash rounding applies only to all-cash orders).
  const dueIfCash = checkPayments(total, [...payments, { id: "x", methodId: "x", kind: "cash", amount: 0 }], step).remaining;

  const addPayment = async (method: PaymentMethod, tenderedOverride?: number) => {
    setError(null);
    if (method.kind === "gift_card" || method.kind === "points") return setStored(method);
    const remaining = method.kind === "cash" ? dueIfCash : check.remaining;
    const typed = entry ? tryParseMoney(entry) : null;
    const tendered = tenderedOverride ?? typed ?? remaining;
    if (!refund && tendered <= 0) return setError(t("Enter an amount"));
    const amount = refund ? remaining : Math.min(tendered, remaining);
    if (method.kind !== "cash" && !refund && tendered > remaining) return setError(t("Card amount cannot be more than what is due"));
    if (method.kind === "card" && terminal?.terminal) {
      if (!terminal.online) return setError(t("The card terminal needs the internet. Use the manual card terminal or cash."));
      setEntry("");
      if (!refund) return setCard({ method, amount });
      const original = cart.refundOfOrderId ? await originalCardPayment(cart.refundOfOrderId) : null;
      if (!original) return setError(t("The original sale was not paid on this card terminal. Refund in cash or on the manual terminal."));
      return setCard({ method, amount: Math.min(-amount, original.amount), refundOf: original.id });
    }
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

  const cardApproved = useCallback(
    (r: CardResult) => {
      if (!card) return;
      const signed = r.kind === "refund" ? -r.amount : r.amount;
      setPayments((list) => [
        ...list,
        {
          id: crypto.randomUUID(),
          methodId: card.method.id,
          kind: "card",
          amount: signed,
          reference: [r.cardBrand, r.cardLast4 && `****${r.cardLast4}`, r.authCode && `auth ${r.authCode}`].filter(Boolean).join(" ") || undefined,
          cardTransactionId: r.id,
        },
      ]);
      setEntry("");
      // Leave the approval on screen for a moment so the cashier sees it.
      setTimeout(() => setCard(null), 900);
    },
    [card],
  );

  /** Removes a payment; an amount held on a gift card goes back to the card first. */
  const removePayment = async (p: PaymentInput) => {
    if (p.kind === "gift_card" && p.amount > 0) {
      setBusy(true);
      try {
        await releaseGiftCard(p.id, cashierId);
      } catch (err) {
        setBusy(false);
        return setError(giftCardError(err));
      }
      setBusy(false);
    }
    setPayments((list) => list.filter((x) => x.id !== p.id));
  };

  const back = async () => {
    if (cardPaid) return setError(t("A card payment went through. Complete the sale; to undo it, refund it to the card afterwards."));
    const held = payments.filter((p) => p.kind === "gift_card" && p.amount > 0);
    if (held.length) {
      setBusy(true);
      try {
        for (const p of held) await releaseGiftCard(p.id, cashierId);
      } catch (err) {
        setBusy(false);
        return setError(`${giftCardError(err)} ${t("The gift card amount is still held; remove it again when back online.")}`);
      }
    }
    onCancel();
  };

  const finish = async () => {
    setBusy(true);
    try {
      onDone(await completeOrder(cart, payments, cashierId, orderId, promotions));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy || card || stored ? undefined : () => void back()} wide label={t(refund ? "Refund" : "Payment")}>
      {card && terminal?.terminal && (
        <CardPanel
          terminal={terminal.terminal}
          orderId={orderId}
          amount={card.amount}
          kind={refund ? "refund" : "sale"}
          userId={cashierId}
          refundOf={card.refundOf}
          onApproved={cardApproved}
          onClose={() => setCard(null)}
        />
      )}
      <div className="paydlg" hidden={!!card}>
        <div>
          <h2>{t(refund ? "Refund" : "Payment")}</h2>
          <p className={check.complete ? "due done" : "due"} aria-live="polite">
            {t(check.complete ? "Paid in full" : refund ? "To refund" : "Amount due")}
            <strong>{aed(Math.abs(check.complete ? check.due : check.remaining))}</strong>
          </p>
          {check.cashRounding !== 0 && <p className="muted">{t("Cash rounding {amount}", { amount: money(check.cashRounding) })}</p>}
          <ul className="paylist">
            {payments.map((p) => (
              <li key={p.id}>
                <Icon name={p.kind === "cash" ? "cash" : p.kind === "gift_card" ? "gift" : p.kind === "points" ? "star" : "card"} />
                <span>{paymentLabel(t(methods.find((m) => m.id === p.methodId)?.name ?? ""), p)}</span>
                <span className="amt">{money(p.amount)}</span>
                {p.cardTransactionId ? (
                  // A terminal payment has charged the card; it can only be refunded, not removed.
                  <span className="muted small">{p.reference}</span>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t("Remove {method} {amount}", { method: t(methods.find((m) => m.id === p.methodId)?.name ?? ""), amount: money(p.amount) })}
                    onClick={() => void removePayment(p)}
                    disabled={busy}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {check.change > 0 && (
            <p className="change" aria-live="polite">
              {t("Give change")} <strong>{aed(check.change)}</strong>
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
          {!check.complete && stored && (
            <StoredValuePanel
              kind={stored.kind === "points" ? "points" : "gift_card"}
              method={stored}
              refund={refund}
              remaining={Math.abs(check.remaining)}
              customerId={cart.customerId}
              pointsRoom={pointsRoom}
              userId={cashierId}
              onAdd={(p) => {
                setPayments((list) => [...list, p]);
                setStored(null);
              }}
              onCancel={() => setStored(null)}
            />
          )}
          {!check.complete && !stored && (
            <>
              <label htmlFor="tendered">{t(refund ? "Refund amount" : "Amount received")}</label>
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
                {t(refund ? "Refunds go back in full to the method you pick." : "Leave empty to pay exactly what is due, or tap a note.")}
              </p>
              {!refund && (
                <div className="quick">
                  {QUICK_CASH.filter((q) => q >= dueIfCash).slice(0, 4).map((q) => {
                    const cash = methods.find((m) => m.kind === "cash");
                    return (
                      <button key={q} type="button" className="chip" disabled={!cash} onClick={() => cash && void addPayment(cash, q)} aria-label={t("Cash {amount} AED", { amount: money(q) })}>
                        {money(q)}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="methods">
                {shown.map((m) => (
                  <button key={m.id} type="button" className="btn method" onClick={() => void addPayment(m)}>
                    <Icon name={m.kind === "cash" ? "cash" : m.kind === "gift_card" ? "gift" : m.kind === "points" ? "star" : "card"} />
                    {t(m.name)}
                    {m.kind === "card" && terminal?.terminal && <span className="method-note">{t("on {terminal}", { terminal: terminal.terminal.name })}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          {!(stored && !check.complete) && (
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => void back()} disabled={busy}>
                {t("Back")}
              </button>
              <button type="button" className="btn primary lg" disabled={!check.complete || busy} onClick={finish} autoFocus={check.complete}>
                <Icon name="check" />
                {busy ? t("Saving…") : t(refund ? "Complete refund" : "Complete sale")}
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
