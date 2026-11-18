import { maxRedeemablePoints, newGiftCardCode, pointsForRefund, pointsValue, type PaymentInput } from "@pos/core";
import { useEffect, useState, type FormEvent } from "react";
import { request } from "../lib/api.js";
import type { PaymentMethod } from "../lib/db.js";
import { aed, money, tryParseMoney } from "../lib/format.js";
import { checkGiftCard, giftCardError, GIFT_CARD_CODE, holdGiftCard, isOffline, type GiftCardInfo } from "../lib/giftCards.js";
import { t } from "../lib/i18n.js";
import { useLoyalty } from "../lib/loyalty.js";
import { Icon } from "./Icon.js";

interface Props {
  kind: "gift_card" | "points";
  method: PaymentMethod;
  refund: boolean;
  /** What is still due (or still to refund), as a positive amount. */
  remaining: number;
  customerId: string | null;
  /** On a refund: the most that may still go back as points. */
  pointsRoom: number;
  userId: string;
  onAdd: (p: PaymentInput) => void;
  onCancel: () => void;
}

/**
 * Paying with a gift card or points, or refunding onto them. Spending checks the balance with
 * the server first (a gift card's amount is taken there and then), so it needs the internet.
 * A refund onto a gift card is stored credit: it loads the card when the refund syncs.
 */
export function StoredValuePanel(props: Props) {
  return props.kind === "gift_card" ? <GiftCardTender {...props} /> : <PointsTender {...props} />;
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="error" role="alert">
      <Icon name="alert" size={18} />
      {text}
    </p>
  );
}

function GiftCardTender({ method, refund, remaining, userId, onAdd, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [card, setCard] = useState<GiftCardInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clean = code.trim().toUpperCase();

  const look = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!GIFT_CARD_CODE.test(clean)) return setError(t("Gift card numbers are 6 to 40 letters, digits or dashes."));
    setBusy(true);
    setError(null);
    try {
      const c = await checkGiftCard(clean);
      if (c.status !== "active") return setError(t("This gift card has been switched off."));
      if (c.expiresAt && Date.parse(c.expiresAt) < Date.now()) return setError(t("This gift card has expired."));
      if (c.balance <= 0) return setError(t("This gift card is empty."));
      setCard(c);
      setAmount(money(Math.min(c.balance, remaining)));
    } catch (err) {
      setError(giftCardError(err));
    } finally {
      setBusy(false);
    }
  };

  const spend = async () => {
    if (!card) return;
    const fils = tryParseMoney(amount);
    if (!fils || fils <= 0) return setError(t("Enter an amount"));
    if (fils > remaining) return setError(t("Card amount cannot be more than what is due"));
    if (fils > card.balance) return setError(t("There is not enough left on this gift card."));
    const id = crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      await holdGiftCard(id, card.code, fils, userId);
      onAdd({ id, methodId: method.id, kind: "gift_card", amount: fils, giftCardCode: card.code });
    } catch (err) {
      setError(giftCardError(err));
      setBusy(false);
    }
  };

  const credit = (e: FormEvent) => {
    e.preventDefault();
    if (!GIFT_CARD_CODE.test(clean)) return setError(t("Gift card numbers are 6 to 40 letters, digits or dashes."));
    onAdd({ id: crypto.randomUUID(), methodId: method.id, kind: "gift_card", amount: -remaining, giftCardCode: clean });
  };

  return (
    <div className="sv-panel">
      <h3>
        <Icon name="gift" size={20} />
        {t(refund ? "Refund to a gift card" : "Pay with a gift card")}
      </h3>
      <form onSubmit={refund ? credit : look}>
        <label htmlFor="gc-code">{t("Gift card number")}</label>
        <div className="inline-field">
          <input
            id="gc-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setCard(null);
              setError(null);
            }}
            placeholder={t("Scan or type the number")}
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={40}
            autoFocus
          />
          {refund ? (
            <button type="button" className="btn outline" onClick={() => setCode(newGiftCardCode())}>
              {t("New number")}
            </button>
          ) : (
            <button type="submit" className="btn outline" disabled={busy || !clean}>
              {t("Check")}
            </button>
          )}
        </div>
        {refund && <p className="muted small">{t("Store credit: {amount} goes onto this card when the refund syncs. Give the customer the number.", { amount: aed(remaining) })}</p>}
        {refund && (
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              {t("Back")}
            </button>
            <button type="submit" className="btn primary" disabled={!clean}>
              {t("Refund {amount} to the card", { amount: money(remaining) })}
            </button>
          </div>
        )}
      </form>
      {!refund && card && (
        <div className="sv-found">
          <p>
            {t("Balance")} <strong>{aed(card.balance)}</strong>
          </p>
          <label htmlFor="gc-amt">{t("Amount to use")}</label>
          <input id="gc-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
        </div>
      )}
      <Problem text={error} />
      {!refund && (
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            {t("Back")}
          </button>
          <button type="button" className="btn primary" disabled={!card || busy} onClick={() => void spend()}>
            {busy && card ? t("Saving…") : t("Use gift card")}
          </button>
        </div>
      )}
    </div>
  );
}

