import { ago } from "../lib/format.js";
import { Icon } from "./Icon.js";

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" />
      ))}
    </div>
  );
}

/** "Updated 2 min ago" with a refresh button, and a warning when the last refresh failed. */
export function Updated({ at, error, loading, onRefresh }: { at: number | null; error: string | null; loading: boolean; onRefresh: () => void }) {
  return (
    <>
      {error && at && <p className="offline">{error}</p>}
      <p className="updated">
        <span>{at ? `Updated ${ago(new Date(at).toISOString()).toLowerCase()}` : ""}</span>
        <button type="button" className="btn ghost sm" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={18} />}
          Refresh
        </button>
      </p>
    </>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card state" role="alert">
      <p className="state-title">Could not load this</p>
      <p>{message}</p>
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="card state">
      <Icon name="check" size={32} />
      <p className="state-title">{title}</p>
      <p>{text}</p>
    </div>
  );
}
