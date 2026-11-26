import { useMemo, useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import type { DiningTable } from "../lib/db.js";
import { money } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import type { RemoteTab } from "../lib/tabs.js";

const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
const since = (iso: string) => {
  const m = minutesSince(iso);
  return m < 60 ? t("{n} min", { n: m }) : t("{h} h {m} min", { h: Math.floor(m / 60), m: m % 60 });
};

/**
 * The floor: every table of the store, free or with its open bill. Tapping a free table asks
 * how many guests; tapping a busy one opens its bill. When moving a bill, only free tables
 * can be picked.
 */
export function FloorDialog({
  tables,
  tabs,
  error,
  currentTabId,
  moving,
  onOpen,
  onMove,
  onClose,
}: {
  tables: DiningTable[];
  tabs: RemoteTab[] | null;
  error: string | null;
  currentTabId: string | null;
  moving: boolean;
  onOpen: (table: DiningTable, tab: RemoteTab | null, guests?: number) => void;
  onMove: (table: DiningTable) => void;
  onClose: () => void;
}) {
  const areas = useMemo(() => [...new Set(tables.map((x) => x.area))].sort((a, b) => a.localeCompare(b)), [tables]);
  const [area, setArea] = useState<string>(areas[0] ?? "");
  const [asking, setAsking] = useState<DiningTable | null>(null);
  const byTable = useMemo(() => new Map((tabs ?? []).filter((x) => x.tableId).map((x) => [x.tableId!, x])), [tabs]);
  const shown = tables.filter((x) => x.area === area).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const busy = (tabs ?? []).filter((x) => x.tableId).length;

  return (
    <Modal onClose={onClose} label={moving ? t("Move to another table") : t("Tables")} wide>
      <div className="floor-head">
        <h2>{moving ? t("Move to another table") : t("Tables")}</h2>
        {tabs && (
          <span className="muted">
            {t("{busy} of {all} tables open", { busy, all: tables.length })}
          </span>
        )}
      </div>
      {areas.length > 1 && (
        <nav className="cats" aria-label={t("Areas")}>
          {areas.map((a) => (
            <button key={a} type="button" className={a === area ? "chip on" : "chip"} aria-pressed={a === area} onClick={() => setArea(a)}>
              {a}
            </button>
          ))}
        </nav>
      )}
      {error ? (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      ) : !tabs ? (
        <p className="muted">{t("Loading…")}</p>
      ) : (
        <div className="floor">
          {shown.map((table) => {
            const tab = byTable.get(table.id);
            const mine = tab && tab.id === currentTabId;
            const disabled = moving && !!tab;
            return (
              <button
                key={table.id}
                type="button"
                className={`table-tile${tab ? " busy" : ""}${mine ? " mine" : ""}`}
                disabled={disabled}
                onClick={() => (moving ? onMove(table) : tab ? onOpen(table, tab) : setAsking(table))}
              >
                <span className="table-name">{table.name}</span>
                {tab ? (
                  <>
                    <span className="table-total tnum">{money(tab.total)}</span>
                    <span className="table-meta">
                      {tab.guests ? `${t("{n} guests", { n: tab.guests })} · ` : ""}
                      {since(tab.openedAt)}
                    </span>
                    {tab.updatedBy && <span className="table-meta">{tab.updatedBy}</span>}
                  </>
                ) : (
                  <span className="table-meta">{t("{n} seats", { n: table.seats })}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {asking && (
        <div className="guests" role="group" aria-label={t("How many guests at table {name}?", { name: asking.name })}>
          <p>
            <strong>{t("How many guests at table {name}?", { name: asking.name })}</strong>
          </p>
          <div className="guest-keys">
            {[1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
              <button key={n} type="button" className="key" onClick={() => onOpen(asking, null, n)}>
                {n}
              </button>
            ))}
            <button type="button" className="key subtle" onClick={() => onOpen(asking, null)}>
              {t("Skip")}
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </Modal>
  );
}
