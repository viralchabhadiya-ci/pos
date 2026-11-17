import { useState, type FormEvent } from "react";
import "../einvoice.css";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { canRetry, EMIRATES, STATUS, type EInvoiceRow, type EInvoiceSettings, type EInvoiceStatus } from "../lib/einvoice.js";
import { aed, dateTime } from "../lib/format.js";
import { go } from "../lib/router.js";
import type { Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const PAGE = 50;
const FILTERS: { value: EInvoiceStatus | "all"; label: string; tone?: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed", tone: "bad" },
  { value: "rejected", label: "Rejected", tone: "bad" },
  { value: "pending", label: "Waiting", tone: "warn" },
  { value: "accepted", label: "Accepted", tone: "good" },
  { value: "skipped", label: "Not sent" },
];

/** E-invoices sent to the FTA through the provider, and the settings for sending them. */
export function EInvoicing({ me, tab }: { me: Me; tab?: string }) {
  const current = tab === "settings" ? "settings" : "documents";
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>E-invoicing</h1>
          <p className="muted">
            Bills and refunds go to the FTA as PINT AE e-invoices and credit notes through your accredited service provider. Sending
            happens in the background; anything that fails is tried again automatically.
          </p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="E-invoicing">
        <button type="button" role="tab" className="tab" aria-selected={current === "documents"} onClick={() => go("einvoicing")}>
          Documents
        </button>
        <button type="button" role="tab" className="tab" aria-selected={current === "settings"} onClick={() => go("einvoicing/settings")}>
          Settings
        </button>
      </div>
      {current === "settings" ? <SettingsForm owner={me.user.role === "owner"} /> : <Documents />}
    </div>
  );
}

