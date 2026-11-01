import { liveQuery } from "dexie";
import { request, ApiError, OfflineError } from "./api.js";
import { db, type OutboxItem } from "./db.js";

/** What the store hub reports when the till is connected through one. */
export interface HubInfo {
  cloudOnline: boolean;
  pending: number;
  rejected: number;
  printer: { width: number } | null;
}

export interface SyncStatus {
  online: boolean;
  /** Null when the till talks to the cloud directly. */
  hub: HubInfo | null;
  pending: number;
  failed: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

let status: SyncStatus = { online: navigator.onLine, hub: null, pending: 0, failed: 0, lastSyncAt: null, lastError: null };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

export const syncStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => status,
};

const CATALOG_OVERLAP_MS = 5_000;

/** Pulls catalog changes. A small overlap guards against rows written while the last pull ran. */
export async function pullCatalog() {
  const since = await db.getMeta<string>("catalogSince");
  const query = since ? `?since=${encodeURIComponent(new Date(Date.parse(since) - CATALOG_OVERLAP_MS).toISOString())}` : "";
  const data = await request<{
    serverTime: string;
    taxes: never[];
    categories: never[];
    products: never[];
    variants: never[];
    paymentMethods: never[];
    users: never[];
  }>(`/sync/catalog${query}`);
  await db.transaction("rw", [db.taxes, db.categories, db.products, db.variants, db.paymentMethods, db.users, db.meta], async () => {
    await db.taxes.bulkPut(data.taxes);
    await db.categories.bulkPut(data.categories);
    await db.products.bulkPut(data.products);
    await db.variants.bulkPut(data.variants);
    await db.paymentMethods.bulkPut(data.paymentMethods);
    await db.users.bulkPut(data.users);
    await db.setMeta("catalogSince", data.serverTime);
  });
}

async function markOrder(id: string, syncStatus: "synced" | "rejected", syncError?: string) {
  await db.orders.update(id, { syncStatus, syncError });
}

/**
 * Sends queued work in order. Orders go in batches; a rejected order is marked and
 * removed from the queue so it never blocks later sales. A network error stops the pass
 * and leaves everything queued for the next one.
 */
export async function pushOutbox(): Promise<void> {
  for (;;) {
    const head = await db.outbox.orderBy("seq").limit(50).toArray();
    if (head.length === 0) return;
    const first = head[0]!;
    if (first.kind === "order") {
      const batch: OutboxItem[] = [];
      for (const item of head) {
        if (item.kind !== "order") break;
        batch.push(item);
      }
      let res: { results: { id: string; status: string; error?: string; message?: string }[] };
      try {
        res = await request("/orders/batch", { body: { orders: batch.map((b) => b.payload) } });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500 || err.status === 401) throw err;
        if (batch.length > 1) {
          // One malformed order fails the whole batch; send them one by one to find it.
          batch.length = 1;
          try {
            res = await request("/orders/batch", { body: { orders: [first.payload] } });
          } catch (inner) {
            if (!(inner instanceof ApiError) || inner.status < 400 || inner.status >= 500 || inner.status === 401) throw inner;
            res = { results: [{ id: first.refId, status: "rejected", message: inner.message }] };
          }
        } else {
          res = { results: [{ id: first.refId, status: "rejected", message: err.message }] };
        }
      }
      for (const r of res.results) {
        if (r.status === "rejected") await markOrder(r.id, "rejected", r.message);
        else await markOrder(r.id, "synced");
      }
      await db.outbox.bulkDelete(batch.map((b) => b.seq!));
      continue;
    }
    try {
      if (first.kind === "session.open") await request("/sessions/open", { body: first.payload });
      else if (first.kind === "cash.move") await request("/cash-moves", { body: first.payload });
      else if (first.kind === "session.close") {
        const { sessionId, ...body } = first.payload as { sessionId: string };
        await request(`/sessions/${sessionId}/close`, { body });
      }
      await db.outbox.delete(first.seq!);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401) {
        // The server will never accept this as sent; keep a record and move on.
        await db.setMeta(`failed:${first.seq}`, { ...first, lastError: err.message });
        await db.outbox.delete(first.seq!);
        continue;
      }
      throw err;
    }
  }
}

async function refreshCounts() {
  const pending = await db.outbox.count();
  const failed = await db.orders.where("syncStatus").equals("rejected").count();
  setStatus({ pending, failed });
}

/** The cloud API answers 404 here; only a hub knows this route. */
async function refreshHub() {
  try {
    const info = await request<HubInfo & { hub?: boolean }>("/hub/info");
    setStatus({ hub: info.hub ? info : null });
  } catch (err) {
    if (err instanceof ApiError) setStatus({ hub: null });
    else throw err;
  }
}

let running = false;

export async function syncNow() {
  if (running) return;
  running = true;
  try {
    await refreshHub();
    await pushOutbox();
    await pullCatalog();
    setStatus({ online: true, lastSyncAt: new Date().toISOString(), lastError: null });
  } catch (err) {
    if (err instanceof OfflineError) setStatus({ online: false });
    else setStatus({ lastError: (err as Error).message });
  } finally {
    running = false;
    await refreshCounts();
  }
}

export function startSync(intervalMs = 5_000) {
  void syncNow();
  const timer = setInterval(() => void syncNow(), intervalMs);
  const onOnline = () => void syncNow();
  const onOffline = () => setStatus({ online: false });
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  // Keep the waiting/rejected counters live as sales are queued.
  const counts = liveQuery(async () => ({
    pending: await db.outbox.count(),
    failed: await db.orders.where("syncStatus").equals("rejected").count(),
  })).subscribe({ next: (c) => setStatus(c) });
  return () => {
    counts.unsubscribe();
    clearInterval(timer);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
