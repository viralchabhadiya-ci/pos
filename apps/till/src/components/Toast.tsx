import { useEffect } from "react";
import { Icon } from "./Icon.js";

/**
 * A short message that does not take focus, so a cashier can keep scanning. Screen
 * readers hear it through the live region; it clears itself after a few seconds.
 */
export function Toast({ message, onDone, ms = 4000 }: { message: string | null; onDone: () => void; ms?: number }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [message, ms, onDone]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && (
        <div className="toast">
          <Icon name="alert" />
          <span>{message}</span>
          <button type="button" className="icon-btn" onClick={onDone} aria-label="Dismiss">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
