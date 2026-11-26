import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../../app.js";
import { withTx, type Tx } from "../../../db.js";
import { notFound } from "../../../errors.js";
import { adminAudit } from "../common.js";
import {
  bad,
  blendCost,
  checkMyStore,
  checkSupplier,
  checkVariants,
  checkWhole,
  empty,
  Fils,
  ISODate,
  lockVariants,
  lotFor,
  mustFind,
  nextNumber,
  Paging,
  Qty,
  writeMove,
  wrongState,
} from "./common.js";
import { storeParam } from "../../../stores.js";

const PoLine = z.object({
  variantId: z.string().uuid(),
  qty: Qty,
  /** Fils per unit before VAT. Defaults to the supplier's last cost, then the product cost. */
  unitCost: Fils.nullish(),
  taxRateBp: z.number().int().min(0).max(10_000).default(500),
});

const PoSchema = z.object({
  supplierId: z.string().uuid(),
  storeId: z.string().uuid(),
  expectedOn: ISODate.nullish(),
  notes: z.string().trim().max(1000).nullish(),
  lines: z.array(PoLine).min(1, "Add at least one product").max(500),
});

const ReceiveLine = z.object({
  qty: Qty,
  unitCost: Fils.nullish(),
  lotCode: z.string().trim().max(60).nullish(),
  expiresOn: ISODate.nullish(),
});

const ReceivePoSchema = z.object({
  supplierInvoice: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  lines: z.array(ReceiveLine.extend({ lineId: z.string().uuid() })).min(1, "Enter what arrived").max(500),
});

const ReceiveDirectSchema = z.object({
  storeId: z.string().uuid(),
  supplierId: z.string().uuid().nullish(),
  supplierInvoice: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  lines: z.array(ReceiveLine.extend({ variantId: z.string().uuid(), unitCost: Fils })).min(1, "Add at least one product").max(500),
});

const ListSchema = Paging.extend({
  status: z.enum(["draft", "ordered", "partial", "received", "closed", "cancelled", "open", "all"]).default("all"),
  supplierId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  q: z.string().trim().max(60).optional(),
});

interface PoRow {
  id: string;
  status: string;
  supplierId: string;
  storeId: string;
  number: string;
}