function PointsTender({ method, refund, remaining, customerId, pointsRoom, onAdd, onCancel }: Props) {
  const loyalty = useLoyalty();
  const [balance, setBalance] = useState<number | null>(null);
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId || refund) return;
    request<{ points: number }>(`/customers/${customerId}`)
      .then((c) => setBalance(c.points))
      .catch((err) => setError(isOffline(err) ? t("Gift cards and points need the internet. Take another payment.") : (err as Error).message));
  }, [customerId, refund]);

  if (!customerId) {
    return (
      <div className="sv-panel">
        <h3>
          <Icon name="star" size={20} />
          {t("Points")}
        </h3>
        <Problem text={t("Points can only be used with a customer on the sale. Add the customer first.")} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t("Back")}
          </button>
        </div>
      </div>
    );
  }

  if (refund) {
    const amount = Math.min(remaining, pointsRoom);
    const pts = pointsForRefund(amount, loyalty);
    return (
      <div className="sv-panel">
        <h3>
          <Icon name="star" size={20} />
          {t("Refund to points")}
        </h3>
        {amount <= 0 ? (
          <Problem text={t("The sale was not paid with points, so nothing goes back as points.")} />
        ) : (
          <p>{t("{points} points go back to the customer for {amount}.", { points: pts, amount: aed(amount) })}</p>
        )}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t("Back")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={amount <= 0}
            onClick={() => onAdd({ id: crypto.randomUUID(), methodId: method.id, kind: "points", amount: -amount, points: pts })}
          >
            {t("Give back {points} points", { points: pts })}
          </button>
        </div>
      </div>
    );
  }

  const max = balance === null ? 0 : maxRedeemablePoints(balance, remaining, loyalty);
  const want = entry ? Math.floor(Number(entry)) : max;
  const value = pointsValue(want, loyalty);
  const use = () => {
    if (!Number.isFinite(want) || want <= 0) return setError(t("Enter the points to use"));
    if (want < loyalty.minRedeemPoints) return setError(t("At least {n} points at a time.", { n: loyalty.minRedeemPoints }));
    if (want > max) return setError(t("At most {n} points on this sale.", { n: max }));
    onAdd({ id: crypto.randomUUID(), methodId: method.id, kind: "points", amount: value, points: want });
  };

  return (
    <div className="sv-panel">
      <h3>
        <Icon name="star" size={20} />
        {t("Pay with points")}
      </h3>
      {balance === null && !error && <p className="muted">{t("Checking the customer's points…")}</p>}
      {balance !== null && (
        <>
          <p>
            {t("Balance")} <strong>{t("{n} points", { n: balance })}</strong> · {t("worth {amount}", { amount: aed(pointsValue(balance, loyalty)) })}
          </p>
          {max === 0 ? (
            <Problem text={t("Not enough points yet: at least {n} are needed.", { n: loyalty.minRedeemPoints })} />
          ) : (
            <>
              <label htmlFor="pts">{t("Points to use (up to {n})", { n: max })}</label>
              <input id="pts" inputMode="numeric" value={entry} placeholder={String(max)} onChange={(e) => setEntry(e.target.value.replace(/\D/g, ""))} autoFocus />
              <p className="muted small">{t("Pays {amount}", { amount: aed(Number.isFinite(value) ? value : 0) })}</p>
            </>
          )}
        </>
      )}
      <Problem text={error} />
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("Back")}
        </button>
        <button type="button" className="btn primary" disabled={!max} onClick={use}>
          {t("Use points")}
        </button>
      </div>
    </div>
  );
}
