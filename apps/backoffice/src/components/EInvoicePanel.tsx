import { useState } from "react";
import "../einvoice.css";
import { api, download, errorText } from "../lib/api.js";
import { canRetry, STATUS, type EInvoice, type EInvoiceAttempt } from "../lib/einvoice.js";
import { ago, dateTime } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";
import { Icon } from "./Icon.js";
import { useToast } from "./Toast.js";

interface Data {
  enabled: boolean;
  einvoice: EInvoice | null;
  attempts: EInvoiceAttempt[];
}

const RESULT_TEXT: Record<string, string> = {
  accepted: "Accepted by the provider",
  rejected: "The provider rejected it",
  failed: "Could not be sent",
  retrying: "Provider not reachable. It will try again shortly.",
  skipped: "Not sent: outside the bills you chose to send",
  waiting: "Waiting for the original invoice first",
};

/** Shows where a bill's e-invoice is (sent, waiting, failed) and lets the owner resend it. */
export function EInvoicePanel({ orderId, number }: { orderId: string; number: string }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<Data>(`/orders/${orderId}/einvoice`), [orderId]);
  const [busy, setBusy] = useState<"send" | "xml" | null>(null);

  if (error) {
    return (
      <section className="panel" aria-labelledby="h-einv">
        <h2 id="h-einv">E-invoice</h2>
        <p className="muted">
          Could not load the e-invoice. <button type="button" className="btn ghost sm" onClick={reload}>Try again</button>
        </p>
      </section>
    );
  }
  if (!data) return null;
  const e = data.einvoice;
  if (!e && !data.enabled) {
    return (
      <section className="panel" aria-labelledby="h-einv">
        <h2 id="h-einv">E-invoice</h2>
        <p className="muted">
          E-invoicing is off. <a className="link" href="#/einvoicing/settings">Turn it on</a> to send bills to the FTA through your provider.
        </p>
      </section>
    );
  }

  const send = async () => {
    setBusy("send");
    try {
      const res = e
        ? await api<{ result: string | null }>(`/einvoices/${e.id}/retry`, { body: {} })
        : await api<{ result: string | null }>(`/orders/${orderId}/einvoice`, { body: {} });
      const text = (res.result && RESULT_TEXT[res.result]) ?? "Queued to send";
      toast(text, res.result === "accepted" || res.result === "waiting" ? "success" : "error");
      await reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const xml = async () => {
    if (!e) return;
    setBusy("xml");
    try {
      await download(`/einvoices/${e.id}/xml`, `${number}.xml`);
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const status = e ? STATUS[e.status] : null;
  const docName = e?.kind === "credit_note" ? "Credit note" : "Tax invoice";

  return (
    <section className="panel" aria-labelledby="h-einv">
      <div className="einv-head">
        <h2 id="h-einv">E-invoice</h2>
        {status && <span className={`badge ${status.tone}`}>{status.label}</span>}
      </div>

      {!e ? (
        <p className="muted">This bill was made before e-invoicing was turned on, so it has not been sent.</p>
      ) : (
        <>
          <dl className="einv-facts">
            <dt>Document</dt>
            <dd>{docName} (PINT AE)</dd>
            {e.status === "accepted" && (
              <>
                <dt>Accepted</dt>
                <dd>{e.acceptedAt ? dateTime(e.acceptedAt) : "Yes"}</dd>
                <dt>Reference</dt>
                <dd className="num">{e.providerRef}</dd>
              </>
            )}
            {e.status === "pending" && e.attempts > 0 && (
              <>
                <dt>Next try</dt>
                <dd>{new Date(e.nextAttemptAt) <= new Date() ? "Any moment now" : dateTime(e.nextAttemptAt)}</dd>
              </>
            )}
            <dt>Tries</dt>
            <dd>{e.attempts}</dd>
            {e.provider && (
              <>
                <dt>Provider</dt>
                <dd>{e.provider === "simulator" ? "Simulator (test mode)" : "Your provider"}</dd>
              </>
            )}
          </dl>
          {e.lastError && e.status !== "accepted" && (
            <p className={e.status === "failed" || e.status === "rejected" ? "notice bad einv-error" : "notice einv-error"} role="status">
              <Icon name="alert" />
              <span>{e.lastError}</span>
            </p>
          )}
        </>
      )}

      <div className="einv-actions">
        {(!e || canRetry(e.status)) && data.enabled && (
          <button type="button" className={e && e.status === "pending" ? "btn" : "btn primary"} onClick={send} disabled={!!busy}>
            {busy === "send" ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />}
            {busy === "send" ? "Sending…" : !e ? "Send e-invoice" : e.status === "skipped" ? "Send anyway" : e.status === "pending" ? "Send now" : "Try again"}
          </button>
        )}
        {e && (
          <button type="button" className="btn" onClick={xml} disabled={!!busy}>
            {busy === "xml" ? <span className="spinner" aria-hidden="true" /> : <Icon name="fileCode" />}
            Download XML
          </button>
        )}
      </div>

      {data.attempts.length > 0 && (
        <details className="einv-history">
          <summary>History ({data.attempts.length})</summary>
          <ul className="attempts">
            {data.attempts.map((a, i) => (
              <li key={i}>
                <Icon
                  name={a.outcome === "accepted" ? "check" : a.outcome === "rejected" ? "close" : "refresh"}
                  className={a.outcome === "accepted" ? "ok" : a.outcome === "rejected" ? "no" : "later"}
                  size={16}
                />
                <span>
                  <strong>{a.outcome === "accepted" ? "Accepted" : a.outcome === "rejected" ? "Rejected" : "Not reachable"}</strong>{" "}
                  <span className="muted">· {ago(a.at)}</span>
                  {a.message && <span className="cell-sub">{a.message}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