const PO_TOTALS = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS lines,
           COALESCE(SUM(ROUND(l.qty_ordered * l.unit_cost)), 0)::bigint AS net,
           COALESCE(SUM(ROUND(ROUND(l.qty_ordered * l.unit_cost) * l.tax_rate_bp / 10000.0)), 0)::bigint AS vat,
           COALESCE(SUM(l.qty_ordered), 0) AS ordered, COALESCE(SUM(LEAST(l.qty_received, l.qty_ordered)), 0) AS received
      FROM purchase_order_lines l WHERE l.po_id = po.id) t ON true`;

interface ReceiveItem {
  variantId: string;
  qty: number;
  unitCost: number;
  lotCode?: string | null;
  expiresOn?: string | null;
  poLineId?: string | null;
}

/**
 * Books goods into a store: one goods receipt, a stock move per line, the moving average cost,
 * the supplier's latest price and the lot with its expiry date.
 */
async function receiveGoods(
  tx: Tx,
  ctx: AdminContext,
  head: { storeId: string; supplierId: string | null; poId: string | null; supplierInvoice?: string | null; notes?: string | null },
  items: ReceiveItem[],
) {
  const variants = await checkVariants(tx, ctx.tenantId, items.map((i) => i.variantId));
  for (const it of items) {
    const v = variants.get(it.variantId)!;
    checkWhole(v, it.qty);
    if (v.trackExpiry && !it.expiresOn) throw bad(`${v.name} needs an expiry date`);
  }
  await lockVariants(tx, [...variants.keys()]);
  const id = randomUUID();
  const number = await nextNumber(tx, ctx.tenantId, "grn");
  await tx.query(
    `INSERT INTO goods_receipts (id, tenant_id, number, po_id, supplier_id, store_id, supplier_invoice, notes, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, ctx.tenantId, number, head.poId, head.supplierId, head.storeId, empty(head.supplierInvoice), empty(head.notes), ctx.userId],
  );
  for (const it of items) {
    const lotCode = empty(it.lotCode) ?? (it.expiresOn ? `EXP-${it.expiresOn}` : null);
    const lotId = lotCode ? await lotFor(tx, ctx.tenantId, it.variantId, lotCode, it.expiresOn ?? null) : null;
    await blendCost(tx, it.variantId, it.qty, it.unitCost);
    await tx.query(
      `INSERT INTO goods_receipt_lines (id, receipt_id, po_line_id, variant_id, qty, unit_cost, lot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), id, it.poLineId ?? null, it.variantId, it.qty, it.unitCost, lotId],
    );
    await writeMove(tx, ctx, { storeId: head.storeId, variantId: it.variantId, qty: it.qty, reason: "receive", refId: id, unitCost: it.unitCost, lotId });
    if (head.supplierId) {
      await tx.query(
        `INSERT INTO supplier_items (supplier_id, variant_id, unit_cost) VALUES ($1, $2, $3)
         ON CONFLICT (supplier_id, variant_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, updated_at = now()`,
        [head.supplierId, it.variantId, it.unitCost],
      );
    }
  }
  await adminAudit(tx, ctx, "stock.receive", "goods_receipt", id, {
    number,
    poId: head.poId,
    storeId: head.storeId,
    lines: items.length,
    value: items.reduce((s, i) => s + Math.round(i.qty * i.unitCost), 0),
  });
  return { id, number };
}

/** Default line costs: what this supplier charged last, else the product's cost. */
async function fillCosts(tx: Tx, supplierId: string, lines: z.infer<typeof PoLine>[]) {
  const { rows } = await tx.query(
    `SELECT v.id, COALESCE(si.unit_cost, v.cost, 0) AS cost FROM variants v
       LEFT JOIN supplier_items si ON si.variant_id = v.id AND si.supplier_id = $2
      WHERE v.id = ANY($1)`,
    [lines.map((l) => l.variantId), supplierId],
  );
  const cost = new Map(rows.map((r) => [r.id as string, r.cost as number]));
  return lines.map((l) => ({ ...l, unitCost: l.unitCost ?? cost.get(l.variantId) ?? 0 }));
}

async function writePoLines(tx: Tx, ctx: AdminContext, poId: string, supplierId: string, input: z.infer<typeof PoLine>[]) {
  const variants = await checkVariants(tx, ctx.tenantId, input.map((l) => l.variantId));
  for (const l of input) checkWhole(variants.get(l.variantId)!, l.qty);
  const lines = await fillCosts(tx, supplierId, input);
  await tx.query("DELETE FROM purchase_order_lines WHERE po_id = $1", [poId]);
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `INSERT INTO purchase_order_lines (id, po_id, line_no, variant_id, qty_ordered, unit_cost, tax_rate_bp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), poId, i + 1, l.variantId, l.qty, l.unitCost, l.taxRateBp],
    );
  }
}

const lockPo = (tx: Tx, ctx: AdminContext, id: string) =>
  mustFind<PoRow>(
    tx,
    `SELECT id, status, supplier_id AS "supplierId", store_id AS "storeId", number FROM purchase_orders
      WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[])) FOR UPDATE`,
    [id, ctx.tenantId, ctx.storeIds],
    "Purchase order",
  );

export const ReceivePurchaseSchema = ReceivePoSchema;

/** Books what arrived against an order and moves it to part received or received. Also used by the staff app. */
export async function receivePurchaseOrder(tx: Tx, ctx: AdminContext, poId: string, b: z.infer<typeof ReceivePoSchema>) {
  const po = await lockPo(tx, ctx, poId);
  if (!["draft", "ordered", "partial"].includes(po.status)) throw wrongState(`${po.number} is ${po.status}; nothing more can be received`);
  const { rows: lines } = await tx.query(
    `SELECT id, variant_id AS "variantId", unit_cost AS "unitCost" FROM purchase_order_lines WHERE po_id = $1`,
    [po.id],
  );
  const byId = new Map(lines.map((l) => [l.id as string, l]));
  const seen = new Set<string>();
  const items: ReceiveItem[] = b.lines.map((l) => {
    const line = byId.get(l.lineId);
    if (!line) throw bad("A line does not belong to this order");
    if (seen.has(l.lineId)) throw bad("A line is listed twice");
    seen.add(l.lineId);
    return { ...l, variantId: line.variantId, unitCost: l.unitCost ?? line.unitCost, poLineId: l.lineId };
  });
  const grn = await receiveGoods(tx, ctx, { ...b, storeId: po.storeId, supplierId: po.supplierId, poId: po.id }, items);
  for (const it of items) {
    await tx.query("UPDATE purchase_order_lines SET qty_received = qty_received + $2, unit_cost = $3 WHERE id = $1", [
      it.poLineId,
      it.qty,
      it.unitCost,
    ]);
  }
  const { rows } = await tx.query(
    "SELECT bool_and(qty_received >= qty_ordered) AS done FROM purchase_order_lines WHERE po_id = $1",
    [po.id],
  );
  const status = rows[0].done ? "received" : "partial";
  await tx.query(
    `UPDATE purchase_orders SET status = $2, ordered_at = COALESCE(ordered_at, now()),
            closed_at = CASE WHEN $2 = 'received' THEN now() END, updated_at = now() WHERE id = $1`,
    [po.id, status],
  );
  return { ...grn, status };
}

