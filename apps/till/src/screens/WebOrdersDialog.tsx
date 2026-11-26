import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { OfflineError, request } from "../lib/api.js";
import { addItem, emptyCart, setCustomer, updateLine, type Cart, type LineModifier, type SellableItem } from "../lib/cart.js";
import { money } from "../lib/format.js";
import { t } from "../lib/i18n.js";

export interface WebOrder {
  id: string;
  number: string;
  status: "new" | "accepted" | "ready";
  name: string | null;
  phone: string | null;
  note: string | null;
  lines: { variantId: string; name: string; qty: number; modifiers?: LineModifier[] }[];
  total: number;
  pickupCode: string;
  customerId: string | null;
  createdAt: string;
  /** online: click-and-collect; table: from the QR code on a table; kiosk: a self-order kiosk. */
  channel?: "online" | "table" | "kiosk";
  tableId?: string | null;
  tableName?: string | null;
  kioskName?: string | null;
}

/** Adds an order's items to a sale, made the way the guest chose. */
export function addWebLines(cart: Cart, o: WebOrder, byId: Map<string, SellableItem>): Cart {
  let next = cart;
  const before = new Set(cart.lines.map((l) => l.id));
  for (const l of o.lines) next = addItem(next, byId.get(l.variantId)!, l.qty, undefined, (l.modifiers ?? []).map((m) => ({ groupId: m.groupId, optionId: m.optionId, name: m.name, price: m.price })));
  // The guest's note rides on the order's first item, so the kitchen ticket carries it.
  const first = next.lines.find((l) => !before.has(l.id));
  if (o.note && first) next = updateLine(next, first.id, { note: first.note ? `${first.note}; ${o.note}` : o.note });
  return next;
}

const STATUS: Record<WebOrder["status"], string> = { new: "New", accepted: "Being packed", ready: "Ready" };
const clock = (iso: string) => new Intl.DateTimeFormat("en-AE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** Open orders from the online shop for this store, with the count of new ones for the button. */
export function useWebOrders(online: boolean) {
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!online) return;
    let live = true;
    request<{ orders: WebOrder[] }>("/web-orders")
      .then((r) => {
        if (!live) return;
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
  return { orders, error, reload: () => setTick((n) => n + 1) };
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
}: {
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
    const missing = o.lines.filter((l) => !byId.has(l.variantId)).map((l) => l.name);
    if (missing.length) return setProblem(t("Not on this till: {names}", { names: missing.join(", ") }));
    setWorking(o.id);
    setProblem(null);
    let cart: Cart = { ...emptyCart(), webOrderId: o.id, webOrderNumber: o.number, ...(o.channel === "kiosk" ? { kioskNumber: Number(o.pickupCode) } : {}) };
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
    const missing = o.lines.filter((l) => !items.some((i) => i.variantId === l.variantId)).map((l) => l.name);
    if (missing.length) return setProblem(t("Not on this till: {names}", { names: missing.join(", ") }));
    void run(o, () => onToTable(o));
  };
  const reject = (o: WebOrder) => void run(o, () => request(`/web-orders/${o.id}/cancel`, { body: { userId, reason: "Please order with the staff" } }));

  return (
    <Modal onClose={onClose} label={t("Online orders")} wide>
      <h2>{t("Online orders")}</h2>
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
                  {o.channel === "table"
                    ? t("Table {name}", { name: o.tableName ?? "" })
                    : o.channel === "kiosk"
                      ? t("Kiosk number {n}", { n: Number(o.pickupCode) })
                      : o.number}
                </strong>
                <span className={`badge ${o.status}`}>
                  {o.channel === "table" ? t("From the table QR") : o.channel === "kiosk" ? t("To pay") : t(STATUS[o.status])}
                </span>
                <span className="muted">{clock(o.createdAt)}</span>
                <span className="web-order-total">AED {money(o.total)}</span>
              </div>
              {(!o.channel || o.channel === "online") && (
                <div className="web-order-who">
                  {o.name} · <bdi>{o.phone}</bdi> · {t("Code")} <strong className="tnum">{o.pickupCode}</strong>
                </div>
              )}
              {o.channel !== "online" && o.name && <div className="web-order-who">{o.name}</div>}
              <ul className="web-order-lines">
                {o.lines.map((l, i) => (
                  <li key={i}>
                    {l.qty} × {l.name}
                    {l.modifiers?.length ? <span className="muted"> · {l.modifiers.map((m) => m.name).join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
              {o.note && <div className="web-order-note">“{o.note}”</div>}
              <div className="web-order-actions">
                {o.channel === "table" ? (
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
            </li>
          ))}
        </ul>
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
