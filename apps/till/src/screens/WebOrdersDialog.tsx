import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { OfflineError, request } from "../lib/api.js";
import { addItem, emptyCart, setCustomer, updateLine, type Cart, type LineModifier, type SellableItem } from "../lib/cart.js";
import { money } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { beep, clock as countdown } from "./KitchenScreen.js";

export interface WebOrder {
  id: string;
  number: string;
  status: "new" | "accepted" | "ready";
  name: string | null;
  phone: string | null;
  note: string | null;
  /** variantId is null on a delivery platform's item that isn't on our menu. */
  lines: { variantId: string | null; name: string; qty: number; unitPrice?: number; note?: string; modifiers?: LineModifier[] }[];
  total: number;
  pickupCode: string;
  customerId: string | null;
  createdAt: string;
  /** online: click-and-collect; table: from the QR code on a table; kiosk: a self-order kiosk. */
  channel?: "online" | "table" | "kiosk" | "delivery";
  tableId?: string | null;
  tableName?: string | null;
  kioskName?: string | null;
  /** Delivery platforms: "Talabat", the code the rider gives, and when it must be accepted by. */
  platformName?: string | null;
  provider?: string | null;
  externalCode?: string | null;
  acceptBy?: string | null;
  prepMinutes?: number | null;
  acceptedAt?: string | null;
  riderName?: string | null;
  riderAt?: string | null;
}

/** Adds an order's items to a sale, made the way the guest chose. */
export function addWebLines(cart: Cart, o: WebOrder, byId: Map<string, SellableItem>): Cart {
  let next = cart;
  const before = new Set(cart.lines.map((l) => l.id));
  for (const l of o.lines) {
    if (!l.variantId) continue;
    const ids = new Set(next.lines.map((x) => x.id));
    next = addItem(next, byId.get(l.variantId)!, l.qty, undefined, (l.modifiers ?? []).map((m) => ({ groupId: m.groupId, optionId: m.optionId, name: m.name, price: m.price })));
    // A delivery platform's item keeps the price its customer paid, and its own note.
    const added = next.lines.find((x) => !ids.has(x.id));
    if (o.channel === "delivery" && added) next = updateLine(next, added.id, { unitPrice: l.unitPrice ?? added.unitPrice, ...(l.note ? { note: l.note } : {}) });
  }
  // The guest's note rides on the order's first item, so the kitchen ticket carries it.
  const first = next.lines.find((l) => !before.has(l.id));
  if (o.note && first) next = updateLine(next, first.id, { note: first.note ? `${first.note}; ${o.note}` : o.note });
  return next;
}

const STATUS: Record<WebOrder["status"], string> = { new: "New", accepted: "Being packed", ready: "Ready" };
const DELIVERY_STATUS: Record<WebOrder["status"], string> = { new: "New", accepted: "Being made", ready: "Waiting for rider" };
const clock = (iso: string) => new Intl.DateTimeFormat("en-AE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** Open orders from the online shop for this store, with the count of new ones for the button. */
export function useWebOrders(online: boolean) {
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [offset, setOffset] = useState(0);
  const [delivery, setDelivery] = useState(false);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!online) return;
    let live = true;
    request<{ orders: WebOrder[]; serverTime?: string; delivery?: boolean }>("/web-orders")
      .then((r) => {
        if (!live) return;
        // A platform's order waits only minutes for an answer, so a new one beeps.
        if (known.current && r.orders.some((o) => o.channel === "delivery" && o.status === "new" && !known.current!.has(o.id))) beep();
        known.current = new Set(r.orders.map((o) => o.id));
        if (r.serverTime) setOffset(Date.parse(r.serverTime) - Date.now());
        setDelivery(!!r.delivery);
        setOrders(r.orders);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof OfflineError ? t("Online orders need the connection.") : (err as Error).message));
    // Guests ordering at a table or a kiosk are waiting, so this is asked often.
    const timer = setTimeout(() => setTick((n) => n + 1), 20_000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [online, tick]);
  return { orders, error, offset, delivery, reload: () => setTick((n) => n + 1) };
}

/**
 * Online orders waiting at this store. The cashier marks one ready when it is packed (the
 * customer gets a message), then rings it up when they come, which hands it over.
 */
