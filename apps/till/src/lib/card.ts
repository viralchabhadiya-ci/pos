import { ApiError, OfflineError, request } from "./api.js";
import { t } from "./i18n.js";
import { db, type CardAttempt } from "./db.js";

export interface Terminal {
  id: string;
  name: string;
  provider: string;
}

export interface CardResult {
  id: string;
  kind: "sale" | "refund";
  amount: number;
  status: CardAttempt["status"];
  authCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  message: string | null;
  terminalName: string | null;
}

export const FINAL = new Set(["approved", "declined", "cancelled", "failed"]);

/** The register's card terminal, or null. Offline it remembers the last answer. */
export async function loadTerminal(): Promise<{ terminal: Terminal | null; online: boolean }> {
  try {
    const { terminal } = await request<{ terminal: Terminal | null }>("/card/terminal");
    await db.setMeta("terminal", terminal);
    return { terminal, online: true };
  } catch (err) {
    if (err instanceof OfflineError || (err instanceof ApiError && err.status >= 500)) {
      return { terminal: (await db.getMeta<Terminal | null>("terminal")) ?? null, online: false };
    }
    throw err;
  }
}

async function remember(r: CardResult) {
  await db.cardAttempts.update(r.id, { status: r.status, cardLast4: r.cardLast4, authCode: r.authCode });
  return r;
}

/**
 * Starts a card payment. The attempt is stored before the request goes out, so if the
 * answer is lost the same id is asked about again and the card is never charged twice.
 */
export async function startCard(input: { orderId: string; amount: number; kind: "sale" | "refund"; userId: string; refundOf?: string }) {
  const attempt: CardAttempt = {
    id: crypto.randomUUID(),
    orderId: input.orderId,
    kind: input.kind,
    amount: input.amount,
    status: "pending",
    createdAt: new Date().toISOString(),
    refundOf: input.refundOf,
  };
  await db.cardAttempts.add(attempt);
  return sendCard(attempt, input.userId);
}

/** Sends (or re-sends) an attempt. The server treats a repeat as a status check. */
export async function sendCard(attempt: CardAttempt, userId?: string): Promise<CardResult> {
  try {
    return await remember(
      await request<CardResult>("/card/payments", {
        body: {
          id: attempt.id,
          kind: attempt.kind,
          amount: attempt.amount,
          orderId: attempt.orderId,
          userId,
          refundOf: attempt.refundOf,
        },
      }),
    );
  } catch (err) {
    if (err instanceof OfflineError || (err instanceof ApiError && err.status >= 500)) {
      // We cannot tell whether the request reached the terminal, so it must be checked, never resent blind.
      await db.cardAttempts.update(attempt.id, { status: "unknown" });
      return { ...blank(attempt), status: "unknown", message: t("No connection. Checking again…") };
    }
    if (err instanceof ApiError && err.status < 500) {
      // The server refused it outright (e.g. no terminal): nothing was charged.
      await db.cardAttempts.update(attempt.id, { status: "failed" });
    }
    throw err;
  }
}

/** Asks what happened. Falls back to re-sending when the server never got the first request. */
export async function checkCard(attempt: CardAttempt): Promise<CardResult> {
  try {
    return await remember(await request<CardResult>(`/card/payments/${attempt.id}`));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return sendCard(attempt);
    if (err instanceof OfflineError || (err instanceof ApiError && err.status >= 500)) {
      return { ...blank(attempt), status: "unknown", message: t("No connection. Checking again…") };
    }
    throw err;
  }
}

export async function cancelCard(attempt: CardAttempt): Promise<CardResult> {
  try {
    return await remember(await request<CardResult>(`/card/payments/${attempt.id}/cancel`, { method: "POST", body: {} }));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // The server never saw it, so nothing was charged.
      await db.cardAttempts.update(attempt.id, { status: "cancelled" });
      return { ...blank(attempt), status: "cancelled", message: t("Cancelled") };
    }
    if (err instanceof OfflineError || (err instanceof ApiError && err.status >= 500)) {
      return { ...blank(attempt), status: "unknown", message: t("No connection. Cannot cancel yet.") };
    }
    throw err;
  }
}

/** A manager confirms a stranded charge was dealt with; the server records who and stops flagging it. */
export async function resolveCard(id: string, managerId: string) {
  await request(`/card/payments/${id}/resolve`, { method: "POST", body: { userId: managerId } });
  await db.cardAttempts.update(id, { resolvedAt: new Date().toISOString() });
}

function blank(a: CardAttempt): CardResult {
  return {
    id: a.id,
    kind: a.kind,
    amount: a.amount,
    status: a.status,
    authCode: a.authCode ?? null,
    cardBrand: null,
    cardLast4: a.cardLast4 ?? null,
    message: null,
    terminalName: null,
  };
}

/**
 * Approved card payments that never made it onto a sale, e.g. the till was closed while the
 * customer paid. The cashier must use or refund them; they are never silently dropped.
 */
export async function strandedCardPayments(): Promise<CardAttempt[]> {
  const all = await db.cardAttempts.orderBy("createdAt").toArray();
  const cutoff = Date.now() - 2 * 60_000;
  return all.filter(
    (a) => !a.usedAt && !a.resolvedAt && (a.status === "approved" || a.status === "unknown" || a.status === "pending") && Date.parse(a.createdAt) < cutoff,
  );
}

/** The original sale's card payment, for refunding back to the same card. */
export async function originalCardPayment(orderId: string): Promise<{ id: string; amount: number } | null> {
  const local = await db.orders.get(orderId);
  const fromLocal = local?.payments.find((p) => p.kind === "card" && p.cardTransactionId);
  if (fromLocal) return { id: fromLocal.cardTransactionId!, amount: fromLocal.amount };
  try {
    const remote = await request<{ payments: { kind: string; amount: number; card_transaction_id: string | null }[] }>(`/orders/${orderId}`);
    const p = remote.payments.find((x) => x.kind === "card" && x.card_transaction_id);
    return p ? { id: p.card_transaction_id!, amount: p.amount } : null;
  } catch {
    return null;
  }
}
