import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./api.js";

/**
 * Loads data for a page and exposes a reload, with loading and error states. A slow
 * older request never overwrites a newer one, e.g. while someone types in a search box.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await run();
      if (mine === seq.current) setData(result);
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}
