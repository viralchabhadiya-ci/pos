import { assertStore } from "../../../stores.js";
import type { AdminContext } from "../../../app.js";
import type { Db, Tx } from "../../../db.js";
import { HttpError, notFound } from "../../../errors.js";
import { z } from "zod";

export const bad = (message: string) => new HttpError(400, "bad_request", message);
export const wrongState = (message: string) => new HttpError(409, "wrong_state", message);

/** Quantities: up to 3 decimals (kg), never zero. */
export const Qty = z.number().finite().gt(0).max(1_000_000).transform((n) => Math.round(n * 1000) / 1000);
export const Fils = z.number().int().min(0).max(100_000_000);
export const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PREFIX = { po: "PO", grn: "GRN", transfer: "TR", count: "SC" } as const;

/** The next document number for this business, e.g. PO-00012. Safe under concurrent use. */
export async function nextNumber(tx: Tx, tenantId: string, kind: keyof typeof PREFIX): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO doc_sequences (tenant_id, kind, next) VALUES ($1, $2, 2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next = doc_sequences.next + 1
     RETURNING next - 1 AS n`,
    [tenantId, kind],
  );
  return `${PREFIX[kind]}-${String(rows[0].n).padStart(5, "0")}`;
}

export async function checkStore(db: Db | Tx, tenantId: string, storeId: string) {
  const { rows } = await db.query("SELECT id, name FROM stores WHERE id = $1 AND tenant_id = $2", [storeId, tenantId]);
  if (!rows[0]) throw bad("That store does not exist");
  return rows[0] as { id: string; name: string };
}

/** A store the signed-in user may work on: store managers only reach their own stores. */
export async function checkMyStore(db: Db | Tx, ctx: AdminContext, storeId: string) {
  assertStore(ctx, storeId);
  return checkStore(db, ctx.tenantId, storeId);
}

export async function checkSupplier(db: Db | Tx, tenantId: string, supplierId: string) {
  const { rows } = await db.query("SELECT id, name, active FROM suppliers WHERE id = $1 AND tenant_id = $2", [supplierId, tenantId]);
  if (!rows[0]) throw bad("That supplier does not exist");
  return rows[0] as { id: string; name: string; active: boolean };
}

/** Every variant must belong to this business. Returns them by id with the product's unit. */
export async function checkVariants(db: Db | Tx, tenantId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw bad("A product is listed twice. Put the full quantity on one line.");
  const { rows } = await db.query(
    `SELECT v.id, v.cost, v.track_expiry AS "trackExpiry", p.name, p.uom
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1) AND v.tenant_id = $2`,
    [unique, tenantId],
  );
  if (rows.length !== unique.length) throw bad("One of the products does not exist");
  const map = new Map<string, { id: string; cost: number | null; trackExpiry: boolean; name: string; uom: "unit" | "kg" }>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

export function checkWhole(v: { name: string; uom: string }, qty: number) {
  if (v.uom === "unit" && !Number.isInteger(qty)) throw bad(`${v.name} is counted in whole pieces`);
}

/** Locks the variants' rows so cost averaging and stock checks see a stable picture. */
export async function lockVariants(tx: Tx, ids: string[]) {
  await tx.query("SELECT id FROM variants WHERE id = ANY($1) ORDER BY id FOR UPDATE", [ids]);
}

export async function onHand(db: Db | Tx, storeId: string, variantId: string): Promise<number> {
  const { rows } = await db.query("SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves WHERE store_id = $1 AND variant_id = $2", [
    storeId,
    variantId,
  ]);
  return rows[0].n;
}

export interface Move {
  storeId: string;
  variantId: string;
  qty: number;
  reason: "adjust" | "receive" | "transfer" | "count" | "waste";
  refId?: string | null;
  unitCost?: number | null;
  lotId?: string | null;
  note?: string | null;
}

export async function writeMove(tx: Tx, ctx: AdminContext, m: Move) {
  await tx.query(
    `INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason, ref_id, unit_cost, lot_id, user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [ctx.tenantId, m.storeId, m.variantId, m.qty, m.reason, m.refId ?? null, m.unitCost ?? null, m.lotId ?? null, ctx.userId,
      m.note ?? null],
  );
}

/**
 * Moving average cost across all stores: what is already on the shelf keeps its cost and the new
 * goods are blended in. Stock below zero counts as none, so a negative balance cannot skew it.
 * Call before writing the receive move, with the variant row locked.
 */
export async function blendCost(tx: Tx, variantId: string, qty: number, unitCost: number) {
  const { rows } = await tx.query(
    `SELECT v.cost, COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.variant_id = v.id), 0) AS on_hand
       FROM variants v WHERE v.id = $1`,
    [variantId],
  );
  const { cost, on_hand } = rows[0] as { cost: number | null; on_hand: number };
  const have = Math.max(0, on_hand);
  const next = cost === null || have === 0 ? unitCost : Math.round((have * cost + qty * unitCost) / (have + qty));
  // updated_at is left alone: cost is not on the till, so tills need not download the product again.
  if (next !== cost) await tx.query("UPDATE variants SET cost = $2 WHERE id = $1", [variantId, next]);
  return next;
}

/** Finds or creates the lot (batch) a delivery belongs to. */
export async function lotFor(tx: Tx, tenantId: string, variantId: string, code: string, expiresOn: string | null) {
  const { rows } = await tx.query(
    `INSERT INTO lots (id, tenant_id, variant_id, code, expires_on) VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, variant_id, code) DO UPDATE SET expires_on = COALESCE(EXCLUDED.expires_on, lots.expires_on)
     RETURNING id`,
    [tenantId, variantId, code, expiresOn],
  );
  return rows[0].id as string;
}

export async function mustFind<T>(db: Db | Tx, sql: string, params: unknown[], what: string): Promise<T> {
  const { rows } = await db.query(sql, params);
  if (!rows[0]) throw notFound(what);
  return rows[0] as T;
}

export const empty = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-31");
