import { useEffect, useRef, useState } from "react";
import { cameraAvailable, getDetector } from "../lib/scanner.js";
import { Icon } from "./Icon.js";

/**
 * The phone's back camera with an aiming box. Calls onCode once per new code; the same code
 * is ignored for two seconds so one label is not read many times.
 */
export function Scanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Starting the camera…");
  const last = useRef<{ code: string; at: number } | null>(null);
  const handler = useRef(onCode);
  handler.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch {
        setStatus("The camera is blocked. Allow it in the browser settings, or type the code instead.");
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setStatus("Point at a barcode");
      const detector = await getDetector().catch(() => null);
      if (!detector) {
        setStatus("This phone cannot read barcodes. Type the code instead.");
        return;
      }
      const tick = async () => {
        if (stopped) return;
        try {
          if (v.readyState >= 2) {
            const found = await detector.detect(v);
            const code = found[0]?.rawValue?.trim();
            const now = Date.now();
            if (code && !(last.current && last.current.code === code && now - last.current.at < 2000)) {
              last.current = { code, at: now };
              navigator.vibrate?.(60);
              handler.current(code);
            }
          }
        } catch {
          // A frame that cannot be read is skipped.
        }
        timer = setTimeout(tick, 180);
      };
      void tick();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scan">
      <video ref={video} playsInline muted aria-label="Camera" />
      <span className="aim" aria-hidden="true" />
      <button type="button" className="icon-btn scan-close" onClick={onClose} aria-label="Close the camera">
        <Icon name="close" />
      </button>
      <p className="scan-status" role="status">
        {status}
      </p>
    </div>
  );
}

/** A box for a barcode, SKU or name, with a camera button where the phone has one. */
export function CodeInput({
  value,
  onChange,
  onSubmit,
  scanning,
  onScanToggle,
  placeholder = "Barcode, SKU or name",
  label = "Find a product",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  scanning: boolean;
  onScanToggle: () => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <form
      className="search-row"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="code-input">
        {label}
      </label>
      <input
        id="code-input"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {cameraAvailable() && (
        <button type="button" className={scanning ? "btn primary" : "btn"} onClick={onScanToggle} aria-pressed={scanning} aria-label={scanning ? "Stop scanning" : "Scan with the camera"}>
          <Icon name="camera" />
        </button>
      )}
      <button type="submit" className="btn" aria-label="Search">
        <Icon name="search" />
      </button>
    </form>
  );
}
