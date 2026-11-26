import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../../app.js";
import { withTx, type Tx } from "../../../db.js";
import { adminAudit, forbidden } from "../common.js";
import { assertStore, canSeeStore } from "../../../stores.js";
import { bad, checkStore, checkVariants, checkWhole, empty, lockVariants, mustFind, nextNumber, Paging, Qty, writeMove, wrongState } from "./common.js";

const TransferSchema = z.object({
  fromStoreId: z.string().uuid(),
  toStoreId: z.string().uuid(),
  notes: z.string().trim().max(1000).nullish(),
  lines: z.array(z.object({ variantId: z.string().uuid(), qty: Qty })).min(1, "Add at least one product").max(500),
});

const ReceiveSchema = z.object({
  /** What actually arrived per line; lines left out arrived in full. */
  lines: z.array(z.object({ lineId: z.string().uuid(), qtyReceived: z.number().min(0).max(1_000_000) })).max(500).default([]),
});

interface TransferRow {
  id: string;
  number: string;
  status: string;
  fromStoreId: string;
  toStoreId: string;
}

const lock = (tx: Tx, ctx: AdminContext, id: string) =>
  mustFind<TransferRow>(
    tx,
    `SELECT id, number, status, from_store_id AS "fromStoreId", to_store_id AS "toStoreId" FROM transfers
      WHERE id = $1 AND tenant_id = $2
        AND ($3::uuid[] IS NULL OR from_store_id = ANY($3::uuid[]) OR to_store_id = ANY($3::uuid[])) FOR UPDATE`,
    [id, ctx.tenantId, ctx.storeIds],
    "Transfer",
  );

async function writeLines(tx: Tx, ctx: AdminContext, id: string, lines: z.infer<typeof TransferSchema>["lines"]) {
  const variants = await checkVariants(tx, ctx.tenantId, lines.map((l) => l.variantId));
  for (const l of lines) checkWhole(variants.get(l.variantId)!, l.qty);
  await tx.query("DELETE FROM transfer_lines WHERE transfer_id = $1", [id]);
  for (const [i, l] of lines.entries()) {
    await tx.query("INSERT INTO transfer_lines (id, transfer_id, line_no, variant_id, qty) VALUES ($1, $2, $3, $4, $5)", [
      randomUUID(),
      id,
      i + 1,
      l.variantId,
      l.qty,
    ]);
  }
}

/**
 * A store manager can send stock from their store, or ask another store for stock (a draft
 * the other store sends). Sending needs the sending store, receiving the receiving one.
 */
async function checkStores(tx: Tx, ctx: AdminContext, b: { fromStoreId: string; toStoreId: string }) {
  if (b.fromStoreId === b.toStoreId) throw bad("Pick two different stores");
  if (!canSeeStore(ctx, b.fromStoreId) && !canSeeStore(ctx, b.toStoreId)) {
    throw forbidden("One of the two stores must be yours");
  }
  await checkStore(tx, ctx.tenantId, b.fromStoreId);
  await checkStore(tx, ctx.tenantId, b.toStoreId);
}

