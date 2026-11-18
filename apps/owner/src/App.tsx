import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon.js";
import { api, getToken, setToken, whenSignedOut } from "./lib/api.js";
import { notify, setBadge } from "./lib/notify.js";
import { useTab, type Tab } from "./lib/router.js";
import type { Me } from "./lib/types.js";
import { Alerts } from "./screens/Alerts.js";
import { Approvals } from "./screens/Approvals.js";
import { Login } from "./screens/Login.js";
import { Reports } from "./screens/Reports.js";
import { Today } from "./screens/Today.js";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "today", label: "Today", icon: "today" },
  { id: "alerts", label: "Alerts", icon: "alert" },
  { id: "approvals", label: "Approvals", icon: "approve" },
  { id: "reports", label: "Reports", icon: "mail" },
];

const TITLES: Record<Tab, string> = { today: "Today", alerts: "Alerts", approvals: "Approvals", reports: "Daily email" };

/** Counts for the tab badges, checked every 20 seconds so a new approval request shows quickly. */
function useCounts(enabled: boolean) {
  const [counts, setCounts] = useState({ approvals: 0, alerts: 0 });
  const seen = useRef<number | null>(null);
  const check = useCallback(async () => {
    try {
      const [a, al] = await Promise.all([
        api<{ approvals: { id: string; summary: string; registerName: string }[] }>("/approvals?status=pending&limit=20"),
        api<{ count: number }>("/alerts"),
      ]);
      const n = a.approvals.length;
      // A new request since the last check: tell the owner even if the app is in the background.
      if (seen.current !== null && n > seen.current && a.approvals[n - 1]) {
        const newest = a.approvals[n - 1]!;
        void notify("Approval needed", `${newest.summary} · ${newest.registerName}`, `approval-${newest.id}`);
      }
      seen.current = n;
      setCounts({ approvals: n, alerts: Math.max(0, al.count - n) });
      setBadge(n);
    } catch {
      // Offline or signed out; the screens say so.
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void check();
    const t = setInterval(check, 20_000);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, check]);
  return { counts, refreshCounts: check };
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(() => Boolean(getToken()));
  const [storeId, setStoreId] = useState("");
  const tab = useTab();
  const mainRef = useRef<HTMLElement>(null);
  const { counts, refreshCounts } = useCounts(Boolean(me));

  useEffect(() => {
    whenSignedOut(() => setMe(null));
    if (!getToken()) return;
    api<Me>("/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    mainRef.current?.focus();
    window.scrollTo(0, 0);
  }, [tab]);

  if (booting) return <div className="login" aria-busy="true" />;
  if (!me) return <Login onSignedIn={setMe} />;

  async function signOut() {
    try {
      await api("/logout", { method: "POST", body: {} });
    } finally {
      setToken(null);
      setBadge(0);
      setMe(null);
    }
  }

  const badge = (id: Tab) => (id === "approvals" ? counts.approvals : id === "alerts" ? counts.alerts : 0);

  return (
    <div className="app">
      <header className="header">
        <h1>
          <span className="header-sub">{me.tenant.name}</span>
          {TITLES[tab]}
        </h1>
        {me.stores.length > 1 && (tab === "today" || tab === "alerts") && (
          <select aria-label="Store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">All stores</option>
            {me.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="icon-btn" onClick={signOut}>
          <Icon name="logout" label={`Sign out ${me.user.name}`} />
        </button>
      </header>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.id} href={`#/${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
            <Icon name={t.icon} />
            {t.label}
            {badge(t.id) > 0 && (
              <span className="tab-badge">
                {badge(t.id)}
                <span className="sr-only"> waiting</span>
              </span>
            )}
          </a>
        ))}
      </nav>
      <main ref={mainRef} tabIndex={-1}>
        {tab === "today" && <Today storeId={storeId} />}
        {tab === "alerts" && <Alerts storeId={storeId} />}
        {tab === "approvals" && <Approvals onChange={refreshCounts} />}
        {tab === "reports" && <Reports me={me} />}
      </main>
    </div>
  );
}
