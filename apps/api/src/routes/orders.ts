import { checkPayments, OrderBatchSchema, priceOrder, type OrderSync, type TaxRate } from "@pos/core";
import type { FastifyInstance } from "fastify";
import type { DeviceContext } from "../app.js";
import { withTx, type Tx } from "../db.js";
import { HttpError } from "../errors.js";
import { audit } from "./audit.js";

type Result =
  | { id: string; status: "created"; totalsMismatch: boolean }
  | { id: string; status: "duplicate" }
  | { id: string; status: "rejected"; error: string; message: string };

const reject = (code: string, message: string) => new HttpError(422, code, message);

/**
 * Stores one order sent by a till. The server recomputes every total with the shared
 * pricing engine and stores its own numbers. A mismatch with the till's totals is
 * accepted (the customer has already paid) but flagged for review.
 */
async function storeOrder(tx: Tx, device: DeviceContext, order: OrderSync): Promise<Result> {
  const existing = await tx.query("SELECT id FROM orders WHERE id = $1", [order.id]);
  if (existing.rows[0]) return { id: order.id, status: "duplicate" };

  if (order.registerId !== device.registerId) throw reject("wrong_register", "Order belongs to another register");
  const session = await tx.query("SELECT id FROM sessions WHERE id = $1 AND register_id = $2", [
    order.sessionId,
    device.registerId,
  ]);
  if (!session.rows[0]) throw reject("unknown_session", "Session not found for this register");

  const store = (await tx.query("SELECT cash_rounding_step FROM stores WHERE id = $1", [device.storeId])).rows[0];

  const variantIds = [...new Set(order.lines.map((l) => l.variantId))];
  const variants = await tx.query("SELECT id FROM variants WHERE tenant_id = $1 AND id = ANY($2)", [
    device.tenantId,
    variantIds,
  ]);
  if (variants.rowCount !== variantIds.length) throw reject("unknown_variant", "Order has an unknown product");

  const taxIds = [...new Set(order.lines.map((l) => l.taxId).filter((t): t is string => !!t))];
  const taxRows = (
    await tx.query(
      `SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded"
         FROM taxes WHERE tenant_id = $1 AND id = ANY($2)`,
      [device.tenantId, taxIds],
    )
  ).rows as TaxRate[];
  if (taxRows.length !== taxIds.length) throw reject("unknown_tax", "Order has an unknown tax");
  const taxes = Object.fromEntries(taxRows.map((t) => [t.id, t]));

  const methodIds = [...new Set(order.payments.map((p) => p.methodId))];
  const methods = await tx.query("SELECT id, kind FROM payment_methods WHERE tenant_id = $1 AND id = ANY($2)", [
    device.tenantId,
    methodIds,
  ]);
  const methodKind = new Map(methods.rows.map((m) => [m.id as string, m.kind as string]));
  for (const p of order.payments) {
    if (methodKind.get(p.methodId) !== p.kind) throw reject("bad_payment_method", "Unknown payment method");
  }

  const isRefund = order.refundOfOrderId !== null;
  if (isRefund) await checkRefund(tx, device, order);
  else if (order.lines.some((l) => l.qty < 0)) throw reject("negative_qty", "Sales cannot have negative quantities");

  const totals = priceOrder(order.lines, { taxes, orderDiscountBp: order.orderDiscountBp });
  const pay = checkPayments(totals.total, order.payments, store.cash_rounding_step);
  if (!pay.complete) throw reject("unpaid", `Payments do not cover the total (remaining ${pay.remaining})`);
  const mismatch =
    totals.total !== order.clientTotals.total ||
    totals.taxTotal !== order.clientTotals.taxTotal ||
    totals.subtotalNet !== order.clientTotals.subtotalNet;

  await tx.query(
    `INSERT INTO orders (id, tenant_id, store_id, register_id, session_id, number, cashier_id, customer_id,
       refund_of_order_id, order_discount_bp, amount_total, discount_total, subtotal_net, tax_total, total,
       cash_rounding, client_total, totals_mismatch, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      order.id, device.tenantId, device.storeId, device.registerId, order.sessionId, order.number,
      order.cashierId, order.customerId, order.refundOfOrderId, order.orderDiscountBp, totals.amountTotal,
      totals.discountTotal, totals.subtotalNet, totals.taxTotal, totals.total, pay.cashRounding,
      order.clientTotals.total, mismatch, order.createdAt,
    ],
  );

  for (const [i, l] of totals.lines.entries()) {
    const src = order.lines[i]!;
    await tx.query(
      `INSERT INTO order_lines (id, order_id, line_no, variant_id, name, qty, unit_price, discount_bp,
         line_discount, order_discount, tax_id, tax_rate_bp, net, tax, gross, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        l.id, order.id, i + 1, l.variantId, l.name, l.qty, l.unitPrice, l.discountBp ?? 0, l.lineDiscount,
        l.orderDiscount, l.taxId, l.taxId ? taxes[l.taxId]!.rateBp : null, l.net, l.tax, l.gross, src.note ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason, ref_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [device.tenantId, device.storeId, l.variantId, -l.qty, isRefund ? "refund" : "sale", order.id, order.createdAt],
    );
  }

  for (const p of order.payments) {
    const change = Math.max(0, (p.tendered ?? p.amount) - p.amount);
    await tx.query(
      `INSERT INTO payments (id, order_id, method_id, kind, amount, tendered, change, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.id, order.id, p.methodId, p.kind, p.amount, p.tendered ?? null, change, p.reference ?? null],
    );
  }

  if (mismatch) {
    await audit(tx, device, order.cashierId, "order.totals_mismatch", "order", order.id, {
      client: order.clientTotals,
      server: { subtotalNet: totals.subtotalNet, taxTotal: totals.taxTotal, total: totals.total },
    });
  }
  if (totals.discountTotal > 0) {
    await audit(tx, device, order.cashierId, "order.discount", "order", order.id, { discount: totals.discountTotal });
  }
  return { id: order.id, status: "created", totalsMismatch: mismatch };
}

/** A refund must point at a sale from this tenant and cannot return more than was sold. */
async function checkRefund(tx: Tx, device: DeviceContext, order: OrderSync) {
  const original = await tx.query("SELECT id FROM orders WHERE id = $1 AND tenant_id = $2 AND refund_of_order_id IS NULL", [
    order.refundOfOrderId,
    device.tenantId,
  ]);
  if (!original.rows[0]) throw reject("unknown_original", "Original sale not found (it may not have synced yet)");
  if (order.lines.some((l) => l.qty > 0)) throw reject("positive_qty", "Refund lines must have negative quantities");

  const { rows } = await tx.query(
    `SELECT ol.variant_id,
            SUM(ol.qty) FILTER (WHERE o.id = $1) AS sold,
            COALESCE(SUM(-ol.qty) FILTER (WHERE o.refund_of_order_id = $1), 0) AS refunded
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE o.id = $1 OR o.refund_of_order_id = $1
      GROUP BY ol.variant_id`,
    [order.refundOfOrderId],
  );
  const room = new Map(rows.map((r) => [r.variant_id as string, (r.sold ?? 0) - r.refunded]));
  const asked = new Map<string, number>();
  for (const l of order.lines) asked.set(l.variantId, (asked.get(l.variantId) ?? 0) - l.qty);
  for (const [variantId, qty] of asked) {
    if (qty > (room.get(variantId) ?? 0) + 1e-9) throw reject("over_refund", "Refund is more than what was sold");
  }
}

export async function orderRoutes(app: FastifyInstance) {
  /**
   * The till's outbox posts orders in batches. Each order is stored in its own
   * transaction and keyed by its client UUID, so retries are always safe.
   */
  app.post("/orders/batch", async (req) => {
    const device = await app.authenticate(req);
    const { orders } = OrderBatchSchema.parse(req.body);
    const results: Result[] = [];
    for (const order of orders) {
      try {
        results.push(await withTx(app.db, (tx) => storeOrder(tx, device, order)));
      } catch (err) {
        if (err instanceof HttpError) {
          results.push({ id: order.id, status: "rejected", error: err.code, message: err.message });
        } else if ((err as { code?: string }).code === "23505") {
          // A parallel request stored the same order first.
          results.push({ id: order.id, status: "duplicate" });
        } else {
          throw err;
        }
      }
    }
    return { results };
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (req) => {
    const device = await app.authenticate(req);
    const { rows } = await app.db.query("SELECT * FROM orders WHERE id = $1 AND tenant_id = $2", [
      req.params.id,
      device.tenantId,
    ]);
    if (!rows[0]) throw new HttpError(404, "not_found", "Order not found");
    const lines = await app.db.query("SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no", [req.params.id]);
    const payments = await app.db.query("SELECT * FROM payments WHERE order_id = $1", [req.params.id]);
    return { ...rows[0], lines: lines.rows, payments: payments.rows };
  });

  /** Finds a sale by receipt number for refunds. */
  app.get<{ Querystring: { number?: string } }>("/orders", async (req) => {
    const device = await app.authenticate(req);
    const number = String(req.query.number ?? "").trim();
    if (!number) return { orders: [] };
    const { rows } = await app.db.query(
      `SELECT id, number, total, created_at FROM orders
        WHERE tenant_id = $1 AND number = $2 AND refund_of_order_id IS NULL`,
      [device.tenantId, number],
    );
    return { orders: rows };
  });
}
