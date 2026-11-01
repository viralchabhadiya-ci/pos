import { useEffect, useState, type FormEvent } from "react";
import type { DeviceSetup, Session, User } from "../lib/db.js";
import { aed, tryParseMoney } from "../lib/format.js";
import { printOnHub, shiftReportDoc } from "../lib/print.js";
import { closeSession, shiftSummary, type ShiftSummary } from "../lib/till.js";
import { useSyncStatus } from "../lib/useSync.js";

/**
 * Blind close: the cashier counts first, then sees expected vs counted. Works offline
 * from local data; the server recalculates when the close syncs.
 */
export function CloseShiftScreen({
  setup,
  session,
  user,
  onClosed,
  onCancel,
}: {
  setup: DeviceSetup;
  session: Session;
  user: User;
  onClosed: () => void;
  onCancel: () => void;
}) {
  const hubPrinter = !!useSyncStatus().hub?.printer;
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [counted, setCounted] = useState("");
  const [submitted, setSubmitted] = useState<number | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    void shiftSummary(session).then(setSummary);
  }, [session]);

  const count = (e: FormEvent) => {
    e.preventDefault();
    const minor = tryParseMoney(counted);
    if (minor !== null && minor >= 0) setSubmitted(minor);
  };

  const confirm = async () => {
    if (submitted === null) return;
    await closeSession(session, user.id, submitted, note || undefined);
    if (hubPrinter && summary) {
      // The Z report goes in the cash bag; a printer problem must not undo the close.
      const doc = shiftReportDoc(setup, session, summary, { kind: "Z", userName: user.name, counted: submitted, note: note || undefined });
      await printOnHub(doc).catch(() => {});
    }
    onClosed();
  };

  if (!summary) return null;
  const diff = submitted === null ? null : submitted - summary.expectedCash;

  return (
    <main className="center">
      <div className="card">
        <h1>Close shift {session.seq}</h1>
        {submitted === null ? (
          <form onSubmit={count}>
            <p className="muted">Count all cash in the drawer and enter the total.</p>
            <label htmlFor="counted">Cash counted (AED)</label>
            <input id="counted" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />
            <div className="actions">
              <button type="button" className="btn ghost" onClick={onCancel}>
                Back to selling
              </button>
              <button className="btn primary">Next</button>
            </div>
          </form>
        ) : (
          <>
            <table className="summary">
              <tbody>
                <tr><td>Orders</td><td>{summary.orderCount}</td></tr>
                <tr><td>Sales total</td><td>{aed(summary.total)}</td></tr>
                <tr><td>VAT</td><td>{aed(summary.taxTotal)}</td></tr>
                {Object.entries(summary.byKind).map(([k, v]) => (
                  <tr key={k}><td>Paid by {k.replace("_", " ")}</td><td>{aed(v)}</td></tr>
                ))}
                <tr><td>Opening cash</td><td>{aed(summary.openingCash)}</td></tr>
                <tr><td>Cash in / out</td><td>{aed(summary.cashIn)} / {aed(summary.cashOut)}</td></tr>
                <tr className="strong"><td>Expected cash</td><td>{aed(summary.expectedCash)}</td></tr>
                <tr className="strong"><td>Counted</td><td>{aed(submitted)}</td></tr>
                <tr className={diff === 0 ? "good" : "bad"}><td>Difference</td><td>{aed(diff ?? 0)}</td></tr>
              </tbody>
            </table>
            {diff !== 0 && (
              <>
                <label htmlFor="note">Reason for the difference</label>
                <input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
              </>
            )}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setSubmitted(null)}>
                Recount
              </button>
              <button type="button" className="btn primary" onClick={confirm} disabled={diff !== 0 && !note.trim()}>
                Close shift
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
