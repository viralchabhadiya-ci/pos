import type { DeviceSetup, Session, User } from "../lib/db.js";
import { Icon, type IconName } from "./Icon.js";
import { syncNow } from "../lib/sync.js";
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
    ? `Offline · ${s.pending} waiting`
    : s.pending > 0
      ? `Syncing ${s.pending}`
      : hubQueued
        ? `Internet down · ${s.hub!.pending} waiting at hub`
        : s.hub
          ? "Online · hub"
          : "Online";
  return (
    <header className="statusbar">
      <div className="where">
        <strong>{setup.store.name}</strong>
        <span className="muted">
          {setup.register.name}
          {session ? ` · Shift ${session.seq}` : ""}
          {user ? ` · ${user.name}` : ""}
        </span>
      </div>
      <div className="right">
        {s.failed > 0 && (
          <span className="pill critical">
            <Icon name="alert" size={16} />
            {s.failed} rejected
          </span>
        )}
        {s.hub && s.hub.rejected > 0 && (
          <span className="pill critical">
            <Icon name="alert" size={16} />
            {s.hub.rejected} rejected at hub
          </span>
        )}
        <button type="button" className={`pill ${state}`} onClick={() => void syncNow()} aria-label={`${label}. Sync now`}>
          <Icon name={ICONS[state]} size={16} />
          {label}
        </button>
        {onMenu && (
          <button type="button" className="btn outline" onClick={onMenu}>
            <Icon name="menu" />
            Menu
          </button>
        )}
      </div>
    </header>
  );
}
