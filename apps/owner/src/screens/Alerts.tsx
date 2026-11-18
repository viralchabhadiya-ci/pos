import { Icon } from "../components/Icon.js";
import { Empty, ErrorState, Skeleton, Updated } from "../components/States.js";
import { api } from "../lib/api.js";
import { money } from "../lib/format.js";
import type { Alert } from "../lib/types.js";
import { usePoll } from "../lib/usePoll.js";

/** The back office, where most alerts are dealt with. Set at build time when it lives elsewhere. */
const BACKOFFICE = (import.meta.env.VITE_BACKOFFICE_URL ?? "").replace(/\/$/, "");

export function Alerts({ storeId }: { storeId: string }) {
  const q = storeId ? `?storeId=${storeId}` : "";
  const { data, error, loading, reload, updatedAt } = usePoll(() => api<{ alerts: Alert[] }>(`/alerts${q}`), [q], 60_000);
  if (!data && error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={3} />;
  return (
    <>
      <Updated at={updatedAt} error={error} loading={loading} onRefresh={reload} />
      {data.alerts.length === 0 && <Empty title="All clear" text="Nothing needs your attention right now." />}
      {data.alerts.map((a) => (
        <section key={a.kind} className={`card alert ${a.severity}`}>
          <h2>
            <Icon name="alert" size={20} />
            <span>{a.title}</span>
          </h2>
          <ul>
            {a.items.map((i, n) => (
              <li key={n}>
                <span>
                  <span className="title" style={{ display: "block", fontWeight: 600 }}>
                    {i.label}
                  </span>
                  {i.detail && <span className="small muted">{i.detail}</span>}
                </span>
                {i.amount !== undefined && a.kind !== "cash_variance" && <span className="amount">{money(i.amount)}</span>}
              </li>
            ))}
          </ul>
          {a.count > a.items.length && <p className="small muted" style={{ margin: "8px 0 0" }}>and {a.count - a.items.length} more</p>}
          {a.kind === "approvals_pending" ? (
            <a className="btn sm" href="#/approvals" style={{ marginTop: 12 }}>
              Review requests
            </a>
          ) : (
            a.href &&
            BACKOFFICE && (
              <a className="btn sm" href={`${BACKOFFICE}/${a.href}`} target="_blank" rel="noreferrer" style={{ marginTop: 12 }}>
                Open in back office <Icon name="external" size={16} />
              </a>
            )
          )}
        </section>
      ))}
    </>
  );
}
