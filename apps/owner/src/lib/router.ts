import { useEffect, useState } from "react";

export type Tab = "today" | "alerts" | "approvals" | "reports";
const TABS: Tab[] = ["today", "alerts", "approvals", "reports"];

export function parseHash(hash: string): Tab {
  const t = hash.replace(/^#\/?/, "").split("/")[0] as Tab;
  return TABS.includes(t) ? t : "today";
}

export function useTab(): Tab {
  const [tab, setTab] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setTab(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return tab;
}