export async function transferRoutes(app: FastifyInstance) {
  app.get("/transfers", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = Paging.extend({
      status: z.enum(["draft", "sent", "received", "cancelled", "open", "all"]).default("all"),
      storeId: z.string().uuid().optional(),
    }).parse(req.query);
    const params: unknown[] = [ctx.tenantId, ctx.storeIds];
    const where = ["t.tenant_id = $1", "($2::uuid[] IS NULL OR t.from_store_id = ANY($2::uuid[]) OR t.to_store_id = ANY($2::uuid[]))"];
    if (f.status === "open") where.push("t.status IN ('draft', 'sent')");
    else if (f.status !== "all") where.push(`t.status = $${params.push(f.status)}`);
    if (f.storeId) assertStore(ctx, f.storeId);
    if (f.storeId) where.push(`(t.from_store_id = $${params.push(f.storeId)} OR t.to_store_id = $${params.length})`);
    const sql = `FROM transfers t WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      app.db.query(
        `SELECT t.id, t.number, t.status, t.from_store_id AS "fromStoreId", fs.name AS "fromStoreName", t.to_store_id AS "toStoreId",
                ts.name AS "toStoreName", t.created_at AS "createdAt", t.sent_at AS "sentAt", t.received_at AS "receivedAt",
                (SELECT COUNT(*)::int FROM transfer_lines l WHERE l.transfer_id = t.id) AS lines,
                (SELECT COALESCE(SUM(l.qty), 0) FROM transfer_lines l WHERE l.transfer_id = t.id) AS qty
           FROM transfers t JOIN stores fs ON fs.id = t.from_store_id JOIN stores ts ON ts.id = t.to_store_id
          WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    ]);
    return { transfers: list.rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/transfers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const t = await mustFind<TransferRow & Record<string, unknown>>(
      app.db,
      `SELECT t.id, t.number, t.status, t.from_store_id AS "fromStoreId", fs.name AS "fromStoreName", t.to_store_id AS "toStoreId",
              ts.name AS "toStoreName", t.notes, t.created_at AS "createdAt", cu.name AS "createdBy", t.sent_at AS "sentAt",
              su.name AS "sentBy", t.received_at AS "receivedAt", ru.name AS "receivedBy"
         FROM transfers t JOIN stores fs ON fs.id = t.from_store_id JOIN stores ts ON ts.id = t.to_store_id
         LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users su ON su.id = t.sent_by LEFT JOIN users ru ON ru.id = t.received_by
        WHERE t.id = $1 AND t.tenant_id = $2
          AND ($3::uuid[] IS NULL OR t.from_store_id = ANY($3::uuid[]) OR t.to_store_id = ANY($3::uuid[]))`,
      [req.params.id, ctx.tenantId, ctx.storeIds],
      "Transfer",
    );
    const lines = await app.db.query(
      `SELECT l.id, l.variant_id AS "variantId", p.name, p.uom, v.barcode, l.qty, l.qty_received AS "qtyReceived",
              v.cost, (SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = l.variant_id AND m.store_id = $2) AS "fromOnHand"
         FROM transfer_lines l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
        WHERE l.transfer_id = $1 ORDER BY l.line_no`,
      [req.params.id, t.fromStoreId],
    );
    return { ...t, lines: lines.rows };
  });

  app.post("/transfers", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = TransferSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      await checkStores(tx, ctx, b);
      const id = randomUUID();
      const number = await nextNumber(tx, ctx.tenantId, "transfer");
      await tx.query(
        `INSERT INTO transfers (id, tenant_id, number, from_store_id, to_store_id, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.tenantId, number, b.fromStoreId, b.toStoreId, empty(b.notes), ctx.userId],
      );
      await writeLines(tx, ctx, id, b.lines);
      await adminAudit(tx, ctx, "transfer.create", "transfer", id, { number, lines: b.lines.length });
      return { id, number };
    });
  });

  app.put<{ Params: { id: string } }>("/transfers/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = TransferSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const t = await lock(tx, ctx, req.params.id);
      if (t.status !== "draft") throw wrongState(`${t.number} has been sent and cannot be changed`);
      await checkStores(tx, ctx, b);
      await tx.query("UPDATE transfers SET from_store_id = $2, to_store_id = $3, notes = $4, updated_at = now() WHERE id = $1", [
        t.id,
        b.fromStoreId,
        b.toStoreId,
        empty(b.notes),
      ]);
      await writeLines(tx, ctx, t.id, b.lines);
      await adminAudit(tx, ctx, "transfer.update", "transfer", t.id, { number: t.number });
      return { id: t.id };
    });
  });

  /** The goods leave the sending store now and are in transit until the other store receives them. */
  app.post<{ Params: { id: string } }>("/transfers/:id/send", async (req) => {
    const ctx = await app.authAdmin(req);
    return withTx(app.db, async (tx) => {
      const t = await lock(tx, ctx, req.params.id);
      if (t.status !== "draft") throw wrongState(`${t.number} is already ${t.status}`);
      if (!canSeeStore(ctx, t.fromStoreId)) throw forbidden("Only the sending store can send this transfer");
      const { rows: lines } = await tx.query(`SELECT variant_id AS "variantId", qty FROM transfer_lines WHERE transfer_id = $1`, [t.id]);
      await lockVariants(tx, lines.map((l) => l.variantId));
      for (const l of lines) {
        await writeMove(tx, ctx, { storeId: t.fromStoreId, variantId: l.variantId, qty: -l.qty, reason: "transfer", refId: t.id });
      }
      await tx.query("UPDATE transfers SET status = 'sent', sent_at = now(), sent_by = $2, updated_at = now() WHERE id = $1", [t.id, ctx.userId]);
      await adminAudit(tx, ctx, "transfer.send", "transfer", t.id, { number: t.number });
      return { id: t.id, status: "sent" };
    });
  });

  /** Books what arrived into the receiving store. A shortfall is reported and stays out of stock. */
  app.post<{ Params: { id: string } }>("/transfers/:id/receive", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = ReceiveSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const t = await lock(tx, ctx, req.params.id);
      if (t.status !== "sent") throw wrongState(t.status === "draft" ? `Send ${t.number} first` : `${t.number} is already ${t.status}`);
      if (!canSeeStore(ctx, t.toStoreId)) throw forbidden("Only the receiving store can receive this transfer");
      const { rows: lines } = await tx.query(
        `SELECT l.id, l.variant_id AS "variantId", l.qty, p.name, p.uom FROM transfer_lines l
           JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id WHERE l.transfer_id = $1`,
        [t.id],
      );
      const given = new Map(b.lines.map((l) => [l.lineId, l.qtyReceived]));
      for (const id of given.keys()) if (!lines.some((l) => l.id === id)) throw bad("A line does not belong to this transfer");
      const short: { name: string; sent: number; received: number }[] = [];
      for (const l of lines) {
        const got = Math.round((given.get(l.id) ?? l.qty) * 1000) / 1000;
        checkWhole(l, got);
        if (got > 0) await writeMove(tx, ctx, { storeId: t.toStoreId, variantId: l.variantId, qty: got, reason: "transfer", refId: t.id });
        await tx.query("UPDATE transfer_lines SET qty_received = $2 WHERE id = $1", [l.id, got]);
        if (got !== l.qty) short.push({ name: l.name, sent: l.qty, received: got });
      }
      await tx.query("UPDATE transfers SET status = 'received', received_at = now(), received_by = $2, updated_at = now() WHERE id = $1", [
        t.id,
        ctx.userId,
      ]);
      await adminAudit(tx, ctx, "transfer.receive", "transfer", t.id, { number: t.number, ...(short.length ? { differences: short } : {}) });
      return { id: t.id, status: "received", differences: short };
    });
  });

  /** A draft is dropped; a sent transfer is called back and the stock returns to the sending store. */
  app.post<{ Params: { id: string } }>("/transfers/:id/cancel", async (req) => {
    const ctx = await app.authAdmin(req);
    return withTx(app.db, async (tx) => {
      const t = await lock(tx, ctx, req.params.id);
      if (t.status !== "draft" && t.status !== "sent") throw wrongState(`${t.number} is already ${t.status}`);
      if (t.status === "sent" && !canSeeStore(ctx, t.fromStoreId)) throw forbidden("Only the sending store can call back a sent transfer");
      if (t.status === "sent") {
        const { rows } = await tx.query(`SELECT variant_id AS "variantId", qty FROM transfer_lines WHERE transfer_id = $1`, [t.id]);
        for (const l of rows) {
          await writeMove(tx, ctx, { storeId: t.fromStoreId, variantId: l.variantId, qty: l.qty, reason: "transfer", refId: t.id, note: "Transfer cancelled" });
        }
      }
      await tx.query("UPDATE transfers SET status = 'cancelled', updated_at = now() WHERE id = $1", [t.id]);
      await adminAudit(tx, ctx, "transfer.cancel", "transfer", t.id, { number: t.number, wasSent: t.status === "sent" });
      return { id: t.id, status: "cancelled" };
    });
  });
}
