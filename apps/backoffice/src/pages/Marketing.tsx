import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { dateTime, money, tryParseMoney } from "../lib/format.js";
import type { Me, Promotion } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

type Channel = "email" | "sms" | "whatsapp";
type Status = "draft" | "scheduled" | "sending" | "sent" | "active" | "paused" | "cancelled";

interface Rules {
  minSpent?: number | null;
  maxSpent?: number | null;
  minOrders?: number | null;
  windowDays?: number | null;
  lastVisitWithinDays?: number | null;
  notVisitedForDays?: number | null;
  minPoints?: number | null;
  tagsAny?: string[] | null;
  birthdayThisMonth?: boolean | null;
  neverBought?: boolean | null;
}
interface Audience {
  total: number;
  email: number;
  sms: number;
  whatsapp: number;
  sample: { id: string; name: string }[];
}
interface Segment {
  id: string;
  name: string;
  rules: Rules;
  audience: Audience;
}
interface Counts {
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
}
interface Campaign {
  id: string;
  name: string;
  kind: "one_off" | "birthday";
  channel: Channel;
  segmentId: string | null;
  segmentName: string | null;
  subject: string | null;
  message: string;
  couponCode: string | null;
  status: Status;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  counts: Counts;
}
interface CampaignDetail extends Campaign {
  results: { buyers: number; orders: number; sales: number };
  messages: { id: string; name: string; to: string; status: "queued" | "sent" | "failed" | "skipped"; error: string | null; sentAt: string | null }[];
}
interface CampaignList {
  campaigns: Campaign[];
  transports: Record<Channel, string>;
  unsubscribeLinks: boolean;
}

const CHANNEL: Record<Channel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };
const STATUS: Record<Status, { label: string; tone?: "good" | "warn" }> = {
  draft: { label: "Draft" },
  scheduled: { label: "Scheduled", tone: "warn" },
  sending: { label: "Sending", tone: "warn" },
  sent: { label: "Sent", tone: "good" },
  active: { label: "On", tone: "good" },
  paused: { label: "Paused" },
  cancelled: { label: "Cancelled" },
};
const SMS_PART = 160;
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function StatusBadge({ status }: { status: Status }) {
  const s = STATUS[status];
  return <span className={`badge${s.tone ? ` ${s.tone}` : ""}`}>{s.label}</span>;
}

/** Marketing: segments of customers, and campaigns by email, SMS and WhatsApp, including birthday offers. */
export function Marketing({ me, tab }: { me: Me; tab?: string }) {
  const current = tab === "segments" ? "segments" : "campaigns";
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Marketing</h1>
          <p className="muted">Send offers to customers who agreed to get them. Every message carries a link to stop them.</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Marketing">
        {(
          [
            ["campaigns", "Campaigns"],
            ["segments", "Segments"],
          ] as const
        ).map(([id, label]) => (
          <a key={id} role="tab" className="tab tab-link" aria-selected={current === id} href={id === "campaigns" ? "#/marketing" : "#/marketing/segments"}>
            {label}
          </a>
        ))}
      </div>
      {current === "segments" ? <Segments /> : <Campaigns me={me} />}
    </div>
  );
}

// Campaigns

