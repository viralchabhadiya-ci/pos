import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { OfflineError, request } from "../lib/api.js";
import { addItem, emptyCart, setCustomer, type Cart, type SellableItem } from "../lib/cart.js";
import { money } from "../lib/format.js";
import { t } from "../lib/i18n.js";

export interface WebOrder {
  id: string;
  number: string;
  status: "new" | "accepted" | "ready";
  name: string;
  phone: string;
  note: string | null;
  lines: { variantId: string; name: string; qty: number }[];
  total: number;
  pickupCode: string;
  customerId: string | null;
  createdAt: string;
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
    const timer = setTimeout(() => setTick((n) => n + 1), 60_000);
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
    let cart: Cart = { ...emptyCart(), webOrderId: o.id, webOrderNumber: o.number };
    if (o.customerId) {
      // The customer's own prices and points, when the connection allows.
      const c = await request<{ id: string; name: string; phone: string | null; priceListId: string | null; points: number }>(`/customers/${o.customerId}`).catch(
        () => null,
      );
      cart = setCustomer(cart, c ? { id: c.id, name: c.name, phone: c.phone, priceListId: c.priceListId, points: c.points } : { id: o.customerId, name: o.name, phone: o.phone, priceListId: null });
    }
    for (const l of o.lines) cart = addItem(cart, byId.get(l.variantId)!, l.qty);
    setWorking(null);
    onRingUp(cart);
  };

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
            <li key={o.id} className={`web-order ${o.status}`}>
              <div className="web-order-head">
                <strong>{o.number}</strong>
                <span className={`badge ${o.status}`}>{t(STATUS[o.status])}</span>
                <span className="muted">{clock(o.createdAt)}</span>
                <span className="web-order-total">AED {money(o.total)}</span>
              </div>
              <div className="web-order-who">
                {o.name} · <bdi>{o.phone}</bdi> · {t("Code")} <strong className="tnum">{o.pickupCode}</strong>
              </div>
              <div className="muted small">{o.lines.map((l) => `${l.qty} × ${l.name}`).join(", ")}</div>
              {o.note && <div className="web-order-note">“{o.note}”</div>}
              <div className="web-order-actions">
                {o.status !== "ready" && (
                  <button type="button" className="btn outline" disabled={working === o.id} onClick={() => void markReady(o)}>
                    <Icon name="check" size={18} />
                    {t("Packed and ready")}
                  </button>
                )}
                <button type="button" className="btn primary" disabled={working === o.id} onClick={() => void ringUp(o)}>
                  {t("Ring up")}
                </button>
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
