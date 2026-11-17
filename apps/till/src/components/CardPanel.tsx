import { useEffect, useRef, useState } from "react";
import { cancelCard, checkCard, FINAL, startCard, type CardResult, type Terminal } from "../lib/card.js";
import { db, type CardAttempt } from "../lib/db.js";
import { aed } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { Icon } from "./Icon.js";

const POLL_MS = 1500;
/** After this long without an answer the cashier is told the terminal is slow, but can still wait. */
const SLOW_MS = 90_000;

interface Props {
  terminal: Terminal;
  orderId: string;
  amount: number;
  kind: "sale" | "refund";
  userId: string;
  refundOf?: string;
  onApproved: (r: CardResult) => void;
  onClose: () => void;
}

/**
 * Takes one card payment on the integrated terminal. While the outcome is not known the
 * only choices are to wait, check again or cancel on the terminal: a blind retry could
 * charge the customer twice.
 */
export function CardPanel({ terminal, orderId, amount, kind, userId, refundOf, onApproved, onClose }: Props) {
  const [attempt, setAttempt] = useState<CardAttempt | null>(null);
  const [result, setResult] = useState<CardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);
  const done = useRef(false);

  const begin = async () => {
    setError(null);
    setResult(null);
    setElapsed(0);
    setBusy(true);
    try {
      const r = await startCard({ orderId, amount, kind, userId, refundOf });
      setAttempt((await db.cardAttempts.get(r.id)) ?? null);
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const status = result?.status;
  const waiting = status === "pending" || status === "unknown";

  // Poll while the customer pays or while the answer is unknown.
  useEffect(() => {
    if (!attempt || !waiting) return;
    const timer = setTimeout(async () => {
      setElapsed(Date.now() - Date.parse(attempt.createdAt));
      const r = await checkCard(attempt).catch((err: Error) => ({ ...result!, message: err.message }));
      setResult(r);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [attempt, result, waiting, status]);

  useEffect(() => {
    if (status === "approved" && result && !done.current) {
      done.current = true;
      onApproved(result);
    }
  }, [status, result, onApproved]);

  const cancel = async () => {
    if (!attempt) return onClose();
    setBusy(true);
    try {
      setResult(await cancelCard(attempt));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!attempt) return;
    setBusy(true);
    try {
      setResult(await checkCard(attempt));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cardpanel" role="dialog" aria-modal="true" aria-labelledby="cp-title">
      <p className="muted">
        <Icon name="card" size={18} /> {terminal.name}
      </p>
      <h2 id="cp-title">
        {t(kind === "refund" ? "Refund {amount}" : "Charge {amount}", { amount: aed(amount) })}
      </h2>

      <div className={`cp-state ${status ?? (error ? "failed" : "pending")}`} aria-live="assertive">
        {error ? (
          <>
            <Icon name="alert" size={32} />
            <strong>{t("Could not start the payment")}</strong>
            <span>{error}</span>
          </>
        ) : !result ? (
          <>
            <span className="spinner lg" aria-hidden="true" />
            <strong>{t("Sending to the terminal…")}</strong>
          </>
        ) : status === "pending" ? (
          <>
            <span className="spinner lg" aria-hidden="true" />
            <strong>{t(kind === "refund" ? "Ask the customer to tap or insert the card for the refund" : "Ask the customer to tap, insert or swipe the card")}</strong>
            <span>{elapsed > SLOW_MS ? t("This is taking long. You can keep waiting or cancel on the terminal.") : t("Waiting for the customer to tap or insert the card")}</span>
          </>
        ) : status === "unknown" ? (
          <>
            <span className="spinner lg" aria-hidden="true" />
            <strong>{t("No answer from the terminal yet")}</strong>
            <span>{t("Checking again… Do not charge the card again until this clears.")}</span>
          </>
        ) : status === "approved" ? (
          <>
            <Icon name="check" size={32} />
            <strong>{t("Approved")}</strong>
            <span>
              {[result.cardBrand, result.cardLast4 && `•••• ${result.cardLast4}`, result.authCode && t("Auth {code}", { code: result.authCode })].filter(Boolean).join(" · ")}
            </span>
          </>
        ) : (
          <>
            <Icon name="alert" size={32} />
            <strong>{t(status === "declined" ? "Declined" : status === "cancelled" ? "Cancelled" : "Payment failed")}</strong>
            <span>{result.message ?? t("Nothing was charged.")}</span>
          </>
        )}
      </div>

      <div className="actions">
        {waiting ? (
          <>
            <button type="button" className="btn ghost" onClick={check} disabled={busy}>
              <Icon name="sync" /> {t("Check now")}
            </button>
            <button type="button" className="btn danger" onClick={cancel} disabled={busy}>
              {t("Cancel on terminal")}
            </button>
          </>
        ) : status && FINAL.has(status) && status !== "approved" ? (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("Other method")}
            </button>
            <button type="button" className="btn primary" onClick={begin} disabled={busy}>
              <Icon name="sync" /> {t("Try card again")}
            </button>
          </>
        ) : error ? (
          <button type="button" className="btn primary" onClick={onClose}>
            {t("Back")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
