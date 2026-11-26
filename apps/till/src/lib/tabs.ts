import { useEffect, useState } from "react";
import { ApiError, OfflineError, request } from "./api.js";
import type { Cart, CartLine } from "./cart.js";
import { t } from "./i18n.js";

/** An open bill on the server, shared by the store's tills. */
export interface RemoteTab {
  id: string;
  tableId: string | null;
  tableName: string | null;
  area: string | null;
  name: string | null;
  guests: number | null;
  cart: Cart;
  total: number;
  version: number;
  status: "open" | "paid" | "cleared";
  openedAt: string;
  updatedAt: string;
  openedBy: string | null;
  updatedBy: string | null;
}

/** Saving lost to another till's change, or the bill is closed; `tab` is how it is now. */
export class TabConflict extends Error {
  constructor(
    message: string,
    readonly code: "changed" | "closed" | "table_busy",
    readonly tab: RemoteTab | null,
  ) {
    super(message);
  }
}

/** The store's open bills, asked for again every 15 seconds while the floor is in use. */
export function useTabs(enabled: boolean, online: boolean) {
  const [tabs, setTabs] = useState<RemoteTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    if (online) {
      request<{ tabs: RemoteTab[] }>("/tabs")
        .then((r) => {
          if (!live) return;
          setTabs(r.tabs);
          setError(null);
        })
        .catch((err) => live && setError(err instanceof OfflineError ? t("Tables need the connection. You can still sell without a table.") : (err as Error).message));
    } else setError(t("Tables need the connection. You can still sell without a table."));
    const timer = setTimeout(() => setTick((n) => n + 1), 15_000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, online, tick]);
  return { tabs, error, reload: () => setTick((n) => n + 1) };
}

/** What the server keeps of a cart: the till's own fields for the tab live on the tab itself. */
function forServer(cart: Cart): Cart {
  const { tabVersion: _v, ...rest } = cart;
  return rest;
}

/** A tab as a cart to sell from, remembering the version it came at. */
export const cartOf = (tab: RemoteTab): Cart => ({
  ...tab.cart,
  tabId: tab.id,
  tableId: tab.tableId,
  tableName: tab.tableName ?? tab.name ?? undefined,
  guests: tab.guests ?? undefined,
  tabVersion: tab.version,
});

export async function saveTab(cart: Cart, total: number, userId: string): Promise<Cart> {
  if (!cart.tabId) throw new Error("Not a tab");
  try {
    const tab = await request<RemoteTab>(`/tabs/${cart.tabId}`, {
      method: "PUT",
      body: {
        tableId: cart.tableId ?? null,
        name: cart.tableId ? null : (cart.tableName ?? null),
        guests: cart.guests ?? null,
        cart: forServer(cart),
        total,
        version: cart.tabVersion ?? 0,
        userId,
      },
    });
    return { ...cart, tabVersion: tab.version, tableName: tab.tableName ?? cart.tableName };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const data = err.data as { error?: "changed" | "closed" | "table_busy"; tab?: RemoteTab } | undefined;
      throw new TabConflict(err.message, data?.error ?? "changed", data?.tab ?? null);
    }
    throw err;
  }
}

export async function closeTab(tabId: string, userId: string, opts: { orderId?: string; reason?: string } = {}) {
  return request<RemoteTab>(`/tabs/${tabId}/close`, { body: { userId, ...opts } });
}

export interface TicketLine {
  lineId: string;
  name: string;
  qty: number;
  modifiers: string[];
  note?: string | null;
}

/** What the kitchen hasn't had yet: new items, more of an item, and items taken off. */
export function kitchenLines(cart: Cart): TicketLine[] {
  const out: TicketLine[] = [];
  for (const l of cart.lines) {
    if (l.giftCardCode) continue;
    const delta = Math.round((l.qty - (l.sentQty ?? 0)) * 1000) / 1000;
    if (delta !== 0) out.push({ lineId: l.id, name: l.name, qty: delta, modifiers: (l.modifiers ?? []).map((m) => m.name), note: l.note ?? null });
  }
  for (const [i, v] of (cart.kitchenVoids ?? []).entries()) out.push({ lineId: `void-${i}`, name: v.name, qty: -Math.abs(v.qty), modifiers: v.modifiers, note: null });
  return out;
}

/** The cart once the kitchen has everything on it. */
export const markSent = (cart: Cart): Cart => ({
  ...cart,
  lines: cart.lines.map((l) => (l.giftCardCode ? l : { ...l, sentQty: l.qty })),
  kitchenVoids: [],
});

/** Taking off a line the kitchen already has: it goes on the next ticket as a cancel. */
export function voidSent(cart: Cart, line: CartLine, qtyLeft: number): Cart {
  const gone = (line.sentQty ?? 0) - Math.max(0, qtyLeft);
  if (gone <= 0) return cart;
  return {
    ...cart,
    kitchenVoids: [...(cart.kitchenVoids ?? []), { name: line.name, qty: gone, modifiers: (line.modifiers ?? []).map((m) => m.name) }],
  };
}

export const tabLabel = (cart: Pick<Cart, "tableName" | "tableId">) =>
  cart.tableId ? t("Table {name}", { name: cart.tableName ?? "" }) : (cart.tableName ?? t("Tab"));
