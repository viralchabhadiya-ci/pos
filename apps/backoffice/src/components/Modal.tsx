import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon.js";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])';

/**
 * A dialog that behaves like one: Escape and the backdrop close it (when closing is
 * allowed), Tab stays inside, and focus goes back to where it was when it closes.
 */
export function Modal({ children, onClose, wide, label }: { children: ReactNode; onClose?: () => void; wide?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const box = ref.current;
    if (box && !box.contains(document.activeElement)) {
      (box.querySelector<HTMLElement>("[autofocus]") ?? box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
    }
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="backdrop" onClick={onClose} role="presentation">
      <div
        ref={ref}
        className={wide ? "modal wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {onClose && (
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
