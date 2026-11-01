import { useEffect, useState } from "react";
import { Icon } from "./Icon.js";

interface Props {
  title: string;
  hint?: string;
  error?: string | null;
  busy?: boolean;
  onSubmit: (pin: string) => void;
  onCancel?: () => void;
}

export function PinPad({ title, hint, error, busy, onSubmit, onCancel }: Props) {
  const [pin, setPin] = useState("");
  const press = (k: string) => {
    if (busy) return;
    if (k === "back") return setPin(pin.slice(0, -1));
    if (k === "ok") {
      if (pin.length >= 4) onSubmit(pin);
      setPin("");
      return;
    }
    if (pin.length < 8) setPin(pin + k);
  };
  // A keyboard or number pad works too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Enter") press("ok");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="pinpad">
      <span className="lock" aria-hidden="true">
        <Icon name="lock" size={26} />
      </span>
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      <div className="pin-dots" role="status" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? "dot on" : "dot"} />
        ))}
      </div>
      {error && (
        <p className="error" role="alert" style={{ justifyContent: "center" }}>
          <Icon name="alert" size={18} />
          {error}
        </p>
      )}
      <div className="keys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "ok"].map((k) => (
          <button
            key={k}
            type="button"
            className={k === "ok" ? "key primary" : k === "back" ? "key subtle" : "key"}
            onClick={() => press(k)}
            disabled={busy || (k === "ok" && pin.length < 4)}
            aria-label={k === "back" ? "Delete last digit" : undefined}
          >
            {k === "back" ? <Icon name="backspace" /> : k === "ok" ? (busy ? "Checking…" : "OK") : k}
          </button>
        ))}
      </div>
      {onCancel && (
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