export function WebOrdersDialog({
  orders,
  error,
  reload,
  items,
  userId,
  busy,
  onRingUp,
  onToTable,
  onClose,
  offset = 0,
}: {
  /** Server time minus this till's clock, for the time left to accept a delivery order. */
  offset?: number;
  orders: WebOrder[] | null;
  error: string | null;
  reload: () => void;
  items: SellableItem[];
  userId: string;
  /** The current sale has items, so ringing up would replace them. */
  busy: boolean;
  onRingUp: (cart: Cart) => void;
  /** A guest's order from their table's QR code: goes on that table's bill. */
  onToTable: (o: WebOrder) => Promise<void>;
  onClose: () => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [turningDown, setTurningDown] = useState<WebOrder | null>(null);
  const [prep, setPrep] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /** Accept, turn down or Ready on a delivery order: the platform hears about it. */
  const platformStep = (o: WebOrder, step: "accept" | "reject" | "ready", body: Record<string, unknown> = {}) =>
    void run(o, async () => {
      const r = await request<{ platform: "sent" | "simulated" | "failed" | null }>(`/delivery-orders/${o.id}/${step}`, { body: { userId, ...body } });
      setNotice(r.platform === "failed" ? t("Saved here, but {platform} could not be reached. Tell them on their tablet or by phone.", { platform: o.platformName ?? "" }) : null);
    });

  const markReady = async (o: WebOrder) => {
    setWorking(o.id);
    setProblem(null);
    try {
      await request(`/web-orders/${o.id}/ready`, { body: { userId } });
      reload();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const ringUp = async (o: WebOrder) => {
    if (busy) return setProblem(t("Finish or park the current sale first."));
    const byId = new Map(items.map((i) => [i.variantId, i]));
    const missing = o.lines.filter((l) => !l.variantId || !byId.has(l.variantId)).map((l) => l.name);
    if (missing.length) return setProblem(t("Not on this till: {names}", { names: missing.join(", ") }));
    setWorking(o.id);
    setProblem(null);
    let cart: Cart = {
      ...emptyCart(),
      webOrderId: o.id,
      webOrderNumber: o.number,
      ...(o.channel === "kiosk" ? { kioskNumber: Number(o.pickupCode) } : {}),
      ...(o.channel === "delivery" ? { delivery: { name: o.platformName ?? t("Delivery"), code: o.externalCode ?? o.number } } : {}),
    };
    if (o.customerId) {
      // The customer's own prices and points, when the connection allows.
      const c = await request<{ id: string; name: string; phone: string | null; priceListId: string | null; points: number }>(`/customers/${o.customerId}`).catch(
        () => null,
      );
      cart = setCustomer(cart, c ? { id: c.id, name: c.name, phone: c.phone, priceListId: c.priceListId, points: c.points } : { id: o.customerId, name: o.name ?? "", phone: o.phone, priceListId: null });
    }
    cart = addWebLines(cart, o, byId);
    setWorking(null);
    onRingUp(cart);
  };

  const run = async (o: WebOrder, fn: () => Promise<unknown>) => {
    setWorking(o.id);
    setProblem(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setWorking(null);
    }
  };
  const toTable = (o: WebOrder) => {
    const missing = o.lines.filter((l) => !l.variantId || !items.some((i) => i.variantId === l.variantId)).map((l) => l.name);
    if (missing.length) return setProblem(t("Not on this till: {names}", { names: missing.join(", ") }));
    void run(o, () => onToTable(o));
  };
  const reject = (o: WebOrder) => void run(o, () => request(`/web-orders/${o.id}/cancel`, { body: { userId, reason: "Please order with the staff" } }));

  return (
    <Modal onClose={onClose} label={t("Online orders")} wide>
      <h2>{t("Online orders")}</h2>
      <DeliveryBar userId={userId} items={items} />
      {error ? (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      ) : !orders ? (
        <p className="muted">{t("Loading…")}</p>
      ) : orders.length === 0 ? (
        <p className="muted">{t("No online orders waiting.")}</p>
      ) : (
        <ul className="web-orders">
          {orders.map((o) => (
            <li key={o.id} className={`web-order ${o.status}${o.channel && o.channel !== "online" ? ` ${o.channel}` : ""}`}>
              <div className="web-order-head">
                <strong>
                  {o.channel === "delivery"
                    ? `${o.platformName ?? ""} ${o.externalCode ?? ""}`
                    : o.channel === "table"
                    ? t("Table {name}", { name: o.tableName ?? "" })
                    : o.channel === "kiosk"
                      ? t("Kiosk number {n}", { n: Number(o.pickupCode) })
                      : o.number}
                </strong>
                <span className={`badge ${o.status}`}>
                  {o.channel === "delivery"
                    ? t(DELIVERY_STATUS[o.status])
                    : o.channel === "table"
                      ? t("From the table QR")
                      : o.channel === "kiosk"
                        ? t("To pay")
                        : t(STATUS[o.status])}
                </span>
                {o.channel === "delivery" && o.status === "new" && o.acceptBy && (
                  <span className="web-order-due tnum" role="timer">
                    {(() => {
                      const left = (Date.parse(o.acceptBy) - now - offset) / 1000;
                      return left > 0 ? t("Accept within {time}", { time: countdown(left) }) : t("Time to accept is up");
                    })()}
                  </span>
                )}
                <span className="muted">{clock(o.createdAt)}</span>
                <span className="web-order-total">AED {money(o.total)}</span>
              </div>
              {(!o.channel || o.channel === "online") && (
                <div className="web-order-who">
                  {o.name} · <bdi>{o.phone}</bdi> · {t("Code")} <strong className="tnum">{o.pickupCode}</strong>
                </div>
              )}
              {o.channel !== "online" && o.name && <div className="web-order-who">{o.name}</div>}
              {o.channel === "delivery" && o.riderName && (
                <div className="web-order-who">
                  <Icon name="bike" size={16} /> {o.riderName}
                  {o.riderAt ? ` · ${t("arrives {time}", { time: clock(o.riderAt) })}` : ""}
                </div>
              )}
              {o.channel === "delivery" && o.lines.some((l) => !l.variantId) && (
                <p className="web-order-warn">
                  <Icon name="alert" size={16} />
                  {t("Not on this menu: {names}. Ring these up by hand.", { names: o.lines.filter((l) => !l.variantId).map((l) => l.name).join(", ") })}
                </p>
              )}
              <ul className="web-order-lines">
                {o.lines.map((l, i) => (
                  <li key={i}>
                    {l.qty} × {l.name}
                    {l.modifiers?.length ? <span className="muted"> · {l.modifiers.map((m) => m.name).join(", ")}</span> : null}
                    {l.note ? <span className="muted"> · “{l.note}”</span> : null}
                  </li>
                ))}
              </ul>
              {o.note && <div className="web-order-note">“{o.note}”</div>}
              <div className="web-order-actions">
                {o.channel === "delivery" ? (
                  o.status === "new" ? (
                    <>
                      <button type="button" className="btn ghost" disabled={working === o.id} onClick={() => setTurningDown(o)}>
                        {t("Turn down")}
                      </button>
                      <label className="prep-pick">
                        <span>{t("Ready in")}</span>
                        <select value={prep[o.id] ?? o.prepMinutes ?? 20} onChange={(e) => setPrep({ ...prep, [o.id]: Number(e.target.value) })}>
                          {[10, 15, 20, 25, 30, 45, 60].map((m) => (
                            <option key={m} value={m}>
                              {t("{n} min", { n: m })}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="btn primary" disabled={working === o.id} onClick={() => platformStep(o, "accept", prep[o.id] ? { prepMinutes: prep[o.id] } : {})}>
                        <Icon name="check" size={18} />
                        {t("Accept")}
                      </button>
                    </>
                  ) : (
                    <>
                      {o.status === "accepted" && (
                        <button type="button" className="btn outline" disabled={working === o.id} onClick={() => platformStep(o, "ready")}>
                          <Icon name="check" size={18} />
                          {t("Packed and ready")}
                        </button>
                      )}
                      <button type="button" className="btn primary" disabled={working === o.id} onClick={() => void ringUp(o)}>
                        <Icon name="bike" size={18} />
                        {t("Rider collected")}
                      </button>
                    </>
                  )
                ) : o.channel === "table" ? (
                  <>
                    <button type="button" className="btn ghost" disabled={working === o.id} onClick={() => reject(o)}>
                      {t("Don't take")}
                    </button>
                    <button type="button" className="btn primary" disabled={working === o.id} onClick={() => toTable(o)}>
                      <Icon name="table" size={18} />
                      {t("Add to the bill")}
                    </button>
                  </>
                ) : (
                  <>
                    {o.channel !== "kiosk" && o.status !== "ready" && (
                      <button type="button" className="btn outline" disabled={working === o.id} onClick={() => void markReady(o)}>
                        <Icon name="check" size={18} />
                        {t("Packed and ready")}
                      </button>
                    )}
                    <button type="button" className="btn primary" disabled={working === o.id} onClick={() => void ringUp(o)}>
                      {o.channel === "kiosk" ? t("Take payment") : t("Ring up")}
                    </button>
                  </>
                )}
              </div>
              {turningDown?.id === o.id && (
                <div className="turn-down" role="group" aria-label={t("Why turn it down?")}>
                  <strong>{t("Why turn down {order}?", { order: `${turningDown.platformName ?? ""} ${turningDown.externalCode ?? ""}` })}</strong>
                  <div className="turn-down-reasons">
                    {["Too busy", "An item is sold out", "Closing soon"].map((r) => (
                      <button
                        key={r}
                        type="button"
                        className="btn outline"
                        onClick={() => {
                          const o = turningDown;
                          setTurningDown(null);
                          platformStep(o, "reject", { reason: r });
                        }}
                      >
                        {t(r)}
                      </button>
                    ))}
                    <button type="button" className="btn ghost" onClick={() => setTurningDown(null)}>
                      {t("Keep it")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p className="error" role="status">
          <Icon name="alert" size={18} />
          {notice}
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {problem}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </Modal>
  );
}

interface DeliveryStatus {
  channels: { id: string; name: string; provider: string; pausedUntil: string | null }[];
  soldOut: { variantId: string; name: string; until: string | null }[];
}

/**
 * The store's delivery platforms: Busy stops new orders for a while, and items can be marked
 * sold out so customers can't order them. Shown only when the store is on a platform.
 */
export function DeliveryBar({ userId, items }: { userId: string; items: SellableItem[] }) {
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"busy" | "soldOut" | null>(null);
  const [search, setSearch] = useState("");
  const [working, setWorking] = useState(false);

  const load = () =>
    request<DeliveryStatus>("/delivery")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err) => setError(err instanceof OfflineError ? null : (err as Error).message));
  useEffect(() => {
    void load();
  }, []);

  const act = async (path: string, body: Record<string, unknown>) => {
    setWorking(true);
    try {
      const r = await request<{ failed: number }>(path, { body: { userId, ...body } });
      if (r.failed) setError(t("Saved here, but a platform could not be reached. Check it on their tablet."));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (!status?.channels.length) return null;
  const paused = status.channels.map((c) => c.pausedUntil).filter((x): x is string => !!x).sort()[0];
  const out = new Set(status.soldOut.map((s) => s.variantId));
  const q = search.trim().toLowerCase();
  const matches = q ? items.filter((i) => i.name.toLowerCase().includes(q) && !out.has(i.variantId)).slice(0, 6) : [];

  return (
    <div className="delivery-bar">
      <div className="delivery-bar-row">
        <Icon name="bike" size={18} />
        <span>
          {status.channels.map((c) => c.name).join(", ")}
          {" · "}
          <strong className={paused ? "delivery-busy" : "delivery-open"}>{paused ? t("Busy until {time}", { time: clock(paused) }) : t("Taking orders")}</strong>
        </span>
        <span className="delivery-bar-tools">
          {paused ? (
            <button type="button" className="btn outline" disabled={working} onClick={() => void act("/delivery/busy", { minutes: null })}>
              {t("Take orders again")}
            </button>
          ) : (
            <button type="button" className={panel === "busy" ? "btn outline on" : "btn outline"} aria-expanded={panel === "busy"} onClick={() => setPanel(panel === "busy" ? null : "busy")}>
              <Icon name="pause" size={16} />
              {t("Busy")}
            </button>
          )}
          <button type="button" className={panel === "soldOut" ? "btn outline on" : "btn outline"} aria-expanded={panel === "soldOut"} onClick={() => setPanel(panel === "soldOut" ? null : "soldOut")}>
            {t("Sold out")} {status.soldOut.length > 0 && <span className="count">{status.soldOut.length}</span>}
          </button>
        </span>
      </div>
      {panel === "busy" && !paused && (
        <div className="delivery-panel">
          <span>{t("Stop new delivery orders for")}</span>
          {[15, 30, 60].map((m) => (
            <button
              key={m}
              type="button"
              className="btn outline"
              disabled={working}
              onClick={() => {
                setPanel(null);
                void act("/delivery/busy", { minutes: m });
              }}
            >
              {t("{n} min", { n: m })}
            </button>
          ))}
        </div>
      )}
      {panel === "soldOut" && (
        <div className="delivery-panel column">
          {status.soldOut.length > 0 && (
            <ul className="sold-out-list">
              {status.soldOut.map((s) => (
                <li key={s.variantId}>
                  <span>
                    {s.name}
                    <span className="muted"> · {s.until ? t("until {time}", { time: clock(s.until) }) : t("until turned back on")}</span>
                  </span>
                  <button type="button" className="btn ghost" disabled={working} onClick={() => void act("/delivery/sold-out", { variantIds: [s.variantId], soldOut: false })}>
                    {t("Back on")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input type="search" placeholder={t("Find an item to mark sold out")} aria-label={t("Find an item to mark sold out")} value={search} onChange={(e) => setSearch(e.target.value)} />
          {matches.length > 0 && (
            <ul className="sold-out-list">
              {matches.map((i) => (
                <li key={i.variantId}>
                  <span>{i.name}</span>
                  <span className="sold-out-for">
                    {[
                      { label: t("1 hour"), minutes: 60 },
                      { label: t("Until turned back on"), minutes: null },
                    ].map((d) => (
                      <button
                        key={d.label}
                        type="button"
                        className="btn outline"
                        disabled={working}
                        onClick={() => {
                          setSearch("");
                          void act("/delivery/sold-out", { variantIds: [i.variantId], soldOut: true, minutes: d.minutes });
                        }}
                      >
                        {d.label}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      )}
    </div>
  );
}
