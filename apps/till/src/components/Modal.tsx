import type { ReactNode } from "react";

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose?: () => void; wide?: boolean }) {
  return (
    <div className="backdrop" onClick={onClose} role="presentation">
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