export async function purchaseRoutes(app: FastifyInstance) {
  app.get("/purchase-orders", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = ListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["po.tenant_id = $1"];
    if (f.status === "open") where.push("po.status IN ('draft', 'ordered', 'partial')");
    else if (f.status !== "all") {
      params.push(f.status);
      where.push(`po.status = $${params.length}`);
    }
    if (f.supplierId) {
      params.push(f.supplierId);
      where.push(`po.supplier_id = $${params.length}`);
    }
    const stores = storeParam(ctx, f.storeId);
    if (stores) {
      params.push(stores);
      where.push(`po.store_id = ANY($${params.length}::uuid[])`);
    }
    if (f.q) {
      params.push(`%${f.q}%`);
      where.push(`(po.number ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
    }
    const sql = `FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN stores st ON st.id = po.store_id
      WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      app.db.query(
        `SELECT po.id, po.number, po.status, po.supplier_id AS "supplierId", s.name AS "supplierName", po.store_id AS "storeId",
                st.name AS "storeName", po.expected_on::text AS "expectedOn", po.created_at AS "createdAt", po.ordered_at AS "orderedAt",
                t.lines, t.net::int AS net, t.vat::int AS vat, (t.net + t.vat)::int AS total, t.ordered, t.received
           ${sql.replace("WHERE", `${PO_TOTALS} WHERE`)}
          ORDER BY po.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    ]);
    return { orders: list.rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/purchase-orders/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const po = await mustFind<Record<string, unknown>>(
      app.db,
      `SELECT po.id, po.number, po.status, po.supplier_id AS "supplierId", s.name AS "supplierName", s.phone AS "supplierPhone",
              s.email AS "supplierEmail", s.trn AS "supplierTrn", s.address AS "supplierAddress", s.payment_terms_days AS "paymentTermsDays",
              po.store_id AS "storeId", st.name AS "storeName", st.address AS "storeAddress", st.trn AS "storeTrn",
              po.expected_on::text AS "expectedOn", po.notes, po.created_at AS "createdAt", po.ordered_at AS "orderedAt",
              po.closed_at AS "closedAt", u.name AS "createdBy", t.net::int AS net, t.vat::int AS vat, (t.net + t.vat)::int AS total
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN stores st ON st.id = po.store_id
         LEFT JOIN users u ON u.id = po.created_by ${PO_TOTALS}
        WHERE po.id = $1 AND po.tenant_id = $2 AND ($3::uuid[] IS NULL OR po.store_id = ANY($3::uuid[]))`,
      [req.params.id, ctx.tenantId, ctx.storeIds],
      "Purchase order",
    );
    const [lines, receipts] = await Promise.all([
      app.db.query(
        `SELECT l.id, l.line_no AS "lineNo", l.variant_id AS "variantId", p.name, p.name_ar AS "nameAr", p.uom, v.barcode,
                si.supplier_sku AS "supplierSku", v.track_expiry AS "trackExpiry", l.qty_ordered AS "qtyOrdered",
                l.qty_received AS "qtyReceived", l.unit_cost AS "unitCost", l.tax_rate_bp AS "taxRateBp",
                ROUND(l.qty_ordered * l.unit_cost)::int AS net,
                (SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = l.variant_id AND m.store_id = $2) AS "onHand"
           FROM purchase_order_lines l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
           LEFT JOIN supplier_items si ON si.variant_id = l.variant_id AND si.supplier_id = $3
          WHERE l.po_id = $1 ORDER BY l.line_no`,
        [req.params.id, po.storeId, po.supplierId],
      ),
      app.db.query(
        `SELECT r.id, r.number, r.supplier_invoice AS "supplierInvoice", r.received_at AS "receivedAt", u.name AS "receivedBy",
                (SELECT COUNT(*)::int FROM goods_receipt_lines gl WHERE gl.receipt_id = r.id) AS lines,
                (SELECT COALESCE(SUM(ROUND(gl.qty * gl.unit_cost)), 0)::int FROM goods_receipt_lines gl WHERE gl.receipt_id = r.id) AS value
           FROM goods_receipts r LEFT JOIN users u ON u.id = r.received_by WHERE r.po_id = $1 ORDER BY r.received_at`,
        [req.params.id],
      ),
    ]);
    return { ...po, lines: lines.rows, receipts: receipts.rows };
  });

  app.post("/purchase-orders", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = PoSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      await checkMyStore(tx, ctx, b.storeId);
      const sup = await checkSupplier(tx, ctx.tenantId, b.supplierId);
      if (!sup.active) throw bad(`${sup.name} is switched off. Switch the supplier on first.`);
      const id = randomUUID();
      const number = await nextNumber(tx, ctx.tenantId, "po");
      await tx.query(
        `INSERT INTO purchase_orders (id, tenant_id, number, supplier_id, store_id, expected_on, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, number, b.supplierId, b.storeId, b.expectedOn ?? null, empty(b.notes), ctx.userId],
      );
      await writePoLines(tx, ctx, id, b.supplierId, b.lines);
      await adminAudit(tx, ctx, "po.create", "purchase_order", id, { number, supplier: sup.name, lines: b.lines.length });
      return { id, number };
    });
  });

  /** A draft, or an order nothing has arrived for yet, can still be changed. */
  app.put<{ Params: { id: string } }>("/purchase-orders/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = PoSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const po = await lockPo(tx, ctx, req.params.id);
      if (po.status !== "draft" && po.status !== "ordered") throw wrongState(`${po.number} has goods received and cannot be changed`);
      await checkMyStore(tx, ctx, b.storeId);
      await checkSupplier(tx, ctx.tenantId, b.supplierId);
      await tx.query(
        `UPDATE purchase_orders SET supplier_id = $2, store_id = $3, expected_on = $4, notes = $5, updated_at = now() WHERE id = $1`,
        [po.id, b.supplierId, b.storeId, b.expectedOn ?? null, empty(b.notes)],
      );
      await writePoLines(tx, ctx, po.id, b.supplierId, b.lines);
      await adminAudit(tx, ctx, "po.update", "purchase_order", po.id, { number: po.number, lines: b.lines.length });
      return { id: po.id };
    });
  });

  /** Marks a draft as sent to the supplier. Goods can then be received against it. */
  app.post<{ Params: { id: string } }>("/purchase-orders/:id/order", async (req) => {
    const ctx = await app.authAdmin(req);
    return withTx(app.db, async (tx) => {
      const po = await lockPo(tx, ctx, req.params.id);
      if (po.status !== "draft") throw wrongState(`${po.number} is already ${po.status}`);
      await tx.query("UPDATE purchase_orders SET status = 'ordered', ordered_at = now(), updated_at = now() WHERE id = $1", [po.id]);
      await adminAudit(tx, ctx, "po.order", "purchase_order", po.id, { number: po.number });
      return { id: po.id, status: "ordered" };
    });
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/receive", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = ReceivePoSchema.parse(req.body);
    return withTx(app.db, (tx) => receivePurchaseOrder(tx, ctx, req.params.id, b));
  });

  /** Stops waiting for the rest of a part-delivered order (the supplier will not send it). */
  app.post<{ Params: { id: string } }>("/purchase-orders/:id/close", async (req) => {
    const ctx = await app.authAdmin(req);
    return withTx(app.db, async (tx) => {
      const po = await lockPo(tx, ctx, req.params.id);
      if (po.status !== "partial") throw wrongState("Only a part-received order can be closed");
      await tx.query("UPDATE purchase_orders SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [po.id]);
      await adminAudit(tx, ctx, "po.close", "purchase_order", po.id, { number: po.number });
      return { id: po.id, status: "closed" };
    });
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/cancel", async (req) => {
    const ctx = await app.authAdmin(req);
    return withTx(app.db, async (tx) => {
      const po = await lockPo(tx, ctx, req.params.id);
      if (po.status !== "draft" && po.status !== "ordered") throw wrongState("Goods have arrived on this order. Close it instead.");
      await tx.query("UPDATE purchase_orders SET status = 'cancelled', closed_at = now(), updated_at = now() WHERE id = $1", [po.id]);
      await adminAudit(tx, ctx, "po.cancel", "purchase_order", po.id, { number: po.number });
      return { id: po.id, status: "cancelled" };
    });
  });

  /** Goods that arrive without a purchase order, e.g. a van sale from a distributor. */
  app.post("/receipts", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = ReceiveDirectSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      await checkMyStore(tx, ctx, b.storeId);
      if (b.supplierId) await checkSupplier(tx, ctx.tenantId, b.supplierId);
      return receiveGoods(tx, ctx, { ...b, supplierId: b.supplierId ?? null, poId: null }, b.lines);
    });
  });

  app.get("/receipts", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = Paging.extend({ storeId: z.string().uuid().optional(), supplierId: z.string().uuid().optional() }).parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["r.tenant_id = $1"];
    const stores = storeParam(ctx, f.storeId);
    if (stores) where.push(`r.store_id = ANY($${params.push(stores)}::uuid[])`);
    if (f.supplierId) where.push(`r.supplier_id = $${params.push(f.supplierId)}`);
    const sql = `FROM goods_receipts r WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      app.db.query(
        `SELECT r.id, r.number, r.po_id AS "poId", po.number AS "poNumber", s.name AS "supplierName", st.name AS "storeName",
                r.supplier_invoice AS "supplierInvoice", r.received_at AS "receivedAt", u.name AS "receivedBy",
                (SELECT COUNT(*)::int FROM goods_receipt_lines gl WHERE gl.receipt_id = r.id) AS lines,
                (SELECT COALESCE(SUM(ROUND(gl.qty * gl.unit_cost)), 0)::int FROM goods_receipt_lines gl WHERE gl.receipt_id = r.id) AS value
           FROM goods_receipts r LEFT JOIN purchase_orders po ON po.id = r.po_id LEFT JOIN suppliers s ON s.id = r.supplier_id
           JOIN stores st ON st.id = r.store_id LEFT JOIN users u ON u.id = r.received_by
          WHERE ${where.join(" AND ")} ORDER BY r.received_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    ]);
    return { receipts: list.rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/receipts/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const r = await mustFind<Record<string, unknown>>(
      app.db,
      `SELECT r.id, r.number, r.po_id AS "poId", po.number AS "poNumber", r.supplier_id AS "supplierId", s.name AS "supplierName",
              r.store_id AS "storeId", st.name AS "storeName", r.supplier_invoice AS "supplierInvoice", r.notes,
              r.received_at AS "receivedAt", u.name AS "receivedBy"
         FROM goods_receipts r LEFT JOIN purchase_orders po ON po.id = r.po_id LEFT JOIN suppliers s ON s.id = r.supplier_id
         JOIN stores st ON st.id = r.store_id LEFT JOIN users u ON u.id = r.received_by
        WHERE r.id = $1 AND r.tenant_id = $2 AND ($3::uuid[] IS NULL OR r.store_id = ANY($3::uuid[]))`,
      [req.params.id, ctx.tenantId, ctx.storeIds],
      "Goods receipt",
    );
    const lines = await app.db.query(
      `SELECT gl.variant_id AS "variantId", p.name, p.uom, v.barcode, gl.qty, gl.unit_cost AS "unitCost",
              ROUND(gl.qty * gl.unit_cost)::int AS value, l.code AS "lotCode", l.expires_on::text AS "expiresOn"
         FROM goods_receipt_lines gl JOIN variants v ON v.id = gl.variant_id JOIN products p ON p.id = v.product_id
         LEFT JOIN lots l ON l.id = gl.lot_id WHERE gl.receipt_id = $1 ORDER BY p.name`,
      [req.params.id],
    );
    if (!r) throw notFound("Goods receipt");
    return { ...r, lines: lines.rows };
  });
}
