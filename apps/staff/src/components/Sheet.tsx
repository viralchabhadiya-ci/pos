import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.js";

/** A panel that slides up from the bottom, within thumb reach. Escape and the scrim close it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>("[autofocus], input, button") ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        {children}
      </div>
    </>
  );
}

/** A number with − and + on either side, for counting with one thumb. */
export function Stepper({ value, onChange, step = 1, id, label }: { value: string; onChange: (v: string) => void; step?: number; id: string; label: string }) {
  const n = Number(value) || 0;
  const set = (x: number) => onChange(String(Math.max(0, Math.round(x * 1000) / 1000)));
  return (
    <div className="stepper">
      <button type="button" onClick={() => set(n - step)} aria-label={`One less ${label}`}>
        −
      </button>
      <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} aria-label={label} />
      <button type="button" onClick={() => set(n + step)} aria-label={`One more ${label}`}>
        +
      </button>
    </div>
  );
}
