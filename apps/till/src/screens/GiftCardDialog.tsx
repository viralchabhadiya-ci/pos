import { newGiftCardCode } from "@pos/core";
import { useState, type FormEvent } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { aed, money, tryParseMoney } from "../lib/format.js";
import { checkGiftCard, giftCardError, GIFT_CARD_CODE, type GiftCardInfo } from "../lib/giftCards.js";
import { t } from "../lib/i18n.js";

const AMOUNTS = [5000, 10000, 20000, 50000];

/**
 * Sells a gift card (a new number, or more money onto a card the customer has) as a line on
 * the sale, or checks what is left on one. Selling works offline: the card is loaded when
 * the sale syncs. Checking a balance needs the internet.
 */
export function GiftCardDialog({ onAdd, onClose }: { onAdd: (code: string, amount: number) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"sell" | "check">("sell");
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [found, setFound] = useState<GiftCardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clean = code.trim().toUpperCase();

  const sell = (e: FormEvent) => {
    e.preventDefault();
    if (!GIFT_CARD_CODE.test(clean)) return setError(t("Gift card numbers are 6 to 40 letters, digits or dashes."));
    const fils = tryParseMoney(amount);
    if (!fils || fils <= 0) return setError(t("Enter an amount"));
    if (fils > 1_000_000) return setError(t("A gift card can be loaded with at most AED 10,000 at a time."));
    onAdd(clean, fils);
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!GIFT_CARD_CODE.test(clean)) return setError(t("Gift card numbers are 6 to 40 letters, digits or dashes."));
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await checkGiftCard(clean));
    } catch (err) {
      setError(giftCardError(err));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: "sell" | "check") => {
    setTab(next);
    setError(null);
    setFound(null);
  };

  return (
    <Modal onClose={onClose} label={t("Gift card")}>
      <h2>{t("Gift card")}</h2>
      <div className="seg" role="tablist" aria-label={t("Gift card")}>
        <button type="button" role="tab" aria-selected={tab === "sell"} className={tab === "sell" ? "on" : ""} onClick={() => switchTo("sell")}>
          {t("Sell or top up")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "check"} className={tab === "check" ? "on" : ""} onClick={() => switchTo("check")}>
          {t("Check balance")}
        </button>
      </div>
      <form onSubmit={tab === "sell" ? sell : check}>
        <label htmlFor="gcd-code">{t("Gift card number")}</label>
        <div className="inline-field">
          <input
            id="gcd-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
              setFound(null);
            }}
            placeholder={t("Scan or type the number")}
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={40}
            autoFocus
          />
          {tab === "sell" ? (
            <button type="button" className="btn outline" onClick={() => setCode(newGiftCardCode())}>
              {t("New number")}
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={busy || !clean}>
              {t("Check")}
            </button>
          )}
        </div>
        {tab === "sell" && (
          <>
            <p className="muted small">{t("Scan a printed card, or make a new number and write it on the receipt for the customer. Selling the same number again tops it up.")}</p>
            <label htmlFor="gcd-amt">{t("Amount")}</label>
            <input id="gcd-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" autoComplete="off" />
            <div className="quick">
              {AMOUNTS.map((a) => (
                <button key={a} type="button" className={tryParseMoney(amount) === a ? "chip on" : "chip"} onClick={() => setAmount(money(a))}>
                  {money(a)}
                </button>
              ))}
            </div>
          </>
        )}
        {found && (
          <div className="sv-found" aria-live="polite">
            <p>
              {t("Balance")} <strong>{aed(found.balance)}</strong>
            </p>
            {found.status !== "active" && <p className="error">{t("This gift card has been switched off.")}</p>}
            {found.expiresAt && (
              <p className="muted small">{t("Valid until {date}", { date: new Date(found.expiresAt).toLocaleDateString("en-GB") })}</p>
            )}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" size={18} />
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t(tab === "sell" ? "Cancel" : "Done")}
          </button>
          {tab === "sell" && (
            <button type="submit" className="btn primary" disabled={!clean || !amount}>
              <Icon name="plus" size={18} />
              {t("Add to sale")}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
