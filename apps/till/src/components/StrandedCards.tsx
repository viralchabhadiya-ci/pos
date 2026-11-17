import { useEffect, useState } from "react";
import { checkCard, loadTerminal, resolveCard, strandedCardPayments, type Terminal } from "../lib/card.js";
import { OfflineError } from "../lib/api.js";
import { db, type CardAttempt } from "../lib/db.js";
import { aed } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { CardPanel } from "./CardPanel.js";
import { Icon } from "./Icon.js";
import { ManagerPin } from "./ManagerPin.js";
import { Modal } from "./Modal.js";

/**
 * Card payments that were charged but never reached a sale (the till closed mid-payment).
 * They stay on screen until the card is refunded or a manager confirms it was sorted out.
 */
export function StrandedCards({ userId }: { userId: string }) {
  const [list, setList] = useState<CardAttempt[]>([]);
  const [refunding, setRefunding] = useState<{ attempt: CardAttempt; terminal: Terminal } | null>(null);
  const [approving, setApproving] = useState<CardAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Returns true while some payment's outcome is still not known, so it is checked again soon. */
  const refresh = async () => {
    const candidates = await strandedCardPayments();
    // Payments still waiting or unknown: ask the server first, so only real charges show.
    for (const a of candidates.filter((c) => c.status !== "approved")) await checkCard(a).catch(() => undefined);
    const now = await strandedCardPayments();
    setList(now.filter((a) => a.status === "approved" && a.kind === "sale"));
    return now.some((a) => a.status === "pending" || a.status === "unknown");
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      const open = await refresh().catch(() => true);
      if (!stopped) timer = setTimeout(() => void loop(), open ? 5_000 : 60_000);
    };
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list.length) return null;

  const refund = async (attempt: CardAttempt) => {
    setError(null);
    const found = await loadTerminal().catch(() => null);
    if (!found?.terminal || !found.online) return setError(t("The card terminal is not reachable right now. Try again in a moment."));
    setRefunding({ attempt, terminal: found.terminal });
  };

  const resolve = async (id: string) => {
    await db.cardAttempts.update(id, { resolvedAt: new Date().toISOString() });
    await refresh();
  };

  return (
    <>
      <div className="stranded" role="alert">
        {list.map((a) => (
          <div key={a.id} className="stranded-row">
            <Icon name="alert" />
            <span>
              {a.cardLast4
                ? t("{amount} was charged on a card ending {last4} at {time}, but the sale was not finished.", {
                    amount: aed(a.amount),
                    last4: a.cardLast4,
                    time: new Date(a.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  })
                : t("{amount} was charged on a card at {time}, but the sale was not finished.", {
                    amount: aed(a.amount),
                    time: new Date(a.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  })}
            </span>
            <button type="button" className="btn" onClick={() => void refund(a)}>
              {t("Refund to card")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setApproving(a)}>
              {t("Already sorted")}
            </button>
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </div>
      {refunding && (
        <Modal onClose={undefined} label={t("Refund card payment")}>
          <CardPanel
            terminal={refunding.terminal}
            orderId={crypto.randomUUID()}
            amount={refunding.attempt.amount}
            kind="refund"
            userId={userId}
            refundOf={refunding.attempt.id}
            onApproved={() => {
              const id = refunding.attempt.id;
              setTimeout(() => {
                setRefunding(null);
                void resolve(id);
              }, 900);
            }}
            onClose={() => setRefunding(null)}
          />
        </Modal>
      )}
      {approving && (
        <ManagerPin
          reason={t("Confirm the {amount} card payment was dealt with (e.g. the sale was rung up again)", { amount: aed(approving.amount) })}
          onApprove={(managerId) => {
            const id = approving.id;
            setApproving(null);
            setError(null);
            resolveCard(id, managerId)
              .then(refresh)
              .catch((err: Error) =>
                setError(err instanceof OfflineError ? t("No connection. Try again when the till is back online.") : err.message),
              );
          }}
          onCancel={() => setApproving(null)}
        />
      )}
    </>
  );
}