function Campaigns({ me }: { me: Me }) {
  const list = useLoad(() => api<CampaignList>("/campaigns"), []);
  const [editing, setEditing] = useState<Campaign | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <SkeletonRows rows={4} />;
  const { campaigns, transports, unsubscribeLinks } = list.data;
  const notSetUp = (Object.keys(transports) as Channel[]).filter((c) => transports[c] === "log");

  return (
    <>
      {!unsubscribeLinks && (
        <div className="callout warn-callout" role="note">
          <p>
            <strong>Campaigns cannot start yet.</strong> The server needs its public address (PUBLIC_URL) so each message can carry an unsubscribe link.
          </p>
        </div>
      )}
      {notSetUp.length > 0 && (
        <div className="callout" role="note">
          <p>
            {listOf(notSetUp.map((c) => CHANNEL[c]))} {notSetUp.length === 1 ? "is" : "are"} not connected yet, so those messages only go to the server log. Your
            provider details go in the server settings.
          </p>
        </div>
      )}
      <div className="section-head">
        <p className="muted">Write the message once. Names, points and coupon codes are filled in for each customer.</p>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" /> New campaign
        </button>
      </div>
      {campaigns.length === 0 ? (
        <EmptyState icon="send" title="No campaigns yet">
          <p className="muted">Start with a birthday offer: it goes out by itself on each customer's birthday.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Campaigns</caption>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col" className="hide-sm">To</th>
                <th scope="col">Status</th>
                <th scope="col" className="num hide-xs">Sent</th>
                <th scope="col" className="hide-sm">When</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className={c.status === "cancelled" ? "dim" : ""}>
                  <td>
                    <button type="button" className="row-link plain" onClick={() => setOpen(c.id)}>
                      {c.name}
                    </button>
                    <span className="cell-sub">
                      {CHANNEL[c.channel]}
                      {c.kind === "birthday" ? " · Birthday offer" : ""}
                    </span>
                  </td>
                  <td className="hide-sm">{c.kind === "birthday" ? "Customers on their birthday" : (c.segmentName ?? "Everyone who agreed")}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="num hide-xs">
                    {c.counts.sent}
                    {c.counts.queued > 0 && <span className="cell-sub">{c.counts.queued} waiting</span>}
                  </td>
                  <td className="hide-sm">
                    {c.status === "scheduled" && c.scheduledAt ? dateTime(c.scheduledAt) : c.finishedAt ? dateTime(c.finishedAt) : c.startedAt ? dateTime(c.startedAt) : <span className="muted">Not sent</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <CampaignDialog
          campaign={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            list.reload();
            setOpen(id);
          }}
        />
      )}
      {open && (
        <CampaignPanel
          id={open}
          me={me}
          canStart={unsubscribeLinks}
          onClose={() => setOpen(null)}
          onEdit={(c) => {
            setOpen(null);
            setEditing(c);
          }}
          onChanged={list.reload}
        />
      )}
    </>
  );
}

