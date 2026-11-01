import { useEffect, useRef } from "react";

/**
 * Barcode scanners type like a very fast keyboard and end with Enter. Keys that arrive
 * less than 40 ms apart are buffered; a burst of 6+ characters ending in Enter is a scan.
 * Typing into an input is left alone (the search box handles scans itself).
 */
export function useScanner(onScan: (code: string) => void) {
  const buffer = useRef("");
  const last = useRef(0);
  const handler = useRef(onScan);
  handler.current = onScan;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const now = performance.now();
      if (now - last.current > 40) buffer.current = "";
      last.current = now;
      if (e.key === "Enter") {
        if (buffer.current.length >= 6) handler.current(buffer.current);
        buffer.current = "";
      } else if (e.key.length === 1) {
        buffer.current += e.key;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
