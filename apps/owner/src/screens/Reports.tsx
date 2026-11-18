import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon.js";
import { ErrorState, Skeleton } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText, fetchHtml } from "../lib/api.js";
import { aed, change, dateTime, longDay } from "../lib/format.js";
import type { DailySummary, Me, ReportSettings } from "../lib/types.js";
import { usePoll } from "../lib/usePoll.js";

const DELIVERY: Record<string, string> = { pending: "Retrying", sending: "Sending", sent: "Sent", failed: "Failed", skipped: "Skipped" };
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SummaryCard() {
  const toast = useToast();
  const [date, setDate] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const q = date ? `?date=${date}` : "";
  const { data, error, reload } = usePoll(() => api<DailySummary>(`/reports/daily-summary${q}`), [q], 300_000);

  useEffect(() => {
    if (data && !date) setDate(data.date);
  }, [data, date]);
  useEffect(() => setPreview(null), [q]);

  async function togglePreview() {
    if (preview) return setPreview(null);
    try {
      setPreview(await fetchHtml(`/reports/daily-summary?format=html${date ? `&date=${date}` : ""}`));
    } catch (err) {
      toast(errorText(err));
    }
  }

  async function emailMe() {
    setSending(true);
    try {
      const res = await api<{ to: string[] }>("/reports/daily-summary/send", { body: { date: date || undefined, to: "me" } });
      toast(`Sent to ${res.to.join(", ")}`);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setSending(false);
    }
  }

  const t = data?.totals;
  const vs = data ? change(data.totals.total, data.previous.total) : null;
  return (
    <section className="card" aria-labelledby="summary-title">
      <div className="card-head">
        <h2 id="summary-title">Day summary</h2>
        <input
          type="date"
          aria-label="Day"
          value={date}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          style={{ width: "auto" }}
        />
      </div>
      {!data && error && <ErrorState message={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={1} />}
      {data && t && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {longDay(data.date)}
          </p>
          <div className="kpis">
            <div className="kpi">
              <div className="label">Sales</div>
              <div className="value">{aed(t.total)}</div>
            </div>
            <div className="kpi">
              <div className="label">vs week before</div>
              <div className="value">{vs ?? "–"}</div>
            </div>
            <div className="kpi">
              <div className="label">Bills</div>
              <div className="value">{t.orderCount}</div>
            </div>
            <div className="kpi">
              <div className="label">VAT</div>
              <div className="value">{aed(t.tax)}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={togglePreview} aria-expanded={Boolean(preview)}>
              {preview ? "Hide email" : "See the email"}
            </button>
            <button type="button" className="btn primary" onClick={emailMe} disabled={sending}>
              {sending ? <span className="spinner" aria-hidden /> : <Icon name="mail" size={18} />}
              Email me this
            </button>
          </div>
          {preview && (
            // The email is shown in a frame that cannot run scripts or reach the app.
            <iframe className="preview" title="Daily summary email" sandbox="" srcDoc={preview} style={{ marginTop: 12 }} />
          )}
        </>
      )}
    </section>
  );
}

