import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon.js";
import { LangSwitch } from "../components/LangSwitch.js";
import { OfflineError, request } from "../lib/api.js";
import type { DeviceSetup } from "../lib/db.js";
import { t, useLang } from "../lib/i18n.js";

export interface KitchenTicket {
  id: string;
  tabId: string | null;
  label: string;
  guests: number | null;
  lines: { lineId: string; name: string; qty: number; modifiers: string[]; note?: string | null }[];
  doneLines: string[];
  status: "new" | "preparing" | "ready" | "done";
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  doneAt: string | null;
  createdBy: string | null;
  registerName: string | null;
  /** The delivery platform cancelled the order after the kitchen got it. */
  cancelledAt?: string | null;
}

/** Minutes after which a ticket turns amber, then red. */
export const LATE = { warn: 10, late: 20 };
const POLL_MS = 4000;

export const ageClass = (seconds: number) => (seconds >= LATE.late * 60 ? "late" : seconds >= LATE.warn * 60 ? "warn" : "");
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A short high beep for a new ticket; browsers may block sound until the screen is touched once. */
export function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    // No sound is fine.
  }
}

/**
 * The kitchen display: tickets from the tills in the order they came, oldest first. Cooks tick
 * items off, then bump a ticket to Ready (waiters see it on the floor) and Picked up.
 */
