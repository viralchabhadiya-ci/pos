import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon.js";

type Kind = "success" | "error";
const ToastContext = createContext<(message: string, kind?: Kind) => void>(() => {});

/** Confirms a save or reports a failure without taking focus; clears itself after 4 seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: Kind; id: number } | null>(null);
  const show = useCallback((message: string, kind: Kind = "success") => setToast({ message, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className={`toast ${toast.kind}`} key={toast.id}>
            <Icon name={toast.kind === "success" ? "check" : "alert"} />
            <span>{toast.message}</span>
            <button type="button" className="icon-btn" onClick={() => setToast(null)} aria-label="Dismiss">
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