function SettingsCard({ s, onSaved }: { s: ReportSettings; onSaved: () => void }) {
  const toast = useToast();
  const [mine, setMine] = useState(s.me.daily);
  const [enabled, setEnabled] = useState(s.settings.dailyEnabled);
  const [hour, setHour] = useState(s.settings.sendHour);
  const [extra, setExtra] = useState(s.settings.extraEmails);
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty =
    enabled !== s.settings.dailyEnabled || hour !== s.settings.sendHour || extra.join() !== s.settings.extraEmails.join();

  async function toggleMine(on: boolean) {
    setMine(on);
    try {
      await api("/report-settings/me", { method: "PUT", body: { daily: on } });
      toast(on ? "You will get the daily email." : "You will no longer get the daily email.");
      onSaved();
    } catch (err) {
      setMine(!on);
      toast(errorText(err));
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const email = adding.trim().toLowerCase();
    if (!EMAIL.test(email)) return setAddError("Enter a valid email address");
    if (extra.includes(email)) return setAddError("That address is already on the list");
    setExtra([...extra, email]);
    setAdding("");
    setAddError(null);
  }

  async function save() {
    setBusy(true);
    try {
      await api("/report-settings", { method: "PUT", body: { dailyEnabled: enabled, sendHour: hour, extraEmails: extra } });
      toast("Saved");
      onSaved();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="email-title">
      <h2 id="email-title">Daily email</h2>
      {s.transport === "log" && (
        <p className="offline">Email is not set up on this server yet, so summaries are only written to the server log.</p>
      )}
      <label className="switch">
        <span>
          Send me the daily summary
          <span className="hint">{s.me.email ?? "Your account has no email address"}</span>
        </span>
        <input type="checkbox" checked={mine} disabled={!s.me.email} onChange={(e) => toggleMine(e.target.checked)} />
      </label>
      {s.canEdit && (
        <>
          <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "12px 0" }} />
          <label className="switch">
            <span>Daily summary for the business</span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
          <div className="field">
            <label htmlFor="hour">Send at</label>
            <select id="hour" value={hour} onChange={(e) => setHour(Number(e.target.value))} disabled={!enabled}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <span className="hint">Shop time. Each morning's email covers the day before.</span>
          </div>
          <div className="field">
            <label htmlFor="extra">Also send to</label>
            {extra.length > 0 && (
              <ul className="chips">
                {extra.map((e) => (
                  <li key={e}>
                    {e}
                    <button type="button" onClick={() => setExtra(extra.filter((x) => x !== e))}>
                      <Icon name="close" size={16} label={`Remove ${e}`} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form className="row-input" onSubmit={add} noValidate>
              <input
                id="extra"
                type="email"
                inputMode="email"
                placeholder="accountant@example.ae"
                value={adding}
                aria-invalid={addError ? true : undefined}
                aria-describedby={addError ? "extra-error" : "extra-hint"}
                onChange={(e) => setAdding(e.target.value)}
              />
              <button type="submit" className="btn" disabled={!adding.trim() || extra.length >= 10}>
                Add
              </button>
            </form>
            {addError ? (
              <p className="field-error" id="extra-error">
                {addError}
              </p>
            ) : (
              <span className="hint" id="extra-hint">
                For people without a back office login, such as your accountant. Up to 10.
              </span>
            )}
          </div>
          <button type="button" className="btn primary block" disabled={!dirty || busy} onClick={save}>
            {busy && <span className="spinner" aria-hidden />}
            Save
          </button>
        </>
      )}
      <p className="small muted" style={{ margin: "12px 0 0" }}>
        {s.recipients.length ? `Goes to: ${s.recipients.join(", ")}` : "Nobody gets the daily email at the moment."}
      </p>
    </section>
  );
}

export function Reports({ me }: { me: Me }) {
  const { data, error, reload } = usePoll(() => api<ReportSettings>("/report-settings"), [me.user.id], 120_000);
  return (
    <>
      <SummaryCard />
      {!data && error && <ErrorState message={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={2} />}
      {data && (
        <>
          <SettingsCard key={JSON.stringify(data.settings) + data.me.daily} s={data} onSaved={reload} />
          {data.deliveries.length > 0 && (
            <section className="card">
              <h2>Recently sent</h2>
              <ul className="list">
                {data.deliveries.map((d) => (
                  <li key={d.id}>
                    <div className="grow">
                      <span className="title">
                        {longDay(d.date)}
                        {d.kind === "manual" ? " (on request)" : ""}
                      </span>
                      <span className="sub">
                        {dateTime(d.sentAt ?? d.createdAt)}
                        {d.recipients.length ? ` · ${d.recipients.length} ${d.recipients.length === 1 ? "person" : "people"}` : ""}
                        {d.error ? ` · ${d.error}` : ""}
                      </span>
                    </div>
                    <span className={`status ${d.status}`}>{DELIVERY[d.status]}</span>
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
