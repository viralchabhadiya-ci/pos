import type { DeviceSetup, Session, User } from "../lib/db.js";
import { Icon, type IconName } from "./Icon.js";
import { t } from "../lib/i18n.js";
import { syncNow } from "../lib/sync.js";
import { LangSwitch } from "./LangSwitch.js";
import { useSyncStatus } from "../lib/useSync.js";

interface Props {
  setup: DeviceSetup;
  user?: User;
  session?: Session;
  onMenu?: () => void;
}

const ICONS: Record<"online" | "syncing" | "offline", IconName> = { online: "online", syncing: "sync", offline: "offline" };

export function StatusBar({ setup, user, session, onMenu }: Props) {
  const s = useSyncStatus();
  const hubQueued = s.hub && !s.hub.cloudOnline;
  const state = !s.online ? "offline" : s.pending > 0 ? "syncing" : hubQueued ? "offline" : "online";
  const label = !s.online
    ? t("Offline · {n} waiting", { n: s.pending })
    : s.pending > 0
      ? t("Syncing {n}", { n: s.pending })
      : hubQueued
        ? t("Internet down · {n} waiting at hub", { n: s.hub!.pending })
        : s.hub
          ? t("Online · hub")
          : t("Online");
  return (
    <header className="statusbar">
      <div className="where">
        <strong>{setup.store.name}</strong>
        <span className="muted">
          {setup.register.name}
          {session ? ` · ${t("Shift {n}", { n: session.seq })}` : ""}
          {user ? ` · ${user.name}` : ""}
        </span>
      </div>
      <div className="right">
        {s.failed > 0 && (
          <span className="pill critical">
            <Icon name="alert" size={16} />
            {t("{n} rejected", { n: s.failed })}
          </span>
        )}
        {s.hub && s.hub.rejected > 0 && (
          <span className="pill critical">
            <Icon name="alert" size={16} />
            {t("{n} rejected at hub", { n: s.hub.rejected })}
          </span>
        )}
        <button type="button" className={`pill ${state}`} onClick={() => void syncNow()} aria-label={t("{label}. Sync now", { label })}>
          <Icon name={ICONS[state]} size={16} />
          {label}
        </button>
        <LangSwitch />
        {onMenu && (
          <button type="button" className="btn outline" onClick={onMenu}>
            <Icon name="menu" />
            {t("Menu")}
          </button>
        )}
      </div>
    </header>
  );
}