function CampaignDialog({ campaign, onClose, onSaved }: { campaign: Campaign | null; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const segments = useLoad(() => api<{ segments: Segment[]; everyone: Audience }>("/segments"), []);
  const promos = useLoad(() => api<{ promotions: Promotion[] }>("/promotions"), []);
  const [form, setForm] = useState({
    name: campaign?.name ?? "",
    kind: campaign?.kind ?? "one_off",
    channel: campaign?.channel ?? ("sms" as Channel),
    segmentId: campaign?.segmentId ?? "",
    subject: campaign?.subject ?? "",
    message: campaign?.message ?? "",
    couponCode: campaign?.couponCode ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const coupons = (promos.data?.promotions ?? []).filter((p) => p.code && (p.active || p.code === form.couponCode));

  const audience = form.kind === "birthday" ? null : form.segmentId ? segments.data?.segments.find((s) => s.id === form.segmentId)?.audience : segments.data?.everyone;
  // Roughly what one message will be: a first name and the stop link take some room.
  const length = form.message.length + (form.channel === "email" ? 0 : 60);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Give the campaign a name.";
    if (!form.message.trim()) errs.message = "Write the message.";
    if (form.channel === "email" && !form.subject.trim()) errs.subject = "An email needs a subject.";
    if (form.message.includes("{coupon}") && !form.couponCode) errs.couponCode = "The message has {coupon}. Pick the coupon.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`cd-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    const body = {
      name: form.name,
      kind: form.kind,
      channel: form.channel,
      segmentId: form.kind === "birthday" ? null : form.segmentId || null,
      subject: form.channel === "email" ? form.subject : null,
      message: form.message,
      couponCode: form.couponCode || null,
    };
    try {
      const id = campaign ? (await api(`/campaigns/${campaign.id}`, { method: "PUT", body }), campaign.id) : (await api<{ id: string }>("/campaigns", { body })).id;
      toast(campaign ? `${form.name} saved` : `${form.name} saved as a draft`);
      onSaved(id);
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={campaign ? `Edit ${campaign.name}` : "New campaign"} wide>
      <h2>{campaign ? "Edit campaign" : "New campaign"}</h2>
      <form onSubmit={submit} noValidate>
        <Field id="cd-name" label="Name" required error={errors.name} hint="Only you see this, e.g. Eid weekend.">
          {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} autoFocus />}
        </Field>
        <div className="form-grid">
          <Field label="Kind">
            {(p) => (
              <select {...p} value={form.kind} onChange={(e) => set("kind", e.target.value as "one_off" | "birthday")} disabled={!!campaign && campaign.status !== "draft"}>
                <option value="one_off">Send once</option>
                <option value="birthday">Birthday offer, every day</option>
              </select>
            )}
          </Field>
          <Field label="Send by">
            {(p) => (
              <select {...p} value={form.channel} onChange={(e) => set("channel", e.target.value as Channel)}>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            )}
          </Field>
        </div>
        {form.kind === "one_off" ? (
          <Field label="Who gets it" hint={audience ? `${audience[form.channel]} of ${audience.total} can get it by ${CHANNEL[form.channel]}: the rest did not agree or have no ${form.channel === "email" ? "email" : "mobile"}.` : undefined}>
            {(p) => (
              <select {...p} value={form.segmentId} onChange={(e) => set("segmentId", e.target.value)}>
                <option value="">Everyone who agreed</option>
                {segments.data?.segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <p className="hint">Goes out from 10:00 on each customer's birthday, once a year, to those who agreed. Customers need a birthday on their record.</p>
        )}
        {form.channel === "email" && (
          <Field id="cd-subject" label="Subject" required error={errors.subject}>
            {(p) => <input {...p} value={form.subject} onChange={(e) => set("subject", e.target.value)} maxLength={150} />}
          </Field>
        )}
        <Field
          id="cd-message"
          label="Message"
          required
          error={errors.message}
          hint={`Use {name} for the first name, {points}, {coupon} and {shop}.${
            form.channel === "sms" ? ` About ${length} characters: ${Math.max(1, Math.ceil(length / SMS_PART))} SMS ${Math.ceil(length / SMS_PART) > 1 ? "parts" : "part"} each.` : ""
          }`}
        >
          {(p) => (
            <textarea
              {...p}
              rows={4}
              value={form.message}
              onChange={(e) => set("message", e.target.value)}
              maxLength={1000}
              placeholder="Hi {name}, 20% off everything this weekend with code {coupon}. See you at {shop}!"
            />
          )}
        </Field>
        <Field id="cd-couponCode" label="Coupon" error={errors.couponCode} hint={coupons.length ? "A code from Promotions, for {coupon}." : "Add a promotion with a code in Promotions to offer one here."}>
          {(p) => (
            <select {...p} value={form.couponCode} onChange={(e) => set("couponCode", e.target.value)}>
              <option value="">No coupon</option>
              {coupons.map((c) => (
                <option key={c.id} value={c.code!}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CampaignPanel({
  id,
  me,
  canStart,
  onClose,
  onEdit,
  onChanged,
}: {
  id: string;
  me: Me;
  canStart: boolean;
  onClose: () => void;
  onEdit: (c: Campaign) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const detail = useLoad(() => api<CampaignDetail>(`/campaigns/${id}`), [id]);
  const preview = useLoad(
    () => api<{ text: string; subject: string | null; reach: number | null; smsParts: number | null }>(`/campaigns/${id}/preview`, { method: "POST", body: {} }),
    [id],
  );
  const [testTo, setTestTo] = useState("");
  const [later, setLater] = useState(false);
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = me.user.role === "owner";

  const act = async (what: string, path: string, body: unknown, done: (r: { status?: string; to?: string; transport?: string }) => string) => {
    setBusy(what);
    setError(null);
    try {
      const r = await api<{ status?: string; to?: string; transport?: string }>(`/campaigns/${id}/${path}`, { method: "POST", body });
      toast(done(r));
      await detail.reload();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const c = detail.data;
  return (
    <Modal onClose={onClose} label={c ? c.name : "Campaign"} wide>
      {detail.error ? (
        <ErrorState message={detail.error} onRetry={detail.reload} />
      ) : !c ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <div className="panel-title">
            <h2>
              {c.name} <StatusBadge status={c.status} />
            </h2>
            {["draft", "scheduled", "paused", "active"].includes(c.status) && (
              <button type="button" className="btn ghost sm" onClick={() => onEdit(c)}>
                <Icon name="edit" size={16} /> Edit
              </button>
            )}
          </div>
          <p className="muted">
            {CHANNEL[c.channel]} · {c.kind === "birthday" ? "Birthday offer" : (c.segmentName ?? "Everyone who agreed")}
            {c.status === "scheduled" && c.scheduledAt && ` · Starts ${dateTime(c.scheduledAt)}`}
          </p>

          <section aria-label="Message preview" className="message-preview">
            {preview.data?.subject && <p className="strong">{preview.data.subject}</p>}
            <p className="pre-line">{preview.data?.text ?? c.message}</p>
            {preview.data && (
              <p className="hint">
                {preview.data.reach !== null && `Reaches ${preview.data.reach} ${preview.data.reach === 1 ? "customer" : "customers"} now. `}
                {preview.data.smsParts && `${preview.data.smsParts} SMS ${preview.data.smsParts === 1 ? "part" : "parts"} each.`}
              </p>
            )}
          </section>

          {(c.counts.sent > 0 || c.counts.queued > 0 || c.counts.failed > 0) && (
            <div className="kpis campaign-kpis">
              <div className="kpi">
                <span className="kpi-label">Sent</span>
                <span className="kpi-value num">{c.counts.sent}</span>
                {c.counts.queued > 0 && <span className="kpi-note">{c.counts.queued} waiting</span>}
              </div>
              <div className="kpi">
                <span className="kpi-label">Not sent</span>
                <span className="kpi-value num">{c.counts.failed + c.counts.skipped}</span>
                <span className="kpi-note">{c.counts.failed} failed · {c.counts.skipped} skipped</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Came back</span>
                <span className="kpi-value num">{c.results.buyers}</span>
                <span className="kpi-note">Bought within 7 days</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Their sales (AED)</span>
                <span className="kpi-value num">{money(c.results.sales)}</span>
                <span className="kpi-note">{c.results.orders} bills</span>
              </div>
            </div>
          )}

          {c.status !== "sent" && c.status !== "cancelled" && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (testTo.trim()) void act("test", "test", { to: testTo }, (r) => (r.transport === "log" ? `Test went to the server log (${CHANNEL[c.channel]} is not connected)` : `Test sent to ${r.to}`));
              }}
            >
              <Field label={c.channel === "email" ? "Send a test to" : "Send a test to your mobile"}>
                {(p) => (
                  <input
                    {...p}
                    type={c.channel === "email" ? "email" : "tel"}
                    inputMode={c.channel === "email" ? "email" : "tel"}
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder={c.channel === "email" ? "you@example.ae" : "050 123 4567"}
                  />
                )}
              </Field>
              <button type="submit" className="btn" disabled={!testTo.trim() || busy === "test"}>
                {busy === "test" && <span className="spinner" aria-hidden="true" />} Send test
              </button>
            </form>
          )}

          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert" /> {error}
            </p>
          )}

          <div className="dialog-actions wrap">
            {["scheduled", "sending", "active"].includes(c.status) && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => act("pause", "pause", {}, (r) => (r.status === "draft" ? "Back to draft" : "Paused"))}>
                Pause
              </button>
            )}
            {!["sent", "cancelled"].includes(c.status) && (
              <button type="button" className="btn ghost danger" disabled={!!busy} onClick={() => act("cancel", "cancel", {}, () => `${c.name} cancelled`)}>
                Cancel campaign
              </button>
            )}
            {["draft", "paused"].includes(c.status) && isOwner && (
              <>
                {c.kind === "one_off" && c.status === "draft" && (
                  <label className="check inline">
                    <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />
                    <span>Send later</span>
                  </label>
                )}
                {later && c.status === "draft" && (
                  <input type="datetime-local" aria-label="Send at" value={at} onChange={(e) => setAt(e.target.value)} className="when-input" />
                )}
                <button
                  type="button"
                  className="btn primary"
                  disabled={!canStart || !!busy || (later && !at)}
                  title={canStart ? undefined : "The server needs PUBLIC_URL first"}
                  onClick={() =>
                    act("start", "start", later && at ? { at: new Date(at).toISOString() } : {}, (r) =>
                      r.status === "active" ? "Birthday offers are on" : later && at ? `Scheduled for ${dateTime(new Date(at).toISOString())}` : "Sending starts within a minute, between 09:00 and 21:00",
                    )
                  }
                >
                  {busy === "start" && <span className="spinner" aria-hidden="true" />}
                  {c.kind === "birthday" ? "Turn on" : c.status === "paused" ? "Resume" : later ? "Schedule" : "Send now"}
                </button>
              </>
            )}
          </div>
          {!isOwner && ["draft", "paused"].includes(c.status) && <p className="hint">Only the owner can send a campaign.</p>}

          {c.messages.length > 0 && (
            <details className="recent-messages">
              <summary>Latest messages</summary>
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Latest messages</caption>
                  <thead>
                    <tr>
                      <th scope="col">Customer</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="hide-xs">Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.messages.map((m) => (
                      <tr key={m.id}>
                        <td>
                          {m.name}
                          <span className="cell-sub tnum">{m.to}</span>
                        </td>
                        <td>
                          {m.status === "sent" ? (
                            <span className="badge good">Sent</span>
                          ) : m.status === "queued" ? (
                            <span className="badge">Waiting</span>
                          ) : (
                            <>
                              <span className="badge warn">{m.status === "failed" ? "Failed" : "Skipped"}</span>
                              {m.error && <span className="cell-sub">{m.error}</span>}
                            </>
                          )}
                        </td>
                        <td className="hide-xs">{m.sentAt ? dateTime(m.sentAt) : <span className="muted">-</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

// Segments

function Segments() {
  const list = useLoad(() => api<{ segments: Segment[]; everyone: Audience }>("/segments"), []);
  const [editing, setEditing] = useState<Segment | "new" | null>(null);
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <SkeletonRows rows={4} />;
  const { segments, everyone } = list.data;
  return (
    <>
      <div className="section-head">
        <p className="muted">
          A segment is a group of customers picked by rules, counted again each time a campaign goes out. You have {everyone.total} customers: {everyone.sms} can get SMS,{" "}
          {everyone.whatsapp} WhatsApp and {everyone.email} email.
        </p>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" /> New segment
        </button>
      </div>
      {segments.length === 0 ? (
        <EmptyState icon="users" title="No segments yet">
          <p className="muted">For example: customers who spent over AED 500, or who have not been back for 60 days.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Segments</caption>
            <thead>
              <tr>
                <th scope="col">Segment</th>
                <th scope="col" className="num">Customers</th>
                <th scope="col" className="num hide-xs">SMS</th>
                <th scope="col" className="num hide-xs">WhatsApp</th>
                <th scope="col" className="num hide-xs">Email</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button type="button" className="row-link plain" onClick={() => setEditing(s)}>
                      {s.name}
                    </button>
                    <span className="cell-sub">{describeRules(s.rules)}</span>
                  </td>
                  <td className="num strong">{s.audience.total}</td>
                  <td className="num hide-xs">{s.audience.sms}</td>
                  <td className="num hide-xs">{s.audience.whatsapp}</td>
                  <td className="num hide-xs">{s.audience.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <SegmentDialog
          segment={editing === "new" ? null : editing}
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

export function describeRules(r: Rules): string {
  const parts: string[] = [];
  const within = r.windowDays ? ` in the last ${r.windowDays} days` : "";
  if (r.minSpent != null) parts.push(`spent AED ${money(r.minSpent)} or more${within}`);
  if (r.maxSpent != null) parts.push(`spent up to AED ${money(r.maxSpent)}${within}`);
  if (r.minOrders) parts.push(`${r.minOrders}+ bills${within}`);
  if (r.lastVisitWithinDays) parts.push(`came in the last ${r.lastVisitWithinDays} days`);
  if (r.notVisitedForDays) parts.push(`not back for ${r.notVisitedForDays} days`);
  if (r.neverBought) parts.push("never bought");
  if (r.minPoints) parts.push(`${r.minPoints}+ points`);
  if (r.tagsAny?.length) parts.push(`tagged ${r.tagsAny.join(" or ")}`);
  if (r.birthdayThisMonth) parts.push("birthday this month");
  if (!parts.length) return "Every customer";
  const s = parts.join(", ");
  return s[0]!.toUpperCase() + s.slice(1);
}

function SegmentDialog({ segment, onClose, onSaved }: { segment: Segment | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const r = segment?.rules ?? {};
  const num = (v: number | null | undefined) => (v == null ? "" : String(v));
  const [form, setForm] = useState({
    name: segment?.name ?? "",
    minSpent: r.minSpent == null ? "" : money(r.minSpent).replace(/,/g, ""),
    maxSpent: r.maxSpent == null ? "" : money(r.maxSpent).replace(/,/g, ""),
    minOrders: num(r.minOrders),
    windowDays: num(r.windowDays),
    visit: r.lastVisitWithinDays ? "within" : r.notVisitedForDays ? "away" : r.neverBought ? "never" : "",
    visitDays: num(r.lastVisitWithinDays ?? r.notVisitedForDays),
    minPoints: num(r.minPoints),
    tags: (r.tagsAny ?? []).join(", "),
    birthdayThisMonth: !!r.birthdayThisMonth,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<Audience | null>(segment?.audience ?? null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const build = (): { rules: Rules; errs: Record<string, string> } => {
    const errs: Record<string, string> = {};
    const amount = (k: "minSpent" | "maxSpent") => {
      if (!form[k].trim()) return null;
      const v = tryParseMoney(form[k]);
      if (v === null || v < 0) errs[k] = "Enter an amount in AED, like 500";
      return v;
    };
    const whole = (k: "minOrders" | "windowDays" | "visitDays" | "minPoints") => {
      if (!form[k].trim()) return null;
      const v = Number(form[k]);
      if (!Number.isInteger(v) || v < 1) errs[k] = "Enter a whole number";
      return v;
    };
    const days = form.visit === "within" || form.visit === "away" ? whole("visitDays") : null;
    if ((form.visit === "within" || form.visit === "away") && !form.visitDays.trim()) errs.visitDays = "How many days?";
    const rules: Rules = {
      minSpent: amount("minSpent"),
      maxSpent: amount("maxSpent"),
      minOrders: whole("minOrders"),
      windowDays: whole("windowDays"),
      lastVisitWithinDays: form.visit === "within" ? days : null,
      notVisitedForDays: form.visit === "away" ? days : null,
      neverBought: form.visit === "never" || null,
      minPoints: whole("minPoints"),
      tagsAny: form.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
      birthdayThisMonth: form.birthdayThisMonth || null,
    };
    if (!rules.tagsAny!.length) rules.tagsAny = null;
    // Leave out empty rules so the saved segment stays readable.
    for (const k of Object.keys(rules) as (keyof Rules)[]) if (rules[k] == null) delete rules[k];
    return { rules, errs };
  };

  // Live count as the rules change.
  const { rules, errs: liveErrs } = build();
  const key = JSON.stringify(rules);
  useEffect(() => {
    if (Object.keys(liveErrs).length) return;
    let live = true;
    const t = setTimeout(() => {
      api<Audience>("/segments/preview", { body: { rules } })
        .then((a) => live && setCount(a))
        .catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = { ...liveErrs };
    if (!form.name.trim()) errs.name = "Give the segment a name.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`sg-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const body = { name: form.name, rules };
      if (segment) await api(`/segments/${segment.id}`, { method: "PUT", body });
      else await api("/segments", { body });
      toast(`${form.name} saved`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!segment) return;
    setBusy(true);
    try {
      await api(`/segments/${segment.id}`, { method: "DELETE" });
      toast(`${segment.name} deleted`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={segment ? `Edit ${segment.name}` : "New segment"} wide>
      <h2>{segment ? "Edit segment" : "New segment"}</h2>
      <form onSubmit={submit} noValidate>
        <Field id="sg-name" label="Name" required error={errors.name}>
          {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} autoFocus placeholder="Big spenders" />}
        </Field>
        <p className="hint">Customers must match every rule you fill in. Leave a rule empty to ignore it.</p>
        <div className="form-grid">
          <Field id="sg-minSpent" label="Spent at least (AED)" error={errors.minSpent}>
            {(p) => <input {...p} inputMode="decimal" value={form.minSpent} onChange={(e) => set("minSpent", e.target.value)} />}
          </Field>
          <Field id="sg-maxSpent" label="Spent at most (AED)" error={errors.maxSpent}>
            {(p) => <input {...p} inputMode="decimal" value={form.maxSpent} onChange={(e) => set("maxSpent", e.target.value)} />}
          </Field>
          <Field id="sg-minOrders" label="Bills, at least" error={errors.minOrders}>
            {(p) => <input {...p} inputMode="numeric" value={form.minOrders} onChange={(e) => set("minOrders", e.target.value)} />}
          </Field>
          <Field id="sg-windowDays" label="Count spend and bills over the last (days)" error={errors.windowDays} hint="Empty means all time.">
            {(p) => <input {...p} inputMode="numeric" value={form.windowDays} onChange={(e) => set("windowDays", e.target.value)} />}
          </Field>
          <Field label="Visits">
            {(p) => (
              <select {...p} value={form.visit} onChange={(e) => set("visit", e.target.value)}>
                <option value="">Any</option>
                <option value="within">Came in within the last…</option>
                <option value="away">Not back for…</option>
                <option value="never">Never bought</option>
              </select>
            )}
          </Field>
          {(form.visit === "within" || form.visit === "away") && (
            <Field id="sg-visitDays" label="Days" error={errors.visitDays}>
              {(p) => <input {...p} inputMode="numeric" value={form.visitDays} onChange={(e) => set("visitDays", e.target.value)} placeholder="30" />}
            </Field>
          )}
          <Field id="sg-minPoints" label="Points, at least" error={errors.minPoints}>
            {(p) => <input {...p} inputMode="numeric" value={form.minPoints} onChange={(e) => set("minPoints", e.target.value)} />}
          </Field>
          <Field label="Has any of these tags" hint="Separate with commas.">
            {(p) => <input {...p} value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="vip, wholesale" />}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.birthdayThisMonth} onChange={(e) => set("birthdayThisMonth", e.target.checked)} />
          <span>Birthday this month</span>
        </label>
        <p className="segment-count" aria-live="polite">
          {count ? (
            <>
              <strong>{count.total}</strong> {count.total === 1 ? "customer matches" : "customers match"}: {count.sms} can get SMS, {count.whatsapp} WhatsApp, {count.email} email.
              {count.sample.length > 0 && <span className="hint">For example {count.sample.map((s) => s.name).join(", ")}.</span>}
            </>
          ) : (
            <span className="muted">Counting…</span>
          )}
        </p>
        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        <div className="dialog-actions">
          {segment && (
            <button type="button" className="btn ghost danger push-start" onClick={remove} disabled={busy}>
              <Icon name="trash" size={18} /> Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
