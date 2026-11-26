import { useEffect, useState } from "react";

export type Tab = "price" | "count" | "receive" | "labels";
const TABS: Tab[] = ["price", "count", "receive", "labels"];

/** "#/count/<id>" → ["count", "<id>"]; anything unknown is the price check. */
export function parseHash(hash: string): [Tab, string | undefined] {
  const [t, id] = hash.replace(/^#\/?/, "").split("/") as [Tab, string | undefined];
  return TABS.includes(t) ? [t, id || undefined] : ["price", undefined];
}

export function useRoute(): [Tab, string | undefined] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