export function KitchenScreen({ setup }: { setup: DeviceSetup }) {
  useLang();
  const [tickets, setTickets] = useState<KitchenTicket[] | null>(null);
  const [recent, setRecent] = useState<KitchenTicket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRecall, setShowRecall] = useState(false);
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0);
  const known = useRef<Set<string> | null>(null);
  // Changes made here wait for the server; a poll in between must not undo them on screen.
  const pending = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await request<{ tickets: KitchenTicket[]; recent: KitchenTicket[]; serverTime: string }>("/kitchen/tickets");
      offset.current = Date.parse(r.serverTime) - Date.now();
      if (pending.current) return;
      const ids = new Set(r.tickets.map((x) => x.id));
      if (known.current && r.tickets.some((x) => !known.current!.has(x.id) && x.status === "new")) beep();
      known.current = ids;
      setTickets(r.tickets);
      setRecent(r.recent);
      setError(null);
    } catch (err) {
      setError(err instanceof OfflineError ? t("No connection. New tickets show when it is back.") : (err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const change = async (ticket: KitchenTicket, path: string, body: unknown, optimistic: (k: KitchenTicket) => KitchenTicket | null) => {
    pending.current++;
    setTickets((xs) => (xs ?? []).map((x) => (x.id === ticket.id ? optimistic(x) : x)).filter((x): x is KitchenTicket => !!x));
    try {
      const updated = await request<KitchenTicket>(`/kitchen/tickets/${ticket.id}${path}`, { body });
      setTickets((xs) => {
        const rest = (xs ?? []).filter((x) => x.id !== updated.id);
        return updated.status === "done" ? rest : [...rest, updated].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      if (updated.status === "done") setRecent((xs) => [updated, ...xs.filter((x) => x.id !== updated.id)].slice(0, 20));
      else setRecent((xs) => xs.filter((x) => x.id !== updated.id));
    } catch (err) {
      setError(err instanceof OfflineError ? t("No connection. That change was not saved; try again.") : (err as Error).message);
    } finally {
      pending.current--;
      void load();
    }
  };

  const toggleLine = (k: KitchenTicket, lineId: string) => {
    const done = !k.doneLines.includes(lineId);
    void change(k, "/lines", { lineId, done }, (x) => ({
      ...x,
      doneLines: done ? [...x.doneLines, lineId] : x.doneLines.filter((l) => l !== lineId),
      status: x.status === "new" && done ? "preparing" : x.status,
    }));
  };
  const bump = (k: KitchenTicket, status: KitchenTicket["status"]) =>
    void change(k, "/status", { status }, (x) => (status === "done" ? null : { ...x, status, doneLines: status === "ready" ? x.lines.map((l) => l.lineId) : x.doneLines }));

  const serverNow = now + offset.current;
  const list = tickets ?? [];
  const toMake = list.filter((k) => k.status !== "ready").length;
  const ready = list.length - toMake;

  return (
    <div className="kds">
      <header className="kds-head">
        <div>
          <strong>{t("Kitchen")}</strong>
          <span className="muted">{setup.store.name}</span>
        </div>
        <div className="kds-counts" aria-live="polite">
          <span>{t("{n} to make", { n: toMake })}</span>
          <span className="kds-ready-count">{t("{n} ready", { n: ready })}</span>
        </div>
        <div className="kds-tools">
          <button type="button" className={showRecall ? "btn outline on" : "btn outline"} aria-pressed={showRecall} onClick={() => setShowRecall((x) => !x)} disabled={!recent.length && !showRecall}>
            <Icon name="undo" size={18} />
            {t("Recall")}
          </button>
          <LangSwitch />
        </div>
      </header>
      {error && (
        <p className="kds-error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      )}
      {showRecall ? (
        <section className="kds-recall" aria-label={t("Picked up in the last hour")}>
          <h2>{t("Picked up in the last hour")}</h2>
          {recent.length ? (
            <ul>
              {recent.map((k) => (
                <li key={k.id}>
                  <span>
                    <strong>{k.label}</strong> · {k.lines.filter((l) => l.qty > 0).map((l) => `${l.qty} × ${l.name}`).join(", ")}
                  </span>
                  <button
                    type="button"
                    className="btn outline"
                    onClick={() => {
                      setRecent((xs) => xs.filter((x) => x.id !== k.id));
                      setTickets((xs) => [...(xs ?? []), { ...k, status: "ready" as const }].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
                      void change(k, "/status", { status: "ready" }, (x) => x);
                      setShowRecall(false);
                    }}
                  >
                    {t("Back on screen")}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t("Nothing yet.")}</p>
          )}
        </section>
      ) : !tickets ? (
        <p className="kds-empty muted">{t("Loading…")}</p>
      ) : !list.length ? (
        <div className="kds-empty">
          <Icon name="chef" size={48} />
          <p>{t("No tickets. New orders from the tills show here.")}</p>
        </div>
      ) : (
        <ol className="kds-grid">
          {list.map((k) => {
            const age = (serverNow - Date.parse(k.createdAt)) / 1000;
            const isReady = k.status === "ready";
            return (
              <li key={k.id} className={`kds-ticket ${k.status} ${isReady || k.cancelledAt ? "" : ageClass(age)}${k.cancelledAt ? " cancelled" : ""}`}>
                <div className="kds-top">
                  <span className="kds-label">{k.label}</span>
                  <span className="kds-age tnum" aria-label={t("Waiting {time}", { time: clock(age) })}>
                    {isReady ? t("Ready") : clock(age)}
                  </span>
                </div>
                {k.cancelledAt && (
                  <p className="kds-cancelled" role="status">
                    <Icon name="alert" size={18} />
                    {t("Cancelled by the platform. Don't make it.")}
                  </p>
                )}
                <div className="kds-meta muted">
                  {[k.guests ? t("{n} guests", { n: k.guests }) : null, k.createdBy, k.status === "new" ? t("New") : null].filter(Boolean).join(" · ")}
                </div>
                <ul className="kds-lines">
                  {k.lines.map((l) => {
                    const done = k.doneLines.includes(l.lineId);
                    const cancel = l.qty < 0;
                    return (
                      <li key={l.lineId}>
                        <button type="button" className={`kds-line${done ? " done" : ""}${cancel ? " cancel" : ""}`} aria-pressed={done} onClick={() => toggleLine(k, l.lineId)}>
                          <span className="kds-qty tnum">{cancel ? `−${Math.abs(l.qty)}` : l.qty}</span>
                          <span className="kds-item">
                            {cancel && <span className="kds-cancel">{t("Cancel")}</span>}
                            {l.name}
                            {l.modifiers.length > 0 && <small>{l.modifiers.join(" · ")}</small>}
                            {l.note && <small className="kds-note">“{l.note}”</small>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {k.cancelledAt ? (
                  <div className="kds-actions">
                    <button type="button" className="btn primary" onClick={() => bump(k, "done")}>
                      <Icon name="close" size={18} />
                      {t("Clear")}
                    </button>
                  </div>
                ) : isReady ? (
                  <div className="kds-actions">
                    <button type="button" className="btn ghost" onClick={() => bump(k, "preparing")}>
                      {t("Not ready")}
                    </button>
                    <button type="button" className="btn primary" onClick={() => bump(k, "done")}>
                      <Icon name="check" size={18} />
                      {t("Picked up")}
                    </button>
                  </div>
                ) : (
                  <div className="kds-actions">
                    <button type="button" className="btn primary" onClick={() => bump(k, "ready")}>
                      <Icon name="check" size={18} />
                      {t("Ready")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
