import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import type { Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

type Frequency = "daily" | "weekly" | "monthly";

interface Schedule {
  id: string;
  name: string;
  report: string;
  title: string;
  frequency: Frequency;
  storeId: string | null;
  storeName: string | null;
  recipients: string[];
  sendHour: number;
  active: boolean;
  lastRun: { status: "pending" | "sending" | "sent" | "failed"; sentAt: string | null; lastError: string | null; from: string; to: string } | null;
}

const FREQ: Record<Frequency, { label: string; note: string }> = {
  daily: { label: "Every day", note: "yesterday" },
  weekly: { label: "Every Monday", note: "last Monday to Sunday" },
  monthly: { label: "On the 1st", note: "last month" },
};

const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Reports → Scheduled: reports emailed with the CSV attached, e.g. to the accountant. */
export function ReportSchedules({ me }: { me: Me }) {
  const list = useLoad(() => api<{ schedules: Schedule[]; reports: { id: string; title: string }[] }>("/report-schedules"), []);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const toast = useToast();
  const isOwner = me.user.role === "owner";

  const sendNow = async (s: Schedule) => {
    setSending(s.id);
    try {
      const r = await api<{ period: { from: string; to: string }; transport: string }>(`/report-schedules/${s.id}/send`, { method: "POST", body: {} });
      toast(
        r.transport === "log"
          ? `No mail server is set up, so ${s.name} went to the server log only`
          : `${s.name} for ${r.period.from === r.period.to ? r.period.from : `${r.period.from} to ${r.period.to}`} sent to ${s.recipients.length} ${s.recipients.length === 1 ? "address" : "addresses"}`,
      );
      list.reload();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setSending(null);
    }
  };

  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <SkeletonRows rows={3} />;
  const schedules = list.data.schedules;
  return (
    <>
      <div className="section-head">
        <p className="muted">
          Reports sent by email with the CSV attached, for example the weekly VAT figures to your accountant. They go out at the hour you pick, in the
          store's time.
        </p>
        {isOwner && (
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> Schedule a report
          </button>
        )}
      </div>
      {schedules.length === 0 ? (
        <EmptyState icon="send" title="No scheduled reports">
          <p className="muted">{isOwner ? "Pick a report, how often, and who gets it." : "The owner can set these up."}</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Scheduled reports</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="hide-sm">Report</th>
                <th scope="col">When</th>
                <th scope="col" className="hide-sm">To</th>
                <th scope="col" className="hide-xs">Last sent</th>
                {isOwner && <th scope="col"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className={s.active ? "" : "dim"}>
                  <td>
                    {isOwner ? (
                      <button type="button" className="row-link plain" onClick={() => setEditing(s)}>
                        {s.name}
                      </button>
                    ) : (
                      s.name
                    )}
                    {!s.active && <span className="badge">Paused</span>}
                    <div className="muted small">{s.storeName ?? "All stores"}</div>
                  </td>
                  <td className="hide-sm">{s.title}</td>
                  <td>
                    {FREQ[s.frequency].label} at {hour(s.sendHour)}
                    <div className="muted small">Covers {FREQ[s.frequency].note}</div>
                  </td>
                  <td className="hide-sm">{s.recipients.join(", ")}</td>
                  <td className="hide-xs">
                    {!s.lastRun ? (
                      <span className="muted">Not yet</span>
                    ) : s.lastRun.status === "sent" && s.lastRun.sentAt ? (
                      dateTime(s.lastRun.sentAt)
                    ) : s.lastRun.status === "failed" || s.lastRun.lastError ? (
                      <span className="bad" title={s.lastRun.lastError ?? undefined}>
                        <Icon name="alert" size={16} /> {s.lastRun.status === "failed" ? "Failed" : "Retrying"}
                      </span>
                    ) : (
                      <span className="muted">Sending</span>
                    )}
                  </td>
                  {isOwner && (
                    <td className="num">
                      <button type="button" className="btn sm" disabled={sending === s.id} onClick={() => sendNow(s)}>
                        {sending === s.id && <span className="spinner" aria-hidden="true" />} Send now
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ScheduleDialog
          me={me}
          schedule={editing === "new" ? null : editing}
          reports={list.data.reports}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function ScheduleDialog({
  me,
  schedule,
  reports,
  onClose,
  onSaved,
}: {
  me: Me;
  schedule: Schedule | null;
  reports: { id: string; title: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(schedule?.name ?? "");
  const [report, setReport] = useState(schedule?.report ?? "day");
  const [frequency, setFrequency] = useState<Frequency>(schedule?.frequency ?? "weekly");
  const [storeId, setStoreId] = useState(schedule?.storeId ?? "");
  const [recipients, setRecipients] = useState(schedule?.recipients.join(", ") ?? "");
  const [sendHour, setSendHour] = useState(schedule?.sendHour ?? 7);
  const [active, setActive] = useState(schedule?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const emails = recipients.split(/[\s,;]+/).filter(Boolean);
    if (!name.trim()) return setError("Give the report a name, like Weekly VAT for the accountant");
    if (!emails.length) return setError("Add at least one email address");
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), report, frequency, storeId: storeId || null, recipients: emails, sendHour, active };
      if (schedule) await api(`/report-schedules/${schedule.id}`, { method: "PUT", body });
      else await api("/report-schedules", { body });
      toast(schedule ? `${body.name} saved` : `${body.name} scheduled`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!schedule) return;
    setBusy(true);
    try {
      await api(`/report-schedules/${schedule.id}`, { method: "DELETE" });
      toast(`${schedule.name} deleted`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={schedule ? `Edit ${schedule.name}` : "Schedule a report"}>
      <h2>{schedule ? "Edit scheduled report" : "Schedule a report"}</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Name" required>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="Weekly VAT for the accountant" />}
        </Field>
        <Field label="Report">
          {(p) => (
            <select {...p} value={report} onChange={(e) => setReport(e.target.value)}>
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="form-grid">
          <Field label="How often" hint={`Covers ${FREQ[frequency].note}`}>
            {(p) => (
              <select {...p} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                {(Object.keys(FREQ) as Frequency[]).map((f) => (
                  <option key={f} value={f}>
                    {FREQ[f].label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Send at">
            {(p) => (
              <select {...p} value={sendHour} onChange={(e) => setSendHour(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hour(h)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {me.stores.length > 1 && (
          <Field label="Store">
            {(p) => (
              <select {...p} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">All stores</option>
                {me.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Send to" required hint="Email addresses, separated by commas. Up to 20.">
          {(p) => <textarea {...p} rows={2} value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="accounts@example.ae" />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>
            On
            <span className="hint">Paused, nothing is sent until you switch it back on.</span>
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          {schedule && (
            <button type="button" className="btn danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {schedule ? "Save" : "Schedule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
