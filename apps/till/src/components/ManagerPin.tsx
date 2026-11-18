import { useEffect, useRef, useState } from "react";
import { ApiError, OfflineError, request } from "../lib/api.js";
import { db } from "../lib/db.js";
import { t } from "../lib/i18n.js";
import { verifyPin } from "../lib/pin.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import { PinPad } from "./PinPad.js";

export type ApprovalKind = "refund" | "discount" | "void" | "price_override" | "cash_out" | "no_sale" | "other";

/** What the owner sees on their phone when the till asks instead of a manager PIN. */
export interface RemoteAsk {
  kind: ApprovalKind;
  /** One line the owner can decide on, e.g. "Refund AED 45.00 on bill DXB1-R1-0001-0042". */
  summary: string;
  amount?: number;
  /** The cashier asking. */
  userId: string;
}

interface Approval {
  id: string;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  decidedBy: string | null;
  decidedById: string | null;
  note: string | null;
  expiresAt: string;
}

/** The owner has a few minutes; the customer is usually waiting at the counter. */
const WAIT_SECONDS = 300;
const POLL_MS = 2500;

/**
 * Asks for any manager's PIN; resolves with that manager's id. With `ask`, the cashier can
 * instead send the request to the owner app and wait for the owner to approve it there.
 */
export function ManagerPin({
  reason,
  ask,
  onApprove,
  onCancel,
}: {
  reason: string;
  ask?: RemoteAsk;
  onApprove: (managerId: string, approvalId?: string) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<Approval | null>(null);
  const [now, setNow] = useState(Date.now());
  const pending = useRef<string | null>(null);

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
    setError(t("That PIN is not a manager PIN"));
  };

  const askOwner = async () => {
    if (!ask) return;
    setBusy(true);
    setError(null);
    try {
      const a = await request<Approval>("/approvals", {
        body: {
          id: crypto.randomUUID(),
          kind: ask.kind,
          summary: ask.summary,
          amount: ask.amount,
          requestedBy: ask.userId,
          waitSeconds: WAIT_SECONDS,
        },
      });
      pending.current = a.id;
      setRemote(a);
    } catch (err) {
      setError(
        err instanceof OfflineError || (err instanceof ApiError && err.status === 503)
          ? t("Asking the owner needs the internet. Enter a manager PIN instead.")
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  // Wait for the owner's answer.
  useEffect(() => {
    if (!remote || remote.status !== "pending") return;
    let stop = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      request<Approval>(`/approvals/${remote.id}`)
        .then((a) => {
          if (stop) return;
          setRemote(a);
          if (a.status !== "pending") pending.current = null;
        })
        // A dropped poll is retried on the next tick; the request stays open on the server.
        .catch(() => {});
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [remote?.id, remote?.status]);

  // Approved: show who approved it for a moment, then carry on.
  useEffect(() => {
    if (remote?.status !== "approved") return;
    const id = setTimeout(() => onApprove(remote.decidedById ?? ask!.userId, remote.id), 900);
    return () => clearTimeout(id);
  }, [remote?.status]);

  // Leaving while the owner has not answered withdraws the request, so it cannot be approved later.
  const withdraw = () => {
    const id = pending.current;
    pending.current = null;
    if (id) void request(`/approvals/${id}/cancel`, { method: "POST", body: {} }).catch(() => {});
  };
  useEffect(() => withdraw, []);

  const close = () => {
    withdraw();
    onCancel();
  };

  if (remote) {
    const left = Math.max(0, Math.round((Date.parse(remote.expiresAt) - now) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    return (
      <Modal onClose={close} label={t("Waiting for the owner")}>
        <div className="remote-ask" aria-live="polite">
          {remote.status === "pending" && (
            <>
              <span className="lock" aria-hidden="true">
                <Icon name="phone" size={26} />
              </span>
              <h2>{t("Waiting for the owner")}</h2>
              <p className="ask-summary">{ask?.summary}</p>
              <p className="muted">{t("The owner has been asked on their phone. This screen goes on by itself once they approve.")}</p>
              <p className="muted small tnum">{t("{time} left to answer", { time: clock })}</p>
              <div className="spinner" aria-hidden="true" />
            </>
          )}
          {remote.status === "approved" && (
            <>
              <span className="lock ok" aria-hidden="true">
                <Icon name="check" size={26} />
              </span>
              <h2>{t("Approved by {name}", { name: remote.decidedBy ?? t("the owner") })}</h2>
              {remote.note && <p className="muted">“{remote.note}”</p>}
            </>
          )}
          {(remote.status === "denied" || remote.status === "expired" || remote.status === "cancelled") && (
            <>
              <span className="lock bad" aria-hidden="true">
                <Icon name="alert" size={26} />
              </span>
              <h2>
                {remote.status === "denied"
                  ? t("Denied by {name}", { name: remote.decidedBy ?? t("the owner") })
                  : t("The owner did not answer in time")}
              </h2>
              {remote.note && <p className="muted">“{remote.note}”</p>}
            </>
          )}
          <div className="actions">
            {remote.status === "pending" ? (
              <button type="button" className="btn ghost" onClick={close}>
                {t("Stop waiting")}
              </button>
            ) : remote.status !== "approved" ? (
              <>
                <button type="button" className="btn ghost" onClick={onCancel}>
                  {t("Close")}
                </button>
                <button type="button" className="btn outline" onClick={() => setRemote(null)}>
                  {t("Enter a manager PIN")}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={close}>
      <PinPad title={t("Manager approval")} hint={reason} error={error} busy={busy} onSubmit={submit} onCancel={close} />
      {ask && (
        <div className="ask-owner">
          <span className="muted small">{t("No manager here?")}</span>
          <button type="button" className="btn outline" onClick={() => void askOwner()} disabled={busy}>
            <Icon name="phone" size={18} />
            {t("Ask the owner on their phone")}
          </button>
        </div>
      )}
    </Modal>
  );
}
