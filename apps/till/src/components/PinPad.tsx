import { useState } from "react";

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
    if (k === "clear") return setPin("");
    if (k === "ok") {
      if (pin.length >= 4) onSubmit(pin);
      setPin("");
      return;
    }
    if (pin.length < 8) setPin(pin + k);
  };
  return (
    <div className="pinpad">
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? "dot on" : "dot"} />
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="keys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "ok"].map((k) => (
          <button key={k} type="button" className={k === "ok" ? "key primary" : "key"} onClick={() => press(k)} disabled={busy}>
            {k === "clear" ? "Clear" : k === "ok" ? "OK" : k}
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