function Documents() {
  const toast = useToast();
  const [status, setStatus] = useState<EInvoiceStatus | "all">("all");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const list = useLoad(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (status !== "all") p.set("status", status);
    if (q.trim()) p.set("q", q.trim());
    return api<{ einvoices: EInvoiceRow[]; count: number; counts: Record<EInvoiceStatus, number> }>(`/einvoices?${p}`);
  }, [status, q, offset]);
  const settings = useLoad(() => api<{ settings: EInvoiceSettings }>("/einvoicing/settings"), []);

  const retry = async (id: string) => {
    setBusy(id);
    try {
      const res = await api<{ result: string | null }>(`/einvoices/${id}/retry`, { body: {} });
      toast(res.result === "accepted" ? "Accepted by the provider" : "Not accepted yet. See the bill for details.", res.result === "accepted" ? "success" : "error");
      await list.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const retryFailed = async () => {
    setBusy("all");
    try {
      const res = await api<{ queued: number }>("/einvoices/retry-failed", { body: {} });
      toast(`${res.queued} e-invoice${res.queued === 1 ? "" : "s"} queued to send again`);
      await list.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const counts = list.data?.counts;
  const total = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : 0;
  const enabled = settings.data?.settings.enabled;

  return (
    <>
      {settings.data && !enabled && (
        <p className="notice warn">
          <Icon name="alert" />
          <span>
            E-invoicing is off, so new bills are not being sent.{" "}
            <a className="link" href="#/einvoicing/settings">
              Open settings
            </a>
          </span>
        </p>
      )}
      {settings.data?.settings.enabled && settings.data.settings.provider === "simulator" && (
        <p className="notice">
          <Icon name="alert" />
          <span>Test mode: documents go to the built-in simulator, not to the FTA. Choose your provider in Settings before going live.</span>
        </p>
      )}

      {counts && (
        <div className="stat-row" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`stat-btn ${f.tone ?? ""}`}
              aria-pressed={status === f.value}
              onClick={() => (setOffset(0), setStatus(f.value))}
            >
              <span className="muted small">{f.label}</span>
              <strong>{f.value === "all" ? total : (counts[f.value] ?? 0) + (f.value === "pending" ? counts.sending ?? 0 : 0)}</strong>
            </button>
          ))}
        </div>
      )}

      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Bill number"
            placeholder="Bill number"
            value={q}
            onChange={(e) => (setOffset(0), setQ(e.target.value))}
          />
        </div>
        {(counts?.failed ?? 0) > 0 && enabled && (
          <button type="button" className="btn" onClick={retryFailed} disabled={!!busy}>
            {busy === "all" ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
            Retry all failed ({counts!.failed})
          </button>
        )}
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows />
      ) : list.data.count === 0 ? (
        <EmptyState icon="send" title={status === "all" && !q ? "No e-invoices yet" : "Nothing matches"}>
          <p className="muted">
            {status === "all" && !q ? "Once e-invoicing is on, every new bill shows up here." : "Try another status or clear the search."}
          </p>
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">E-invoices</caption>
              <thead>
                <tr>
                  <th scope="col">Bill</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hide-sm">Details</th>
                  <th scope="col" className="num hide-xs">Total (AED)</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.einvoices.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <a className="link num strong" href={`#/sales/${e.orderId}`}>
                        {e.number}
                      </a>
                      <span className="cell-sub">
                        {e.kind === "credit_note" ? "Credit note" : "Invoice"} · {dateTime(e.billAt)}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS[e.status].tone}`}>{STATUS[e.status].label}</span>
                      {e.attempts > 1 && <span className="cell-sub">{e.attempts} tries</span>}
                    </td>
                    <td className="hide-sm">
                      <span className="cell-sub">{e.status === "accepted" ? e.providerRef : e.lastError ?? ""}</span>
                    </td>
                    <td className={e.total < 0 ? "num bad hide-xs" : "num hide-xs"}>{aed(e.total).replace("AED ", "")}</td>
                    <td className="actions">
                      {canRetry(e.status) && e.status !== "skipped" && enabled && (
                        <button type="button" className="btn ghost sm" onClick={() => retry(e.id)} disabled={!!busy} aria-label={`Send ${e.number} now`}>
                          {busy === e.id ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={18} />}
                          <span className="hide-xs">{e.status === "pending" ? "Send now" : "Retry"}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data.count > PAGE && (
            <nav className="pager" aria-label="Pages">
              <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <Icon name="chevronLeft" /> Newer
              </button>
              <span className="muted">
                {offset + 1}–{Math.min(offset + PAGE, list.data.count)} of {list.data.count}
              </span>
              <button type="button" className="btn" disabled={offset + PAGE >= list.data.count} onClick={() => setOffset(offset + PAGE)}>
                Older <Icon name="chevronRight" />
              </button>
            </nav>
          )}
        </>
      )}
    </>
  );
}

interface SettingsData {
  settings: EInvoiceSettings;
  stores: { id: string; name: string; trn: string | null }[];
  tenantName: string;
}

function SettingsForm({ owner }: { owner: boolean }) {
  const { data, error, reload } = useLoad(() => api<SettingsData>("/einvoicing/settings"), []);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <SkeletonRows rows={5} />;
  return <SettingsFields data={data} owner={owner} onSaved={reload} />;
}

function SettingsFields({ data, owner, onSaved }: { data: SettingsData; owner: boolean; onSaved: () => void }) {
  const toast = useToast();
  const s = data.settings;
  const [form, setForm] = useState({
    enabled: s.enabled,
    scope: s.scope,
    provider: s.provider,
    simulatorMode: s.simulatorMode,
    endpointUrl: s.endpointUrl ?? "",
    apiKey: "",
    legalName: s.legalName ?? data.tenantName,
    street: s.street ?? "",
    city: s.city ?? "",
    emirate: s.emirate ?? "",
    maxAttempts: s.maxAttempts,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const missingTrn = data.stores.filter((st) => !st.trn);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (form.enabled && !form.legalName.trim()) errs.legalName = "Enter the name on your VAT certificate.";
    if (form.enabled && !form.emirate) errs.emirate = "Choose the emirate of your registered address.";
    if (form.provider === "http" && !/^https:\/\/\S+$/.test(form.endpointUrl.trim()))
      errs.endpointUrl = "Enter the provider's address, starting with https://";
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`einv-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api("/einvoicing/settings", {
        method: "PUT",
        body: {
          ...form,
          endpointUrl: form.endpointUrl.trim() || null,
          apiKey: form.apiKey.trim() ? form.apiKey.trim() : undefined,
          emirate: form.emirate || null,
          legalName: form.legalName.trim() || null,
          street: form.street.trim() || null,
          city: form.city.trim() || null,
        },
      });
      toast(form.enabled ? "E-invoicing settings saved" : "E-invoicing is off");
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel narrow-page" onSubmit={submit} noValidate>
      {!owner && <p className="muted">Only the owner can change these settings.</p>}
      {missingTrn.length > 0 && (
        <p className="notice warn">
          <Icon name="alert" />
          <span>
            {missingTrn.map((st) => st.name).join(", ")} {missingTrn.length === 1 ? "has" : "have"} no TRN, so its bills cannot be sent.{" "}
            <a className="link" href="#/settings">
              Add it in Settings
            </a>
          </span>
        </p>
      )}
      <fieldset disabled={!owner} className="plain-fieldset">
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>
            Send e-invoices
            <span className="hint">Every new bill and refund is queued and sent in the background. Turning it off pauses sending.</span>
          </span>
        </label>

        <Field label="Which bills" hint="Under the UAE rules, sales to VAT-registered businesses need an e-invoice first.">
          {(p) => (
            <select {...p} value={form.scope} onChange={(e) => set("scope", e.target.value as typeof form.scope)}>
              <option value="b2b">Only bills for customers with a TRN (B2B)</option>
              <option value="all">Every bill, including walk-in customers</option>
            </select>
          )}
        </Field>

        <h3>Your business</h3>
        <div className="form-grid">
          <Field id="einv-legalName" label="Legal name" required error={errors.legalName} hint="As on your VAT certificate.">
            {(p) => <input {...p} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} maxLength={200} />}
          </Field>
          <Field id="einv-emirate" label="Emirate" required error={errors.emirate}>
            {(p) => (
              <select {...p} value={form.emirate} onChange={(e) => set("emirate", e.target.value as typeof form.emirate)}>
                <option value="">Choose…</option>
                {EMIRATES.map((em) => (
                  <option key={em.value} value={em.value}>
                    {em.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Street">
            {(p) => <input {...p} value={form.street} onChange={(e) => set("street", e.target.value)} maxLength={200} />}
          </Field>
          <Field label="City">
            {(p) => <input {...p} value={form.city} onChange={(e) => set("city", e.target.value)} maxLength={100} />}
          </Field>
        </div>
        <p className="muted small">
          The TRN on each e-invoice is the store's TRN from <a className="link" href="#/settings">Settings</a>
          {data.stores.length === 1 && data.stores[0]!.trn ? ` (${data.stores[0]!.trn})` : ""}.
        </p>

        <h3>Provider</h3>
        <Field label="Send through" hint="Your accredited service provider (ASP) passes e-invoices on to the FTA.">
          {(p) => (
            <select {...p} value={form.provider} onChange={(e) => set("provider", e.target.value as typeof form.provider)}>
              <option value="simulator">Simulator (test mode, nothing reaches the FTA)</option>
              <option value="http">My provider's API</option>
            </select>
          )}
        </Field>
        {form.provider === "simulator" ? (
          <Field label="Simulator answers" hint="Try how failures look on bills before going live.">
            {(p) => (
              <select {...p} value={form.simulatorMode} onChange={(e) => set("simulatorMode", e.target.value as typeof form.simulatorMode)}>
                <option value="accept">Accept everything</option>
                <option value="flaky">Fail the first try, then accept</option>
                <option value="down">Always unreachable</option>
                <option value="reject">Reject everything</option>
              </select>
            )}
          </Field>
        ) : (
          <div className="form-grid">
            <Field id="einv-endpointUrl" label="API address" required error={errors.endpointUrl}>
              {(p) => (
                <input
                  {...p}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={form.endpointUrl}
                  onChange={(e) => set("endpointUrl", e.target.value)}
                  maxLength={500}
                />
              )}
            </Field>
            <Field label="API key" hint={s.hasApiKey ? "A key is saved. Leave empty to keep it." : "From your provider's portal."}>
              {(p) => (
                <input
                  {...p}
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  placeholder={s.hasApiKey ? "••••••••" : ""}
                  onChange={(e) => set("apiKey", e.target.value)}
                  maxLength={500}
                />
              )}
            </Field>
          </div>
        )}
        <Field label="Tries before giving up" hint="Waits 30 seconds after the first failure, then twice as long each time.">
          {(p) => (
            <select {...p} value={form.maxAttempts} onChange={(e) => set("maxAttempts", Number(e.target.value))}>
              {[3, 5, 8, 10, 12, 15].map((n) => (
                <option key={n} value={n}>
                  {n} tries
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
        {owner && (
          <div className="dialog-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
