import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { money, toCsv } from "../../../csv.js";
import type { AdminContext } from "../../../app.js";
import { withTx, type Tx } from "../../../db.js";
import { emitLowStock } from "../../../webhooks/events.js";
import { notFound } from "../../../errors.js";
import { adminAudit } from "../common.js";
import {
  bad,
  checkStore,
  checkSupplier,
  checkVariants,
  checkWhole,
  empty,
  Fils,
  lockVariants,
  nextNumber,
  Paging,
  Qty,
  writeMove,
} from "./common.js";

const StockListSchema = Paging.extend({
  storeId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(["all", "low", "out", "negative", "in"]).default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ItemSettingsSchema = z.object({
  reorderLevel: z.number().min(0).max(1_000_000).nullable(),
  reorderQty: z.number().min(0).max(1_000_000).nullable(),
  preferredSupplierId: z.string().uuid().nullable(),
  trackExpiry: z.boolean(),
  suppliers: z
    .array(z.object({ supplierId: z.string().uuid(), supplierSku: z.string().trim().max(60).nullish(), unitCost: Fils.nullish() }))
    .max(20)
    .optional(),
});

export const AdjustSchema = z.object({
  storeId: z.string().uuid(),
  /** adjust: a correction either way (signed). waste: damaged, expired or stolen goods written off (positive). */
  reason: z.enum(["adjust", "waste"]),
  note: z.string().trim().max(300).nullish(),
  lines: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        qty: z.number().finite().refine((n) => n !== 0, "Quantity cannot be zero").transform((n) => Math.round(n * 1000) / 1000),
        lotId: z.string().uuid().nullish(),
      }),
    )
    .min(1)
    .max(200),
});

const ReorderSchema = z.object({
  storeId: z.string().uuid(),
  /** Days of sales an order should last after it arrives. */
  coverDays: z.coerce.number().int().min(1).max(120).default(14),
});

const CreatePosSchema = z.object({
  storeId: z.string().uuid(),
  lines: z.array(z.object({ variantId: z.string().uuid(), supplierId: z.string().uuid(), qty: Qty })).min(1).max(1000),
});

const MOVE_REASONS = ["sale", "refund", "adjust", "receive", "transfer", "count", "waste"] as const;
const SALES_DAYS = 28;

const ON_HAND = (store: string) =>
  `(SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = v.id ${store ? `AND m.store_id = ${store}` : ""})`;

/** Ordered but not yet arrived, for one store or all. */
const INCOMING = (store: string) => `(
  SELECT COALESCE(SUM(GREATEST(l.qty_ordered - l.qty_received, 0)), 0) FROM purchase_order_lines l
    JOIN purchase_orders po ON po.id = l.po_id
   WHERE l.variant_id = v.id AND po.status IN ('ordered', 'partial') ${store ? `AND po.store_id = ${store}` : ""})
 + (SELECT COALESCE(SUM(tl.qty), 0) FROM transfer_lines tl JOIN transfers t ON t.id = tl.transfer_id
     WHERE tl.variant_id = v.id AND t.status = 'sent' ${store ? `AND t.to_store_id = ${store}` : ""})`;

/** Corrections and write-offs (damaged, expired, stolen). Used by the back office and the public API. */
export async function adjustStock(tx: Tx, ctx: AdminContext, b: z.infer<typeof AdjustSchema>) {
  await checkStore(tx, ctx.tenantId, b.storeId);
  const variants = await checkVariants(tx, ctx.tenantId, b.lines.map((l) => l.variantId));
  if (b.reason === "waste" && b.lines.some((l) => l.qty < 0)) throw bad("Enter how many were thrown away as a positive number");
  if (b.reason === "waste" && !empty(b.note)) throw bad("Say why the stock is written off, e.g. expired or damaged");
  for (const l of b.lines) {
    checkWhole(variants.get(l.variantId)!, Math.abs(l.qty));
    if (l.lotId) {
      const { rowCount } = await tx.query("SELECT 1 FROM lots WHERE id = $1 AND variant_id = $2", [l.lotId, l.variantId]);
      if (!rowCount) throw bad("That batch does not belong to the product");
    }
  }
  await lockVariants(tx, [...variants.keys()]);
  const ref = randomUUID();
  let value = 0;
  const moved = new Map<string, number>();
  for (const l of b.lines) {
    const qty = b.reason === "waste" ? -l.qty : l.qty;
    value += Math.round(qty * (variants.get(l.variantId)!.cost ?? 0));
    moved.set(l.variantId, qty);
    await writeMove(tx, ctx, { storeId: b.storeId, variantId: l.variantId, qty, reason: b.reason, refId: ref, lotId: l.lotId, note: empty(b.note) });
  }
  await adminAudit(tx, ctx, `stock.${b.reason}`, "stock_adjustment", ref, { storeId: b.storeId, lines: b.lines.length, value, note: empty(b.note) });
  await emitLowStock(tx, ctx.tenantId, b.storeId, moved);
  return { id: ref, value };
}

