import { checkPayments, formatReceiptNumber, pointsEarned, pointsEligible, type AppliedPromotion, type PaymentInput, type TaxRate, type TillEvent } from "@pos/core";
import { request, type DeviceAuth } from "./api.js";
import type { Cart } from "./cart.js";
import { cartTotals } from "./cart.js";
import { getLoyalty } from "./loyalty.js";
import { db, type CashMoveRecord, type DeviceSetup, type LocalOrder, type OutboxKind, type Session } from "./db.js";

/** All till actions write locally first and queue the server call, so they work offline. */

async function enqueue(kind: OutboxKind, refId: string, payload: unknown) {
  await db.outbox.add({ kind, refId, payload, attempts: 0, createdAt: new Date().toISOString() });
}

export async function pairDevice(apiUrl: string, code: string, deviceName: string): Promise<DeviceSetup> {
  const deviceId = crypto.randomUUID();
  const res = await request<DeviceSetup & { token: string }>("/pairing/claim", {
    body: { code, deviceId, deviceName },
    auth: { apiUrl, token: "", deviceId },
  });
  const { token, ...setup } = res;
  const auth: DeviceAuth = { apiUrl, token, deviceId };
  await db.setMeta("auth", auth);
  await db.setMeta("setup", setup);
  await db.setMeta("lastSessionSeq", setup.lastSessionSeq);
  if (setup.openSession) {
    // The register already has an open shift (e.g. this is a replacement device): adopt it.
    const s = setup.openSession;
    const { lastOrderSeq, ...shift } = s;
    // Its sales carry on after the shift's last one, so their numbers don't clash.
    await db.sessions.put({ ...shift, state: "open", orderSeq: lastOrderSeq ?? 0 });
    await db.setMeta("currentSessionId", s.id);
  }
  return setup;
}

export async function getSetup() {
  return db.getMeta<DeviceSetup>("setup");
}

export async function taxMap(): Promise<Record<string, TaxRate>> {
  const taxes = await db.taxes.toArray();
  return Object.fromEntries(taxes.map((t) => [t.id, t]));
}

export async function currentSession(): Promise<Session | undefined> {
  const id = await db.getMeta<string>("currentSessionId");
  return id ? db.sessions.get(id) : undefined;
}

export async function openSession(userId: string, openingCash: number): Promise<Session> {
  const setup = await getSetup();
  if (!setup) throw new Error("Device is not paired");
  return db.transaction("rw", [db.sessions, db.meta, db.outbox], async () => {
    const last = (await db.getMeta<number>("lastSessionSeq")) ?? 0;
    const session: Session = {
      id: crypto.randomUUID(),
      seq: last + 1,
      state: "open",
      openedBy: userId,
      openedAt: new Date().toISOString(),
      openingCash,
      orderSeq: 0,
    };
    await db.sessions.add(session);
    await db.setMeta("lastSessionSeq", session.seq);
    await db.setMeta("currentSessionId", session.id);
    await enqueue("session.open", session.id, {
      id: session.id,
      registerId: setup.register.id,
      seq: session.seq,
      openedBy: userId,
      openingCash,
      openedAt: session.openedAt,
    });
    return session;
  });
}

/**
 * Records something done at the till that the owner should see in the audit log: a voided
 * sale, the drawer opened with no sale, or an override a manager allowed. Queued, so it
 * works offline.
 */
export async function logTillEvent(e: Omit<TillEvent, "id" | "at">) {
  const event: TillEvent = { ...e, id: crypto.randomUUID(), at: new Date().toISOString() };
  await db.transaction("rw", [db.outbox], async () => {
    await enqueue("till.event", event.id, event);
  });
  return event;
}

export async function addCashMove(sessionId: string, userId: string, kind: "in" | "out", amount: number, reason: string) {
  const move: CashMoveRecord = {
    id: crypto.randomUUID(),
    sessionId,
    kind,
    amount,
    reason,
    userId,
    at: new Date().toISOString(),
  };
  await db.transaction("rw", [db.cashMoves, db.outbox], async () => {
    await db.cashMoves.add(move);
    await enqueue("cash.move", move.id, move);
  });
  return move;
}

