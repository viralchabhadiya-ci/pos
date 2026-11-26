import { useState, type FormEvent } from "react";
import "../developers.css";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, apiUrl, errorText } from "../lib/api.js";
import { ago, dateTime } from "../lib/format.js";
import { go } from "../lib/router.js";
import type { Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface Meta {
  scopes: { id: string; label: string }[];
  events: { id: string; label: string }[];
  apiVersion: string;
  maxAttempts: number;
  defaultRateLimit: number;
}

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimit: number;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  requestsHour: number;
}

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  disabledReason: string | null;
  failingSince: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  pending: number;
  failedWeek: number;
  succeededWeek: number;
}

type DeliveryStatus = "pending" | "succeeded" | "failed";

interface Delivery {
  id: string;
  type: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

interface DeliveryDetail extends Delivery {
  url: string;
  body: unknown;
  attemptLog: { at: string; responseStatus: number | null; responseBody: string | null; error: string | null; durationMs: number }[];
}

const useMeta = () => useLoad(() => api<Meta>("/developers/meta"), []);

/** API keys and webhooks, so the business can connect its own apps. */
export function Developers({ me, route }: { me: Me; route: string[] }) {
  const owner = me.user.role === "owner";
  const meta = useMeta();
  const tab = route[0] === "webhooks" ? "webhooks" : "keys";
  if (route[0] === "webhooks" && route[1]) {
    return <WebhookDetail id={route[1]} owner={owner} meta={meta.data} />;
  }
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Developers</h1>
          <p className="muted">
            Connect your online shop, accounting, ERP or delivery app. Apps read and change data through the API with a key you create, and
            webhooks tell them the moment something happens.
          </p>
        </div>
        <a className="btn" href={apiUrl("/docs")} target="_blank" rel="noreferrer">
          <Icon name="book" /> API reference
        </a>
      </header>
      <div className="tabs" role="tablist" aria-label="Developers">
        <button type="button" role="tab" className="tab" aria-selected={tab === "keys"} onClick={() => go("developers")}>
          API keys
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "webhooks"} onClick={() => go("developers/webhooks")}>
          Webhooks
        </button>
      </div>
      {!owner && (
        <p className="notice">
          <Icon name="alert" />
          <span>Only the owner can create keys and webhooks. You can see them and the delivery log.</span>
        </p>
      )}
      {meta.error && !meta.data ? (
        <ErrorState message={meta.error} onRetry={meta.reload} />
      ) : !meta.data ? (
        <SkeletonRows rows={3} />
      ) : tab === "webhooks" ? (
        <Webhooks owner={owner} meta={meta.data} />
      ) : (
        <Keys owner={owner} meta={meta.data} />
      )}
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      toast("Could not copy. Select the text and copy it by hand.", "error");
    }
  };
  return (
    <button type="button" className="btn sm" onClick={copy}>
      <Icon name="clipboard" /> {label}
    </button>
  );
}

/** A secret shown once, with a copy button. */
function SecretBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="secret-box">
      <code aria-label={label} tabIndex={0}>
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}

function keyState(k: ApiKey): { label: string; tone: string } {
  if (k.revokedAt) return { label: "Revoked", tone: "" };
  if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) return { label: "Expired", tone: "warn" };
  return { label: "Active", tone: "good" };
}

