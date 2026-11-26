import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon.js";
import { api, getDeviceToken, getSession, setSession, whenSignedOut } from "./lib/api.js";
import { useRoute, type Tab } from "./lib/router.js";
import type { DeviceSetup, StaffUser } from "./lib/types.js";
import { Counts } from "./screens/Counts.js";
import { Deliveries } from "./screens/Deliveries.js";
import { Labels } from "./screens/Labels.js";
import { Pair } from "./screens/Pair.js";
import { Pin } from "./screens/Pin.js";
import { PriceCheck } from "./screens/PriceCheck.js";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "price", label: "Price check", icon: "search" },
  { id: "count", label: "Count", icon: "count" },
  { id: "receive", label: "Deliveries", icon: "truck" },
  { id: "labels", label: "Labels", icon: "tag" },
];

const USER_KEY = "staff.user";
const loadUser = (): StaffUser | null => {
  try {
    return getSession() ? (JSON.parse(sessionStorage.getItem(USER_KEY) ?? "null") as StaffUser | null) : null;
  } catch {
    return null;
  }
};

export function App() {
  const [paired, setPaired] = useState(() => !!getDeviceToken());
  const [setup, setSetup] = useState<DeviceSetup | null>(null);
  const [user, setUser] = useState<StaffUser | null>(loadUser);
  const [tab, id] = useRoute();
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    whenSignedOut((unpaired) => {
      if (unpaired) setPaired(false);
      setUser(null);
    });
  }, []);
  useEffect(() => {
    if (paired) api<DeviceSetup>("/staff/device").then(setSetup).catch(() => {});
  }, [paired]);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [tab, id]);

  const signIn = useCallback((u: StaffUser) => {
    try {
      sessionStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch {
      // Kept in memory only.
    }
    setUser(u);
  }, []);
  const signOut = async () => {
    await api("/staff/logout", { body: {} }).catch(() => {});
    setSession(null);
    setUser(null);
  };

  if (!paired) return <Pair onPaired={() => setPaired(true)} />;
  if (!user) return <Pin setup={setup} onSignedIn={signIn} />;

  return (
    <div className="app">
      <header className="header">
        <h1>
          {TABS.find((t) => t.id === tab)!.label}
          <span className="header-sub">
            {user.name}
            {setup ? ` · ${setup.store.name}` : ""}
          </span>
        </h1>
        <button type="button" className="icon-btn" onClick={signOut} aria-label="Sign out">
          <Icon name="logout" />
        </button>
      </header>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.id} href={`#/${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
            <Icon name={t.icon} />
            {t.label}
          </a>
        ))}
      </nav>
      <main ref={main} tabIndex={-1}>
        {tab === "price" && <PriceCheck />}
        {tab === "count" && <Counts id={id} />}
        {tab === "receive" && <Deliveries id={id} user={user} />}
        {tab === "labels" && <Labels />}
      </main>
    </div>
  );
}
