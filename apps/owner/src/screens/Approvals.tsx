import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.js";
import { Empty, ErrorState, Skeleton, Updated } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, APPROVAL_KIND, ago, time, timeLeft } from "../lib/format.js";
import { askForNotifications, notificationsOn, notificationsSupported } from "../lib/notify.js";
import type { Approval } from "../lib/types.js";
import { usePoll } from "../lib/usePoll.js";

const STATUS: Record<Approval["status"], string> = {
  pending: "Waiting",
  approved: "Approved",
  denied: "Denied",
  cancelled: "Cancelled at till",
  expired: "Not answered in time",
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Request({ a, onDone }: { a: Approval; onDone: () => void }) {
  const toast = useToast();
  const now = useNow();
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = timeLeft(a.expiresAt, now);

  async function decide(decision: "approve" | "deny") {
    setBusy(decision);
    setError(null);
    try {
      await api(`/approvals/${a.id}/decide`, { body: { decision, note: note.trim() || undefined } });
      toast(decision === "approve" ? "Approved. The till can go ahead." : "Denied. The till has been told.");
      onDone();
    } catch (err) {
      setError(errorText(err));
      onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card" aria-labelledby={`req-${a.id}`}>
      <div className="req-head">
        <span className="req-kind">{APPROVAL_KIND[a.kind]}</span>
        {a.amount !== null && <span className="req-amount">{aed(a.amount)}</span>}
      </div>
      <p className="req-summary" id={`req-${a.id}`}>
        {a.summary}
      </p>
      <p className="req-meta">
        {[a.requestedBy, a.registerName, a.storeName].filter(Boolean).join(" · ")} · asked {time(a.createdAt)}
        {" · "}
        <span className="countdown">{left ?? "Time is up"}</span>
      </p>
      {a.reason && <p className="req-reason">“{a.reason}”</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {showNote ? (
        <div className="field">
          <label htmlFor={`note-${a.id}`}>Note for the cashier (optional)</label>
          <textarea id={`note-${a.id}`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      ) : (
        <button type="button" className="btn ghost sm" onClick={() => setShowNote(true)} style={{ marginBottom: 8 }}>
          Add a note
        </button>
      )}
      <div className="req-actions">
        <button type="button" className="btn danger" disabled={busy !== null || !left} onClick={() => decide("deny")}>
          {busy === "deny" ? <span className="spinner" aria-hidden /> : <Icon name="close" size={20} />}
          Deny
        </button>
        <button type="button" className="btn primary" disabled={busy !== null || !left} onClick={() => decide("approve")}>
          {busy === "approve" ? <span className="spinner" aria-hidden /> : <Icon name="check" size={20} />}
          Approve
        </button>
      </div>
    </article>
  );
}

function NotificationsPrompt() {
  const [on, setOn] = useState(notificationsOn());
  if (on || !notificationsSupported() || Notification.permission === "denied") return null;
  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Icon name="bell" />
      <span className="small" style={{ flex: 1 }}>
        Get a phone notification when a till asks for approval.
      </span>
      <button type="button" className="btn sm" onClick={async () => setOn(await askForNotifications())}>
        Turn on
      </button>
    </div>
  );
}

export function Approvals({ onChange }: { onChange: () => void }) {
  const [view, setView] = useState<"pending" | "decided">("pending");
  const { data, error, loading, reload, updatedAt } = usePoll(
    () => api<{ approvals: Approval[] }>(`/approvals?status=${view}`),
    [view],
    view === "pending" ? 10_000 : 60_000,
  );
  const done = () => {
    void reload();
    onChange();
  };

  return (
    <>
      <div className="seg" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === "pending"} onClick={() => setView("pending")}>
          Waiting
        </button>
        <button type="button" aria-pressed={view === "decided"} onClick={() => setView("decided")}>
          History
        </button>
      </div>
      {view === "pending" && <NotificationsPrompt />}
      {!data && error && <ErrorState message={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={2} />}
      {data && (
        <>
          <Updated at={updatedAt} error={error} loading={loading} onRefresh={reload} />
          {data.approvals.length === 0 &&
            (view === "pending" ? (
              <Empty title="Nothing waiting" text="When a cashier needs your OK for a refund or a big discount, it shows up here." />
            ) : (
              <Empty title="No history yet" text="Requests you or your managers answer will be listed here." />
            ))}
          {view === "pending" && data.approvals.map((a) => <Request key={a.id} a={a} onDone={done} />)}
          {view === "decided" && data.approvals.length > 0 && (
            <section className="card">
              <ul className="list">
                {data.approvals.map((a) => (
                  <li key={a.id}>
                    <div className="grow">
                      <span className="title">{a.summary}</span>
                      <span className="sub">
                        {[a.requestedBy, a.registerName].filter(Boolean).join(" · ")} · {ago(a.createdAt)}
                        {a.decidedBy ? ` · by ${a.decidedBy}` : ""}
                        {a.note ? ` · “${a.note}”` : ""}
                      </span>
                    </div>
                    <span className={`status ${a.status}`}>{STATUS[a.status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
