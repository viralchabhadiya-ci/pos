import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state error-state" role="alert">
      <Icon name="alert" size={24} />
      <p>{message}</p>
      <button type="button" className="btn" onClick={onRetry}>
        <Icon name="refresh" /> Try again
      </button>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <Icon name={icon} size={28} />
      <p className="state-title">{title}</p>
      {children}
    </div>
  );
}

/** Grey placeholder rows that hold the table's space while data loads. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}