/** Saves a paid order and queues it for sync in one local transaction. */
export async function completeOrder(
  cart: Cart,
  payments: PaymentInput[],
  cashierId: string,
  /** Made when payment starts, so card payments can point at the order before it exists. */
  orderId: string = crypto.randomUUID(),
  /** Promotions already worked into the cart's lines (see promoteCart). */
  promotions: AppliedPromotion[] = [],
): Promise<LocalOrder> {
  const setup = await getSetup();
  if (!setup) throw new Error("Device is not paired");
  const taxes = await taxMap();
  const totals = cartTotals(cart, taxes);
  const payment = checkPayments(totals.total, payments, setup.store.cashRoundingStep);
  if (!payment.complete) throw new Error("Payment does not cover the total");
  const loyalty = await getLoyalty();
  const earned =
    cart.customerId && !cart.refundOfOrderId && loyalty.enabled ? pointsEarned(pointsEligible(totals.lines, payments), loyalty) : 0;

  return db.transaction("rw", [db.sessions, db.orders, db.outbox, db.meta, db.cardAttempts], async () => {
    const session = await currentSession();
    if (!session || session.state !== "open") throw new Error("Open a shift before selling");
    const usedAt = new Date().toISOString();
    for (const p of payments) if (p.cardTransactionId) await db.cardAttempts.update(p.cardTransactionId, { usedAt });
    const orderSeq = session.orderSeq + 1;
    await db.sessions.update(session.id, { orderSeq });
    const order: LocalOrder = {
      id: orderId,
      number: formatReceiptNumber({
        storeCode: setup.store.code,
        registerCode: setup.register.code,
        sessionSeq: session.seq,
        orderSeq,
      }),
      registerId: setup.register.id,
      sessionId: session.id,
      cashierId,
      customerId: cart.customerId,
      refundOfOrderId: cart.refundOfOrderId,
      ...(cart.webOrderId ? { webOrderId: cart.webOrderId } : {}),
      ...(cart.tabId ? { tabId: cart.tabId } : {}),
      orderDiscountBp: cart.orderDiscountBp,
      createdAt: new Date().toISOString(),
      lines: cart.lines.map(({ uom: _uom, listPrice: _list, sentQty: _sent, ...l }) => ({
        ...l,
        discountBp: l.discountBp ?? 0,
        promoDiscount: l.promoDiscount ?? 0,
        promotionId: l.promotionId ?? null,
      })),
      promotions: promotions.map((p) => ({ promotionId: p.promotionId, name: p.name, amount: p.amount, code: p.code })),
      payments,
      clientTotals: { subtotalNet: totals.subtotalNet, taxTotal: totals.taxTotal, total: totals.total },
      totals,
      payment,
      syncStatus: "pending",
      ...(earned > 0 ? { pointsEarned: earned } : {}),
    };
    await db.orders.add(order);
    const { totals: _t, payment: _p, syncStatus: _s, syncError: _e, pointsEarned: _pe, ...wire } = order;
    await enqueue("order", order.id, wire);
    return order;
  });
}

export interface ShiftSummary {
  openingCash: number;
  cashSales: number;
  cashIn: number;
  cashOut: number;
  expectedCash: number;
  orderCount: number;
  total: number;
  taxTotal: number;
  byKind: Record<string, number>;
}

/** Computed from local data, so a shift can be closed with no internet. */
export async function shiftSummary(session: Session): Promise<ShiftSummary> {
  const orders = await db.orders.where("sessionId").equals(session.id).toArray();
  const moves = await db.cashMoves.where("sessionId").equals(session.id).toArray();
  const byKind: Record<string, number> = {};
  for (const o of orders) for (const p of o.payments) byKind[p.kind] = (byKind[p.kind] ?? 0) + p.amount;
  const cashIn = moves.filter((m) => m.kind === "in").reduce((s, m) => s + m.amount, 0);
  const cashOut = moves.filter((m) => m.kind === "out").reduce((s, m) => s + m.amount, 0);
  const cashSales = byKind.cash ?? 0;
  return {
    openingCash: session.openingCash,
    cashSales,
    cashIn,
    cashOut,
    expectedCash: session.openingCash + cashSales + cashIn - cashOut,
    orderCount: orders.length,
    total: orders.reduce((s, o) => s + o.totals.total, 0),
    taxTotal: orders.reduce((s, o) => s + o.totals.taxTotal, 0),
    byKind,
  };
}

export async function closeSession(session: Session, userId: string, counted: number, note?: string) {
  const closedAt = new Date().toISOString();
  await db.transaction("rw", [db.sessions, db.meta, db.outbox], async () => {
    await db.sessions.update(session.id, { state: "closed", closedAt, closedBy: userId, closingCashCounted: counted });
    await db.setMeta("currentSessionId", null);
    await enqueue("session.close", session.id, { sessionId: session.id, closedBy: userId, closingCashCounted: counted, closedAt, note });
  });
}

/** Finds a past sale by receipt number: locally first, then on the server. */
export async function findSale(number: string): Promise<LocalOrder | { id: string; number: string; remote: true } | null> {
  const local = await db.orders.where("number").equals(number.trim()).first();
  if (local && !local.refundOfOrderId) return local;
  try {
    const res = await request<{ orders: { id: string; number: string }[] }>(`/orders?number=${encodeURIComponent(number.trim())}`);
    const hit = res.orders[0];
    return hit ? { ...hit, remote: true } : null;
  } catch {
    return null;
  }
}

/** Queues a kitchen ticket for the server (kitchen screens); it waits there while offline. */
export async function queueKitchenTicket(ticket: { id: string }) {
  await enqueue("kitchen.ticket", ticket.id, ticket);
}