function Keys({ owner, meta }: { owner: boolean; meta: Meta }) {
  const list = useLoad(() => api<{ keys: ApiKey[] }>("/api-keys"), []);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const label = (id: string) => meta.scopes.find((s) => s.id === id)?.label ?? id;
  const keys = list.data?.keys ?? [];

  return (
    <>
      <div className="panel-head dev-head">
        <p className="muted">Each key belongs to one app. Give it only the permissions that app needs, and revoke it when you stop using the app.</p>
        {owner && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Create API key
          </button>
        )}
      </div>
      {list.error && !list.data ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows rows={3} />
      ) : keys.length === 0 ? (
        <EmptyState icon="key" title="No API keys yet">
          <p>Create one when an app asks for a POS API key.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">Permissions</th>
                <th>Last used</th>
                <th className="hide-sm">Created</th>
                <th>Status</th>
                {owner && (
                  <th className="actions">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const st = keyState(k);
                return (
                  <tr key={k.id} className={k.revokedAt ? "dim" : undefined}>
                    <td>
                      <span className="cell-main">{k.name}</span>
                      <span className="cell-sub">
                        <code className="mono">{k.prefix}…</code> · {k.rateLimit} requests a minute
                      </span>
                    </td>
                    <td className="hide-sm">
                      <span className="scope-list">{k.scopes.map(label).join(", ")}</span>
                    </td>
                    <td>
                      {ago(k.lastUsedAt)}
                      {k.requestsHour > 0 && <span className="cell-sub">{k.requestsHour} in the last hour</span>}
                    </td>
                    <td className="hide-sm">
                      {dateTime(k.createdAt)}
                      <span className="cell-sub">by {k.createdBy}</span>
                    </td>
                    <td>
                      <span className={`badge ${st.tone}`}>{st.label}</span>
                      {k.expiresAt && !k.revokedAt && <span className="cell-sub">Ends {k.expiresAt.slice(0, 10)}</span>}
                    </td>
                    {owner && (
                      <td className="actions">
                        {!k.revokedAt && (
                          <button type="button" className="btn ghost sm danger" onClick={() => setRevoking(k)}>
                            Revoke
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateKeyDialog meta={meta} onClose={() => (setCreating(false), void list.reload())} />}
      {revoking && <RevokeKeyDialog apiKey={revoking} onClose={() => setRevoking(null)} onDone={() => (setRevoking(null), void list.reload())} />}
    </>
  );
}

function CreateKeyDialog({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [rateLimit, setRateLimit] = useState(String(meta.defaultRateLimit));
  const [expiresOn, setExpiresOn] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const toggle = (id: string, on: boolean) => setScopes((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Name the key after the app that will use it, like Online shop";
    if (!scopes.length) errs.scopes = "Choose at least one permission";
    const limit = Number(rateLimit);
    if (!Number.isInteger(limit) || limit < 10 || limit > 6000) errs.rateLimit = "Between 10 and 6000";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await api<{ key: string }>("/api-keys", { body: { name: name.trim(), scopes, rateLimit: limit, expiresOn: expiresOn || null } });
      setCreated(res.key);
    } catch (err) {
      setErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal label="Your new API key">
        <h2>Copy your new API key</h2>
        <p>
          Paste it into <strong>{name}</strong> now. For your safety it is shown only this once. If you lose it, revoke it and create another.
        </p>
        <SecretBox value={created} label="API key" />
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            I have copied it
          </button>
        </div>
      </Modal>
    );
  }

  // Read and write of the same data sit side by side.
  return (
    <Modal onClose={onClose} label="Create API key" wide>
      <h2>Create API key</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Name" required error={errors.name} hint="Which app or partner uses this key">
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Online shop" autoFocus />}
        </Field>
        <fieldset className="group">
          <legend>Permissions</legend>
          <p className="hint">Change permissions include seeing the same data.</p>
          <div className="scope-grid">
            {meta.scopes.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <span>
                  {s.label}
                  <span className="hint">
                    <code>{s.id}</code>
                  </span>
                </span>
              </label>
            ))}
          </div>
          {errors.scopes && (
            <p className="field-error" role="alert">
              {errors.scopes}
            </p>
          )}
        </fieldset>
        <div className="form-grid">
          <Field label="Requests a minute" error={errors.rateLimit} hint="More than this and the app is asked to wait">
            {(p) => <input {...p} inputMode="numeric" value={rateLimit} onChange={(e) => setRateLimit(e.target.value.replace(/\D/g, ""))} />}
          </Field>
          <Field label="Stops working after" hint="Leave empty to keep it until you revoke it">
            {(p) => <input {...p} type="date" value={expiresOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiresOn(e.target.value)} />}
          </Field>
        </div>
        {errors.form && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {errors.form}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Create key
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeKeyDialog({ apiKey, onClose, onDone }: { apiKey: ApiKey; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    setBusy(true);
    try {
      await api(`/api-keys/${apiKey.id}/revoke`, { body: {} });
      toast(`${apiKey.name} revoked`);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={`Revoke ${apiKey.name}`}>
      <h2>Revoke {apiKey.name}?</h2>
      <p>The app using this key loses access straight away. This cannot be undone; create a new key to connect it again.</p>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>
          Keep it
        </button>
        <button type="button" className="btn danger-solid" onClick={revoke} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Revoke key
        </button>
      </div>
    </Modal>
  );
}

function endpointState(w: Endpoint): { label: string; tone: string } {
  if (!w.active) return { label: w.disabledReason ? "Turned off" : "Off", tone: w.disabledReason ? "bad" : "" };
  if (w.failingSince) return { label: "Failing", tone: "warn" };
  return { label: "On", tone: "good" };
}

const eventsText = (events: string[]) => (events.includes("*") ? "All events" : events.join(", "));

function Webhooks({ owner, meta }: { owner: boolean; meta: Meta }) {
  const list = useLoad(() => api<{ endpoints: Endpoint[] }>("/webhooks"), []);
  const [adding, setAdding] = useState(false);
  const endpoints = list.data?.endpoints ?? [];
  return (
    <>
      <div className="panel-head dev-head">
        <p className="muted">
          We send a signed POST to your address for each event you choose, and try again for about two days if it does not answer.
        </p>
        {owner && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add webhook
          </button>
        )}
      </div>
      {list.error && !list.data ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows rows={3} />
      ) : endpoints.length === 0 ? (
        <EmptyState icon="send" title="No webhooks yet">
          <p>Add the address your app gave you for POS events.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Address</th>
                <th className="hide-sm">Events</th>
                <th className="num hide-xs">Last 7 days</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((w) => {
                const st = endpointState(w);
                return (
                  <tr key={w.id} className="clickable">
                    <td>
                      <a className="row-link cell-main url-cell" href={`#/developers/webhooks/${w.id}`}>
                        {w.url}
                      </a>
                      {w.description && <span className="cell-sub">{w.description}</span>}
                    </td>
                    <td className="hide-sm">
                      <span className="scope-list">{eventsText(w.events)}</span>
                    </td>
                    <td className="num hide-xs">
                      {w.succeededWeek} sent
                      {w.failedWeek > 0 && <span className="cell-sub bad-text">{w.failedWeek} failed</span>}
                    </td>
                    <td>
                      <span className={`badge ${st.tone}`}>{st.label}</span>
                      {w.pending > 0 && <span className="cell-sub">{w.pending} waiting</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <EndpointDialog
          meta={meta}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            go(`developers/webhooks/${id}`);
          }}
        />
      )}
    </>
  );
}

function EndpointDialog({
  meta,
  endpoint,
  onClose,
  onSaved,
}: {
  meta: Meta;
  endpoint?: Endpoint;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [all, setAll] = useState(endpoint?.events.includes("*") ?? false);
  const [events, setEvents] = useState<string[]>(endpoint && !endpoint.events.includes("*") ? endpoint.events : []);
  const [active, setActive] = useState(endpoint?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!/^https?:\/\/\S+$/i.test(url.trim())) errs.url = "Enter the full address, starting with https://";
    if (!all && !events.length) errs.events = "Choose at least one event";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const body = { url: url.trim(), description: description.trim() || null, events: all ? ["*"] : events, active };
    try {
      if (endpoint) {
        await api(`/webhooks/${endpoint.id}`, { method: "PUT", body });
        toast("Webhook saved");
        onSaved(endpoint.id);
      } else {
        setSecret(await api<{ id: string; secret: string }>("/webhooks", { body }));
      }
    } catch (err) {
      setErrors({ url: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  if (secret) {
    return (
      <Modal label="Webhook added">
        <h2>Webhook added</h2>
        <p>Give this signing secret to the app, so it can check that events really come from your POS. You can show it again later.</p>
        <SecretBox value={secret.secret} label="Signing secret" />
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={() => onSaved(secret.id)} autoFocus>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} label={endpoint ? "Edit webhook" : "Add webhook"} wide>
      <h2>{endpoint ? "Edit webhook" : "Add webhook"}</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Address" required error={errors.url} hint="The https address your app gave you">
          {(p) => <input {...p} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://shop.example.com/pos-events" autoFocus />}
        </Field>
        <Field label="Description" hint="Optional, e.g. which app this is">
          {(p) => <input {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />}
        </Field>
        <fieldset className="group">
          <legend>Events</legend>
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>
              All events
              <span className="hint">Includes events added in the future</span>
            </span>
          </label>
          {!all && (
            <div className="scope-grid">
              {meta.events.map((ev) => (
                <label key={ev.id} className="check">
                  <input
                    type="checkbox"
                    checked={events.includes(ev.id)}
                    onChange={(e) => setEvents((s) => (e.target.checked ? [...s, ev.id] : s.filter((x) => x !== ev.id)))}
                  />
                  <span>
                    <code>{ev.id}</code>
                    <span className="hint">{ev.label}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {errors.events && (
            <p className="field-error" role="alert">
              {errors.events}
            </p>
          )}
        </fieldset>
        {endpoint && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>
              On
              <span className="hint">Switch off to stop sending without losing the settings.</span>
            </span>
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {endpoint ? "Save" : "Add webhook"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const PAGE = 30;
const STATUS: Record<DeliveryStatus, { label: string; tone: string }> = {
  succeeded: { label: "Delivered", tone: "good" },
  pending: { label: "Retrying", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
};

function WebhookDetail({ id, owner, meta }: { id: string; owner: boolean; meta: Meta | null }) {
  const toast = useToast();
  const ep = useLoad(() => api<Endpoint>(`/webhooks/${id}`), [id]);
  const [status, setStatus] = useState<DeliveryStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const log = useLoad(() => {
    const p = new URLSearchParams({ status, limit: String(PAGE), offset: String(offset) });
    return api<{ deliveries: Delivery[]; count: number }>(`/webhooks/${id}/deliveries?${p}`);
  }, [id, status, offset]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () => {
    void ep.reload();
    void log.reload();
  };

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const test = () =>
    run("test", async () => {
      const d = await api<DeliveryDetail>(`/webhooks/${id}/test`, { body: {} });
      toast(d.status === "succeeded" ? `Test delivered (HTTP ${d.responseStatus})` : `Test failed: ${d.error}`, d.status === "succeeded" ? "success" : "error");
      reload();
    });

  const showSecret = () => run("secret", async () => setSecret((await api<{ secret: string }>(`/webhooks/${id}/secret`)).secret));
  const rotate = () =>
    run("rotate", async () => {
      setSecret((await api<{ secret: string }>(`/webhooks/${id}/secret`, { body: {} })).secret);
      toast("New signing secret made. Update your app now; the old one has stopped working.");
    });

  const w = ep.data;
  const st = w ? endpointState(w) : null;
  const count = log.data?.count ?? 0;

  return (
    <div className="page">
      <a className="link back-link" href="#/developers/webhooks">
        ← Webhooks
      </a>
      {ep.error && !w ? (
        <ErrorState message={ep.error} onRetry={ep.reload} />
      ) : !w || !st ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <header className="page-head">
            <div className="min0">
              <h1 className="url-title">
                {w.url}
                <span className={`badge ${st.tone}`}>{st.label}</span>
              </h1>
              <p className="muted">
                {w.description ? `${w.description} · ` : ""}
                {eventsText(w.events)}
              </p>
            </div>
            {owner && (
              <div className="head-actions">
                <button type="button" className="btn" onClick={test} disabled={!w.active || busy === "test"}>
                  {busy === "test" ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />} Send test event
                </button>
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  <Icon name="edit" /> Edit
                </button>
              </div>
            )}
          </header>
          {w.disabledReason && (
            <p className="notice warn">
              <Icon name="alert" />
              <span>{w.disabledReason}. Fix the receiving app, then switch it back on under Edit. Missed events can be sent again from the log below.</span>
            </p>
          )}
          {w.active && w.failingSince && (
            <p className="notice warn">
              <Icon name="alert" />
              <span>Deliveries have been failing since {dateTime(w.failingSince)}. It turns off by itself after 3 days of failures.</span>
            </p>
          )}
          {owner && (
            <section className="panel" aria-labelledby="sig-h">
              <h2 id="sig-h">Signing secret</h2>
              <p className="muted small">
                Every request carries a <code>POS-Signature</code> header made with this secret. See the{" "}
                <a className="link" href={apiUrl("/docs#webhooks")} target="_blank" rel="noreferrer">
                  API reference
                </a>{" "}
                for how to check it.
              </p>
              {secret ? (
                <SecretBox value={secret} label="Signing secret" />
              ) : (
                <div className="row-actions">
                  <button type="button" className="btn" onClick={showSecret} disabled={busy === "secret"}>
                    <Icon name="key" /> Show secret
                  </button>
                  <button type="button" className="btn ghost" onClick={rotate} disabled={busy === "rotate"}>
                    <Icon name="refresh" /> Make a new one
                  </button>
                </div>
              )}
            </section>
          )}
          <section aria-labelledby="log-h">
            <div className="panel-head">
              <h2 id="log-h">Delivery log</h2>
              <div className="chips" role="group" aria-label="Filter by status">
                {(["all", "failed", "pending", "succeeded"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip"
                    aria-pressed={status === s}
                    onClick={() => {
                      setStatus(s);
                      setOffset(0);
                    }}
                  >
                    {s === "all" ? "All" : STATUS[s].label}
                  </button>
                ))}
              </div>
            </div>
            {log.error && !log.data ? (
              <ErrorState message={log.error} onRetry={log.reload} />
            ) : !log.data ? (
              <SkeletonRows rows={5} />
            ) : log.data.deliveries.length === 0 ? (
              <EmptyState icon="history" title={status === "all" ? "Nothing sent yet" : "Nothing here"}>
                {status === "all" && owner && <p>Send a test event to check the connection.</p>}
              </EmptyState>
            ) : (
              <div className="table-wrap" aria-busy={log.loading}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Status</th>
                      <th className="hide-sm">Answer</th>
                      <th className="hide-xs">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.data.deliveries.map((d) => (
                      <tr key={d.id} className="clickable">
                        <td>
                          <button type="button" className="row-link plain" onClick={() => setOpen(d.id)}>
                            <code>{d.type}</code>
                          </button>
                        </td>
                        <td>
                          <span className={`badge ${STATUS[d.status].tone}`}>{STATUS[d.status].label}</span>
                          <span className="cell-sub">
                            {d.attempts} {d.attempts === 1 ? "try" : "tries"}
                            {d.status === "pending" && d.nextAttemptAt ? ` · next ${dateTime(d.nextAttemptAt)}` : ""}
                          </span>
                        </td>
                        <td className="hide-sm">
                          {d.responseStatus ? `HTTP ${d.responseStatus}` : d.error ? <span className="cell-sub">{d.error}</span> : "—"}
                        </td>
                        <td className="hide-xs">{dateTime(d.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {count > PAGE && (
              <div className="pager">
                <span className="muted small">
                  {offset + 1}–{Math.min(offset + PAGE, count)} of {count}
                </span>
                <span>
                  <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    Newer
                  </button>{" "}
                  <button type="button" className="btn sm" disabled={offset + PAGE >= count} onClick={() => setOffset(offset + PAGE)}>
                    Older
                  </button>
                </span>
              </div>
            )}
          </section>
          {owner && (
            <section className="panel danger-zone" aria-labelledby="del-h">
              <h2 id="del-h">Delete webhook</h2>
              <p className="muted small">Stops all sending to this address and removes its delivery log.</p>
              <button type="button" className="btn danger" onClick={() => setDeleting(true)}>
                <Icon name="trash" /> Delete
              </button>
            </section>
          )}
        </>
      )}
      {open && <DeliveryDialog id={open} owner={owner} onClose={() => setOpen(null)} onChanged={reload} />}
      {editing && w && meta && (
        <EndpointDialog
          meta={meta}
          endpoint={w}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      {deleting && w && <DeleteEndpointDialog endpoint={w} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function DeliveryDialog({ id, owner, onClose, onChanged }: { id: string; owner: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<DeliveryDetail>(`/webhook-deliveries/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      const r = await api<DeliveryDetail>(`/webhook-deliveries/${id}/retry`, { body: {} });
      toast(r.status === "succeeded" ? "Delivered" : `Not delivered: ${r.error}`, r.status === "succeeded" ? "success" : "error");
      await d.reload();
      onChanged();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const x = d.data;
  return (
    <Modal onClose={onClose} label="Delivery" wide>
      {d.error && !x ? (
        <ErrorState message={d.error} onRetry={d.reload} />
      ) : !x ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <h2>
            <code>{x.type}</code>
            <span className={`badge ${STATUS[x.status].tone}`}>{STATUS[x.status].label}</span>
          </h2>
          <dl className="kv">
            <dt>Event id</dt>
            <dd>
              <code>{x.eventId}</code>
            </dd>
            <dt>Created</dt>
            <dd>{dateTime(x.createdAt)}</dd>
            <dt>Tries</dt>
            <dd>{x.attempts}</dd>
            {x.status === "pending" && x.nextAttemptAt && (
              <>
                <dt>Next try</dt>
                <dd>{dateTime(x.nextAttemptAt)}</dd>
              </>
            )}
          </dl>
          <h3>Tries</h3>
          {x.attemptLog.length === 0 ? (
            <p className="muted">Not tried yet.</p>
          ) : (
            <ol className="attempts">
              {x.attemptLog.map((a, i) => (
                <li key={i}>
                  <span className="cell-main">
                    {a.responseStatus ? `HTTP ${a.responseStatus}` : "No answer"} · {a.durationMs} ms ·{" "}
                    <span className="muted">{dateTime(a.at)}</span>
                  </span>
                  {a.error && <span className="cell-sub bad-text">{a.error}</span>}
                  {a.responseBody && <pre className="code-block small">{a.responseBody}</pre>}
                </li>
              ))}
            </ol>
          )}
          <h3>What was sent</h3>
          <pre className="code-block">{JSON.stringify(x.body, null, 2)}</pre>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            {owner && (
              <button type="button" className="btn primary" onClick={resend} disabled={busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                Send again
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function DeleteEndpointDialog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/webhooks/${endpoint.id}`, { method: "DELETE" });
      toast("Webhook deleted");
      go("developers/webhooks");
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Delete webhook">
      <h2>Delete this webhook?</h2>
      <p className="url-cell">{endpoint.url}</p>
      <p>Events stop going to it straight away, and its delivery log is removed.</p>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>
          Keep it
        </button>
        <button type="button" className="btn danger-solid" onClick={remove} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Delete webhook
        </button>
      </div>
    </Modal>
  );
}
