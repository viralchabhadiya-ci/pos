import type { Db, Tx } from "../db.js";

/**
 * The shapes the public API returns and webhooks send. They are a stable contract with other
 * people's code, so they are written out field by field instead of passing database rows on.
 * Money is in fils (1 AED = 100 fils); quantities have up to 3 decimals.
 */

export const PRODUCT_SQL = `
  SELECT p.id, v.id AS "variantId", p.name, p.name_ar AS "nameAr", p.category_id AS "categoryId", c.name AS "categoryName",
         p.uom, p.tax_id AS "taxId", t.rate_bp AS "taxRateBp", v.price, v.cost, v.barcode, v.extra_barcodes AS "extraBarcodes",
         v.sku, v.plu, v.reorder_level AS "reorderLevel", p.active, p.updated_at AS "updatedAt"
    FROM products p
    JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN taxes t ON t.id = p.tax_id`;

export const CUSTOMER_SQL = `
  SELECT c.id, c.name, c.phone, c.email, c.trn, c.price_list_id AS "priceListId", c.points, c.updated_at AS "updatedAt"
    FROM customers c`;

export async function loadProduct(db: Db | Tx, tenantId: string, id: string) {
  const { rows } = await db.query(`${PRODUCT_SQL} WHERE p.id = $1 AND p.tenant_id = $2`, [id, tenantId]);
  return rows[0] ?? null;
}

export async function loadCustomer(db: Db | Tx, tenantId: string, id: string) {
  const { rows } = await db.query(`${CUSTOMER_SQL} WHERE c.id = $1 AND c.tenant_id = $2`, [id, tenantId]);
  return rows[0] ?? null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Orders with their lines and payments, in the order of `ids`. */
export async function loadOrders(db: Db | Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return [];
  // One after another: inside a transaction they share one connection.
  const orders = await db.query(
    `SELECT o.id, o.number, o.refund_of_order_id, o.store_id, s.code AS store_code, o.register_id, o.session_id,
              o.cashier_id, u.name AS cashier_name, o.customer_id, cu.name AS customer_name, t.currency,
              o.amount_total, o.discount_total, o.subtotal_net, o.tax_total, o.total, o.cash_rounding, o.created_at, o.synced_at
         FROM orders o JOIN stores s ON s.id = o.store_id JOIN tenants t ON t.id = o.tenant_id
         JOIN users u ON u.id = o.cashier_id LEFT JOIN customers cu ON cu.id = o.customer_id
        WHERE o.tenant_id = $1 AND o.id = ANY($2)`,
    [tenantId, ids],
  );
  const lines = await db.query(
    `SELECT l.order_id, l.id, l.line_no, l.variant_id, v.product_id, v.sku, v.barcode, l.name, l.qty, l.unit_price,
              l.discount_bp, l.line_discount, l.order_discount, l.promo_discount, l.promotion_id, l.tax_id, l.tax_rate_bp,
              l.net, l.tax, l.gross, l.gift_card_code, l.note
         FROM order_lines l LEFT JOIN variants v ON v.id = l.variant_id
        WHERE l.order_id = ANY($1) ORDER BY l.order_id, l.line_no`,
    [ids],
  );
  const payments = await db.query(
    `SELECT p.order_id, p.id, p.kind, m.name AS method, p.amount, p.tendered, p.change, p.reference, p.points
         FROM payments p JOIN payment_methods m ON m.id = p.method_id WHERE p.order_id = ANY($1) ORDER BY p.order_id, p.id`,
    [ids],
  );
  const linesBy = new Map<string, unknown[]>();
  for (const l of lines.rows) {
    linesBy.set(l.order_id, [
      ...(linesBy.get(l.order_id) ?? []),
      {
        id: l.id,
        lineNo: l.line_no,
        productId: l.product_id,
        variantId: l.variant_id,
        sku: l.sku,
        barcode: l.barcode,
        name: l.name,
        qty: l.qty,
        unitPrice: l.unit_price,
        discountBp: l.discount_bp,
        discount: l.line_discount + l.order_discount + l.promo_discount,
        promotionId: l.promotion_id,
        taxId: l.tax_id,
        taxRateBp: l.tax_rate_bp,
        net: l.net,
        tax: l.tax,
        gross: l.gross,
        giftCardCode: l.gift_card_code,
        note: l.note,
      },
    ]);
  }
  const paymentsBy = new Map<string, unknown[]>();
  for (const p of payments.rows) {
    paymentsBy.set(p.order_id, [
      ...(paymentsBy.get(p.order_id) ?? []),
      {
        id: p.id,
        kind: p.kind,
        method: p.method,
        amount: p.amount,
        tendered: p.tendered,
        change: p.change,
        reference: p.reference,
        points: p.points,
      },
    ]);
  }
  const byId = new Map(
    orders.rows.map((o) => [
      o.id,
      {
        id: o.id,
        number: o.number,
        type: o.refund_of_order_id ? "refund" : "sale",
        refundOfOrderId: o.refund_of_order_id,
        storeId: o.store_id,
        storeCode: o.store_code,
        registerId: o.register_id,
        sessionId: o.session_id,
        cashier: { id: o.cashier_id, name: o.cashier_name },
        customer: o.customer_id ? { id: o.customer_id, name: o.customer_name } : null,
        currency: o.currency,
        amountTotal: o.amount_total,
        discountTotal: o.discount_total,
        subtotalNet: o.subtotal_net,
        taxTotal: o.tax_total,
        total: o.total,
        cashRounding: o.cash_rounding,
        createdAt: iso(o.created_at),
        syncedAt: iso(o.synced_at),
        lines: linesBy.get(o.id) ?? [],
        payments: paymentsBy.get(o.id) ?? [],
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((o) => !!o);
}

export async function loadOrder(db: Db | Tx, tenantId: string, id: string) {
  return (await loadOrders(db, tenantId, [id]))[0] ?? null;
}
