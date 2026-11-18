import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./api.js";

/**
 * Loads data and keeps it fresh: polls while the app is on screen, refreshes as soon as it
 * comes back to the front, and keeps the last good data when a refresh fails (e.g. offline).
 */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const seq = useRef(0);
  const run = useCallback(load, deps);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await run();
      if (mine === seq.current) {
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
      }
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    setData(null);
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [reload, intervalMs]);

  return { data, error, loading, reload, updatedAt };
}
