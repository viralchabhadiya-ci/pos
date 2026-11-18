import { DEFAULT_LOYALTY, type LoyaltySettings } from "@pos/core";
import type { Db, Tx } from "./db.js";
import { HttpError } from "./errors.js";

/**
 * Points and gift card ledgers. Every change is a new move plus the matching change to the
 * cached balance, in the caller's transaction, so the two never drift apart.
 */

export async function loyaltySettings(db: Db | Tx, tenantId: string): Promise<LoyaltySettings & { updatedAt?: string }> {
  const { rows } = await db.query(
    `SELECT enabled, points_per_aed AS "pointsPerAed", point_value_fils AS "pointValueFils",
            min_redeem_points AS "minRedeemPoints", updated_at AS "updatedAt"
       FROM loyalty_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return (rows[0] as LoyaltySettings | undefined) ?? DEFAULT_LOYALTY;
}

export type PointsMoveKind = "earn" | "redeem" | "refund_earn" | "refund_redeem" | "adjust";

/** Adds a points move and returns the customer's new balance. */
export async function movePoints(
  tx: Tx,
  m: {
    tenantId: string;
    customerId: string;
    points: number;
    kind: PointsMoveKind;
    orderId?: string | null;
    userId?: string | null;
    note?: string | null;
    at?: string;
  },
): Promise<number> {
  if (m.points === 0) {
    const r = await tx.query("SELECT points FROM customers WHERE id = $1", [m.customerId]);
    return r.rows[0]?.points ?? 0;
  }
  await tx.query(
    `INSERT INTO loyalty_moves (tenant_id, customer_id, points, kind, order_id, user_id, note, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))`,
    [m.tenantId, m.customerId, m.points, m.kind, m.orderId ?? null, m.userId ?? null, m.note ?? null, m.at ?? null],
  );
  const { rows } = await tx.query("UPDATE customers SET points = points + $2, updated_at = now() WHERE id = $1 RETURNING points", [
    m.customerId,
    m.points,
  ]);
  return rows[0].points as number;
}

export type GiftCardMoveKind = "sale" | "topup" | "issue" | "redeem" | "redeem_void" | "refund" | "adjust";

export interface GiftCardRow {
  id: string;
  code: string;
  status: "active" | "disabled";
  balance: number;
  expires_at: Date | null;
  customer_id: string | null;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase();

export async function lockGiftCard(tx: Tx, tenantId: string, code: string): Promise<GiftCardRow | undefined> {
  const { rows } = await tx.query(
    "SELECT id, code, status, balance, expires_at, customer_id FROM gift_cards WHERE tenant_id = $1 AND code = $2 FOR UPDATE",
    [tenantId, normalizeCode(code)],
  );
  return rows[0];
}

/** Finds a card by number, making it (empty) when it is new. Returns it locked. */
export async function lockOrCreateGiftCard(tx: Tx, tenantId: string, code: string, customerId: string | null): Promise<GiftCardRow> {
  const found = await lockGiftCard(tx, tenantId, code);
  if (found) return found;
  await tx.query("INSERT INTO gift_cards (tenant_id, code, customer_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
    tenantId,
    normalizeCode(code),
    customerId,
  ]);
  return (await lockGiftCard(tx, tenantId, code))!;
}

const LOADS = new Set<GiftCardMoveKind>(["sale", "topup", "issue", "refund"]);

/** Adds a gift card move and returns the card's new balance. Loads also count toward `loaded`. */
export async function moveGiftCard(
  tx: Tx,
  m: {
    tenantId: string;
    cardId: string;
    amount: number;
    kind: GiftCardMoveKind;
    orderId?: string | null;
    paymentId?: string | null;
    storeId?: string | null;
    userId?: string | null;
    note?: string | null;
  },
): Promise<number> {
  await tx.query(
    `INSERT INTO gift_card_moves (tenant_id, gift_card_id, amount, kind, order_id, payment_id, store_id, user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [m.tenantId, m.cardId, m.amount, m.kind, m.orderId ?? null, m.paymentId ?? null, m.storeId ?? null, m.userId ?? null, m.note ?? null],
  );
  const load = LOADS.has(m.kind) && m.amount > 0 ? m.amount : 0;
  const { rows } = await tx.query(
    "UPDATE gift_cards SET balance = balance + $2, loaded = loaded + $3, updated_at = now() WHERE id = $1 RETURNING balance",
    [m.cardId, m.amount, load],
  );
  return rows[0].balance as number;
}

/** Why a card cannot be spent right now, or null when it can. */
export function cannotSpend(card: GiftCardRow | undefined, now = new Date()): HttpError | null {
  if (!card) return new HttpError(404, "gift_card_not_found", "No gift card with that number");
  if (card.status !== "active") return new HttpError(409, "gift_card_disabled", "This gift card has been switched off");
  if (card.expires_at && card.expires_at < now) return new HttpError(409, "gift_card_expired", "This gift card has expired");
  return null;
}