export async function stockRoutes(app: FastifyInstance) {
  /** Product picker for documents: search by name, barcode or SKU, with the store's stock. */
  app.get("/inventory/items", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = z
      .object({ q: z.string().trim().max(100).default(""), storeId: z.string().uuid().optional(), supplierId: z.string().uuid().optional() })
      .parse(req.query);
    const params: unknown[] = [ctx.tenantId, f.storeId ?? null, f.supplierId ?? null];
    let filter = "";
    if (f.q) {
      params.push(`%${f.q}%`, f.q);
      filter = `AND (p.name ILIKE $4 OR p.name_ar ILIKE $4 OR v.barcode = $5 OR $5 = ANY(v.extra_barcodes) OR v.sku = $5 OR si.supplier_sku = $5)`;
    }
    const { rows } = await app.db.query(
      `SELECT v.id AS "variantId", p.id AS "productId", p.name, p.name_ar AS "nameAr", p.uom, v.barcode, v.sku, v.cost,
              v.track_expiry AS "trackExpiry", si.unit_cost AS "supplierCost", si.supplier_sku AS "supplierSku",
              (SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = v.id AND ($2::uuid IS NULL OR m.store_id = $2)) AS "onHand"
         FROM variants v JOIN products p ON p.id = v.product_id
         LEFT JOIN supplier_items si ON si.variant_id = v.id AND si.supplier_id = $3
        WHERE v.tenant_id = $1 AND p.active ${filter}
        ORDER BY (v.barcode = $${f.q ? 5 : 1}::text) DESC NULLS LAST, (si.variant_id IS NOT NULL) DESC, p.name LIMIT 30`,
      params,
    );
    return { items: rows };
  });

  app.get("/inventory/stock", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = StockListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    if (f.storeId) {
      await checkStore(app.db, ctx.tenantId, f.storeId);
      params.push(f.storeId);
    }
    const store = f.storeId ? "$2" : "";
    const where = ["v.tenant_id = $1"];
    if (f.q) {
      params.push(`%${f.q}%`, f.q);
      const a = params.length - 1;
      where.push(`(p.name ILIKE $${a} OR p.name_ar ILIKE $${a} OR v.barcode = $${a + 1} OR $${a + 1} = ANY(v.extra_barcodes) OR v.sku = $${a + 1})`);
    }
    if (f.categoryId) where.push(`p.category_id = $${params.push(f.categoryId)}`);
    const status = {
      all: "true",
      low: "p.active AND v.reorder_level IS NOT NULL AND x.on_hand <= v.reorder_level",
      out: "p.active AND x.on_hand <= 0",
      negative: "x.on_hand < 0",
      in: "x.on_hand > 0",
    }[f.status];
    const base = `
      FROM variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN suppliers s ON s.id = v.preferred_supplier_id
      CROSS JOIN LATERAL (SELECT ${ON_HAND(store)} AS on_hand, ${INCOMING(store)} AS incoming) x
     WHERE ${where.join(" AND ")} AND (p.active OR x.on_hand <> 0) AND ${status}`;
    const [list, totals] = await Promise.all([
      app.db.query(
        `SELECT v.id AS "variantId", p.id AS "productId", p.name, p.name_ar AS "nameAr", p.uom, v.barcode, v.sku, c.name AS "categoryName",
                v.cost, x.on_hand AS "onHand", x.incoming, ROUND(GREATEST(x.on_hand, 0) * COALESCE(v.cost, 0))::bigint AS value,
                v.reorder_level AS "reorderLevel", v.reorder_qty AS "reorderQty", s.name AS "supplierName", v.track_expiry AS "trackExpiry",
                p.active
           ${base} ORDER BY p.name LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(
        `SELECT COUNT(*)::int AS items, COALESCE(SUM(ROUND(GREATEST(x.on_hand, 0) * COALESCE(v.cost, 0))), 0)::bigint AS value,
                COUNT(*) FILTER (WHERE v.cost IS NULL AND x.on_hand > 0)::int AS "noCost" ${base}`,
        params,
      ),
    ]);
    return { items: list.rows, count: totals.rows[0].items, value: totals.rows[0].value, noCost: totals.rows[0].noCost };
  });

  app.get("/inventory/stock.csv", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const f = z.object({ storeId: z.string().uuid().optional() }).parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    if (f.storeId) params.push(f.storeId);
    const { rows } = await app.db.query(
      `SELECT p.name, v.barcode, v.sku, c.name AS category, p.uom, x.on_hand, x.incoming, v.cost,
              ROUND(GREATEST(x.on_hand, 0) * COALESCE(v.cost, 0))::bigint AS value, v.reorder_level, v.reorder_qty
         FROM variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
         CROSS JOIN LATERAL (SELECT ${ON_HAND(f.storeId ? "$2" : "")} AS on_hand, ${INCOMING(f.storeId ? "$2" : "")} AS incoming) x
        WHERE v.tenant_id = $1 AND (p.active OR x.on_hand <> 0) ORDER BY p.name`,
      params,
    );
    const csv = toCsv(
      ["name", "barcode", "sku", "category", "unit", "on_hand", "incoming", "cost", "value", "reorder_level", "reorder_qty"],
      rows.map((r) => [r.name, r.barcode, r.sku, r.category, r.uom, r.on_hand, r.incoming, money(r.cost), money(r.value), r.reorder_level, r.reorder_qty]),
    );
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="stock.csv"')
      .send(csv);
  });

  /** One product's stock in each store, its suppliers, lots and reorder settings. */
  app.get<{ Params: { variantId: string } }>("/inventory/items/:variantId", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT v.id AS "variantId", p.id AS "productId", p.name, p.name_ar AS "nameAr", p.uom, v.barcode, v.sku, v.cost, v.price,
              v.reorder_level AS "reorderLevel", v.reorder_qty AS "reorderQty", v.preferred_supplier_id AS "preferredSupplierId",
              v.track_expiry AS "trackExpiry"
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.tenant_id = $2`,
      [req.params.variantId, ctx.tenantId],
    );
    if (!rows[0]) throw notFound("Product");
    const [stores, suppliers, lots] = await Promise.all([
      app.db.query(
        `SELECT s.id AS "storeId", s.name, COALESCE(SUM(m.qty), 0) AS "onHand"
           FROM stores s LEFT JOIN stock_moves m ON m.store_id = s.id AND m.variant_id = $1
          WHERE s.tenant_id = $2 GROUP BY s.id ORDER BY s.code`,
        [req.params.variantId, ctx.tenantId],
      ),
      app.db.query(
        `SELECT si.supplier_id AS "supplierId", s.name, si.supplier_sku AS "supplierSku", si.unit_cost AS "unitCost", si.updated_at AS "updatedAt"
           FROM supplier_items si JOIN suppliers s ON s.id = si.supplier_id WHERE si.variant_id = $1 ORDER BY s.name`,
        [req.params.variantId],
      ),
      app.db.query(
        `SELECT l.id, l.code, l.expires_on::text AS "expiresOn", l.created_at AS "createdAt" FROM lots l
          WHERE l.variant_id = $1 ORDER BY l.expires_on NULLS LAST, l.created_at DESC LIMIT 50`,
        [req.params.variantId],
      ),
    ]);
    return { ...rows[0], stores: stores.rows, suppliers: suppliers.rows, lots: lots.rows };
  });

  app.put<{ Params: { variantId: string } }>("/inventory/items/:variantId", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = ItemSettingsSchema.parse(req.body);
    if (b.reorderLevel !== null && b.reorderQty !== null && b.reorderQty < b.reorderLevel) {
      throw bad("Order up to must be at least the reorder level");
    }
    return withTx(app.db, async (tx) => {
      await checkVariants(tx, ctx.tenantId, [req.params.variantId]);
      const supplierIds = new Set([...(b.suppliers ?? []).map((s) => s.supplierId), ...(b.preferredSupplierId ? [b.preferredSupplierId] : [])]);
      for (const id of supplierIds) await checkSupplier(tx, ctx.tenantId, id);
      await tx.query(
        `UPDATE variants SET reorder_level = $2, reorder_qty = $3, preferred_supplier_id = $4, track_expiry = $5 WHERE id = $1`,
        [req.params.variantId, b.reorderLevel, b.reorderQty, b.preferredSupplierId, b.trackExpiry],
      );
      if (b.suppliers) {
        await tx.query("DELETE FROM supplier_items WHERE variant_id = $1 AND NOT (supplier_id = ANY($2))", [
          req.params.variantId,
          b.suppliers.map((s) => s.supplierId),
        ]);
        for (const s of b.suppliers) {
          await tx.query(
            `INSERT INTO supplier_items (supplier_id, variant_id, supplier_sku, unit_cost) VALUES ($1, $2, $3, $4)
             ON CONFLICT (supplier_id, variant_id) DO UPDATE SET supplier_sku = EXCLUDED.supplier_sku, unit_cost = EXCLUDED.unit_cost, updated_at = now()`,
            [s.supplierId, req.params.variantId, empty(s.supplierSku), s.unitCost ?? null],
          );
        }
        if (b.preferredSupplierId && !b.suppliers.some((s) => s.supplierId === b.preferredSupplierId)) {
          await tx.query(`INSERT INTO supplier_items (supplier_id, variant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
            b.preferredSupplierId,
            req.params.variantId,
          ]);
        }
      }
      const { rows } = await tx.query("SELECT product_id FROM variants WHERE id = $1", [req.params.variantId]);
      await adminAudit(tx, ctx, "stock.settings", "product", rows[0].product_id, {
        reorderLevel: b.reorderLevel,
        reorderQty: b.reorderQty,
        trackExpiry: b.trackExpiry,
      });
      return { variantId: req.params.variantId };
    });
  });

  /** The stock ledger: every movement with the bill or document behind it. */
  app.get("/inventory/moves", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = Paging.extend({
      variantId: z.string().uuid().optional(),
      storeId: z.string().uuid().optional(),
      reason: z.enum(MOVE_REASONS).optional(),
    }).parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["m.tenant_id = $1"];
    if (f.variantId) where.push(`m.variant_id = $${params.push(f.variantId)}`);
    if (f.storeId) where.push(`m.store_id = $${params.push(f.storeId)}`);
    if (f.reason) where.push(`m.reason = $${params.push(f.reason)}`);
    const sql = `FROM stock_moves m WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      app.db.query(
        `SELECT m.id, m.at, m.reason, m.qty, m.unit_cost AS "unitCost", m.note, m.variant_id AS "variantId", p.name, p.uom,
                s.name AS "storeName", u.name AS "userName", l.code AS "lotCode", m.ref_id AS "refId",
                COALESCE(o.number, po.number, gr.number, t.number, sc.number) AS "refNumber",
                CASE WHEN o.id IS NOT NULL THEN 'order' WHEN gr.id IS NOT NULL THEN 'receipt' WHEN t.id IS NOT NULL THEN 'transfer'
                     WHEN sc.id IS NOT NULL THEN 'count' END AS "refKind",
                gr.po_id AS "poId"
           FROM stock_moves m JOIN variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
           JOIN stores s ON s.id = m.store_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN lots l ON l.id = m.lot_id
           LEFT JOIN orders o ON o.id = m.ref_id AND m.reason IN ('sale', 'refund')
           LEFT JOIN goods_receipts gr ON gr.id = m.ref_id AND m.reason = 'receive'
           LEFT JOIN purchase_orders po ON po.id = gr.po_id
           LEFT JOIN transfers t ON t.id = m.ref_id AND m.reason = 'transfer'
           LEFT JOIN stock_counts sc ON sc.id = m.ref_id AND m.reason = 'count'
          WHERE ${where.join(" AND ")} ORDER BY m.at DESC, m.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    ]);
    return { moves: list.rows, count: count.rows[0].n };
  });

  /** Corrections and write-offs (damaged, expired, stolen). */
  app.post("/inventory/adjustments", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = AdjustSchema.parse(req.body);
    return withTx(app.db, (tx) => adjustStock(tx, ctx, b));
  });

  /**
   * What to order for a store. Each product has a level to reorder at and a level to order up to,
   * set by hand or worked out from the last four weeks of sales, the supplier's lead time and the
   * days the order should last. Stock already ordered or on its way from another store counts.
   */
  app.get("/inventory/reorder", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = ReorderSchema.parse(req.query);
    await checkStore(app.db, ctx.tenantId, f.storeId);
    const { rows } = await app.db.query(
      `SELECT v.id AS "variantId", p.name, p.uom, v.barcode, v.cost, v.reorder_level AS "reorderLevel", v.reorder_qty AS "reorderQty",
              x.on_hand AS "onHand", x.incoming, x.sold,
              sup.id AS "supplierId", sup.name AS "supplierName", COALESCE(sup.lead_time_days, 3) AS "leadTimeDays",
              COALESCE(si.unit_cost, v.cost, 0) AS "unitCost"
         FROM variants v JOIN products p ON p.id = v.product_id
         CROSS JOIN LATERAL (
           SELECT ${ON_HAND("$2")} AS on_hand, ${INCOMING("$2")} AS incoming,
                  (SELECT COALESCE(-SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = v.id AND m.store_id = $2
                      AND m.reason IN ('sale', 'refund') AND m.at > now() - interval '${SALES_DAYS} days') AS sold) x
         LEFT JOIN LATERAL (
           SELECT s.id, s.name, s.lead_time_days FROM suppliers s
             LEFT JOIN supplier_items si2 ON si2.supplier_id = s.id AND si2.variant_id = v.id
            WHERE s.active AND (s.id = v.preferred_supplier_id OR si2.variant_id IS NOT NULL)
            ORDER BY (s.id = v.preferred_supplier_id) DESC, si2.unit_cost NULLS LAST, s.name LIMIT 1) sup ON true
         LEFT JOIN supplier_items si ON si.supplier_id = sup.id AND si.variant_id = v.id
        WHERE v.tenant_id = $1 AND p.active AND v.active
          AND (v.reorder_level IS NOT NULL OR v.reorder_qty IS NOT NULL OR x.sold > 0)`,
      [ctx.tenantId, f.storeId],
    );
    const lines = [];
    for (const r of rows) {
      const daily = Math.max(0, r.sold) / SALES_DAYS;
      const round = (n: number) => (r.uom === "unit" ? Math.ceil(n - 1e-9) : Math.ceil(n * 1000) / 1000);
      const min = r.reorderLevel ?? round(daily * r.leadTimeDays);
      const target = r.reorderQty ?? Math.max(round(min * 2), round(daily * (r.leadTimeDays + f.coverDays)));
      const available = r.onHand + r.incoming;
      if (min <= 0 && target <= 0) continue;
      if (available > min) continue;
      const qty = round(target - available);
      if (qty <= 0) continue;
      lines.push({
        variantId: r.variantId,
        name: r.name,
        uom: r.uom,
        barcode: r.barcode,
        onHand: r.onHand,
        incoming: r.incoming,
        dailySales: Math.round(daily * 100) / 100,
        reorderAt: min,
        orderUpTo: target,
        auto: r.reorderLevel === null,
        qty,
        unitCost: r.unitCost,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
      });
    }
    lines.sort((a, b) => (a.supplierName ?? "￿").localeCompare(b.supplierName ?? "￿") || a.name.localeCompare(b.name));
    return { storeId: f.storeId, coverDays: f.coverDays, salesDays: SALES_DAYS, lines };
  });

  /** Turns chosen suggestions into one draft purchase order per supplier. */
  app.post("/inventory/reorder/purchase-orders", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = CreatePosSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      await checkStore(tx, ctx.tenantId, b.storeId);
      const variants = await checkVariants(tx, ctx.tenantId, b.lines.map((l) => l.variantId));
      const bySupplier = new Map<string, typeof b.lines>();
      for (const l of b.lines) {
        checkWhole(variants.get(l.variantId)!, l.qty);
        bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), l]);
      }
      const created = [];
      for (const [supplierId, lines] of bySupplier) {
        const sup = await checkSupplier(tx, ctx.tenantId, supplierId);
        const id = randomUUID();
        const number = await nextNumber(tx, ctx.tenantId, "po");
        await tx.query(
          `INSERT INTO purchase_orders (id, tenant_id, number, supplier_id, store_id, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, 'From reorder suggestions', $6)`,
          [id, ctx.tenantId, number, supplierId, b.storeId, ctx.userId],
        );
        for (const [i, l] of lines.entries()) {
          await tx.query(
            `INSERT INTO purchase_order_lines (id, po_id, line_no, variant_id, qty_ordered, unit_cost)
             SELECT $1, $2, $3, v.id, $5, COALESCE(si.unit_cost, v.cost, 0) FROM variants v
               LEFT JOIN supplier_items si ON si.variant_id = v.id AND si.supplier_id = $6 WHERE v.id = $4`,
            [randomUUID(), id, i + 1, l.variantId, l.qty, supplierId],
          );
        }
        await adminAudit(tx, ctx, "po.create", "purchase_order", id, { number, supplier: sup.name, lines: lines.length, source: "reorder" });
        created.push({ id, number, supplierName: sup.name, lines: lines.length });
      }
      return { orders: created };
    });
  });

  /**
   * Batches with an expiry date that are probably still on the shelf. Sales do not say which
   * batch was sold, so the oldest delivery is assumed to sell first; write-offs of a batch count exactly.
   */
  app.get("/inventory/expiry", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = z
      .object({ storeId: z.string().uuid().optional(), days: z.coerce.number().int().min(0).max(365).default(30) })
      .parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    if (f.storeId) params.push(f.storeId);
    const { rows } = await app.db.query(
      `SELECT l.id AS "lotId", l.code, l.expires_on::text AS "expiresOn", l.variant_id AS "variantId", p.name, p.uom, v.cost,
              m.store_id AS "storeId", s.name AS "storeName", SUM(m.qty) AS "lotQty", MIN(m.at) AS "receivedAt",
              (SELECT COALESCE(SUM(a.qty), 0) FROM stock_moves a WHERE a.variant_id = l.variant_id AND a.store_id = m.store_id) AS "storeOnHand"
         FROM lots l JOIN stock_moves m ON m.lot_id = l.id JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
         JOIN stores s ON s.id = m.store_id
        WHERE l.tenant_id = $1 AND l.expires_on IS NOT NULL ${f.storeId ? "AND m.store_id = $2" : ""}
        GROUP BY l.id, p.id, v.id, m.store_id, s.id`,
      params,
    );
    // Fill what is on hand from the newest batch backwards: the oldest batches are assumed sold.
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.storeId}:${r.variantId}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const today = new Date().toISOString().slice(0, 10);
    const limit = new Date(Date.now() + f.days * 86_400_000).toISOString().slice(0, 10);
    const lots = [];
    for (const g of groups.values()) {
      g.sort((a, b) => +new Date(b.receivedAt) - +new Date(a.receivedAt));
      let left = Math.max(0, g[0]!.storeOnHand);
      for (const r of g) {
        const remaining = Math.min(Math.max(0, r.lotQty), left);
        left -= remaining;
        if (remaining <= 0 || r.expiresOn > limit) continue;
        const daysLeft = Math.round((Date.parse(r.expiresOn) - Date.parse(today)) / 86_400_000);
        lots.push({
          lotId: r.lotId,
          code: r.code,
          expiresOn: r.expiresOn,
          daysLeft,
          expired: daysLeft < 0,
          variantId: r.variantId,
          name: r.name,
          uom: r.uom,
          storeId: r.storeId,
          storeName: r.storeName,
          remaining: Math.round(remaining * 1000) / 1000,
          value: Math.round(remaining * (r.cost ?? 0)),
        });
      }
    }
    lots.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.name.localeCompare(b.name));
    return { days: f.days, lots };
  });
}
