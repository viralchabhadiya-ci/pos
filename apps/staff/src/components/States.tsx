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
