import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { money, toCsv } from "../../csv.js";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { storeParam } from "../../stores.js";
import { adminAudit } from "./common.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
const RangeSchema = z.object({ from: Day, to: Day, format: z.enum(["json", "csv"]).default("json") });
const MAX_DAYS = 400;

/** A device counts as online when it has talked to the cloud in the last few minutes. */
const ONLINE_MINUTES = 5;

const StoreSettingsSchema = z.object({
  stores: z
    .array(
      z.object({
        storeId: z.string().uuid(),
        /** false: the store does not sell this product; its tills get it switched off. */
        sold: z.boolean(),
        /** This store's price in fils, or null for the product's own price. */
        price: z.number().int().min(0).max(100_000_000).nullable(),
      }),
    )
    .min(1)
    .max(500),
});

function days(from: string, to: string) {
  const n = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (n < 0) throw new HttpError(400, "bad_request", "The start date is after the end date");
  if (n > MAX_DAYS) throw new HttpError(400, "bad_request", `Pick at most ${MAX_DAYS} days`);
  return n + 1;
}

/** A share of an amount in basis points, rounded half away from zero like every other amount. */
export function share(amount: number, bp: number) {
  return Math.sign(amount) * Math.round((Math.abs(amount) * bp) / 10_000);
}

/** Head office: the central catalog per store, all stores side by side, franchise royalties. */
export async function hqRoutes(app: FastifyInstance) {
  /**
   * How one product is sold in each store: whether the store sells it, the price it sells at
   * (the store's price list or the product's own price), and stock on hand.
   */
  app.get<{ Params: { id: string } }>("/products/:id/stores", async (req) => {
    const ctx = await app.authAdmin(req);
    const product = await app.db.query(
      `SELECT p.id, p.name, v.id AS "variantId", v.price FROM products p
         JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
        WHERE p.id = $1 AND p.tenant_id = $2`,
      [req.params.id, ctx.tenantId],
    );
    const p = product.rows[0];
    if (!p) throw notFound("Product");
    const { rows } = await app.db.query(
      `SELECT s.id AS "storeId", s.code, s.name, s.ownership,
              NOT EXISTS (SELECT 1 FROM store_hidden_products h WHERE h.store_id = s.id AND h.product_id = $2) AS sold,
              s.price_list_id AS "priceListId", pl.name AS "priceListName",
              (SELECT COUNT(*)::int FROM stores o WHERE o.price_list_id = s.price_list_id AND o.id <> s.id)
                + (SELECT COUNT(*)::int FROM customers c WHERE c.price_list_id = s.price_list_id) AS "listSharedWith",
              i.price AS "storePrice",
              (SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.store_id = s.id AND m.variant_id = $3) AS "onHand"
         FROM stores s
         LEFT JOIN price_lists pl ON pl.id = s.price_list_id
         LEFT JOIN price_list_items i ON i.price_list_id = s.price_list_id AND i.variant_id = $3 AND i.active
        WHERE s.tenant_id = $1 AND ($4::uuid[] IS NULL OR s.id = ANY($4::uuid[]))
        ORDER BY s.code`,
      [ctx.tenantId, p.id, p.variantId, ctx.storeIds],
    );
    return {
      productId: p.id,
      name: p.name,
      basePrice: p.price,
      stores: rows.map((r) => ({ ...r, price: r.storePrice ?? p.price, onHand: Number(r.onHand) })),
    };
  });

  /**
   * Sets where a product is sold and its price per store. A store price goes on the store's
   * price list; a store without one gets its own list. A list shared by several stores is
   * changed on the Price lists page instead, so one store's edit never moves another's price.
   */
  app.put<{ Params: { id: string } }>("/products/:id/stores", async (req) => {
    const ctx = await app.authAdmin(req);
    const body = StoreSettingsSchema.parse(req.body);
    const ids = body.stores.map((s) => s.storeId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "bad_request", "A store is listed twice");
    await withTx(app.db, async (tx) => {
      const product = await tx.query(
        `SELECT p.id, v.id AS "variantId", v.price FROM products p
           JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
          WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p`,
        [req.params.id, ctx.tenantId],
      );
      const p = product.rows[0];
      if (!p) throw notFound("Product");
      const stores = await tx.query(
        `SELECT s.id, s.code, s.name, s.price_list_id,
                (SELECT COUNT(*)::int FROM stores o WHERE o.price_list_id = s.price_list_id AND o.id <> s.id)
                  + (SELECT COUNT(*)::int FROM customers c WHERE c.price_list_id = s.price_list_id) AS shared,
                i.price AS current
           FROM stores s LEFT JOIN price_list_items i ON i.price_list_id = s.price_list_id AND i.variant_id = $3 AND i.active
          WHERE s.tenant_id = $1 AND s.id = ANY($2::uuid[]) FOR UPDATE OF s`,
        [ctx.tenantId, ids, p.variantId],
      );
      if (stores.rows.length !== ids.length) throw new HttpError(400, "bad_request", "That store does not exist");
      const byId = new Map(stores.rows.map((s) => [s.id as string, s]));
      let hiddenChanged = false;
      for (const want of body.stores) {
        const s = byId.get(want.storeId)!;
        // Hide or show the product at this store.
        const res = want.sold
          ? await tx.query("DELETE FROM store_hidden_products WHERE store_id = $1 AND product_id = $2", [s.id, p.id])
          : await tx.query(
              `INSERT INTO store_hidden_products (store_id, product_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [s.id, p.id, ctx.tenantId],
            );
        if (res.rowCount) hiddenChanged = true;

        // The price: the product's own price clears the store's override.
        const price = want.price === null || want.price === p.price ? null : want.price;
        const current: number | null = s.current ?? null;
        if (price === current) continue;
        if (s.shared > 0) {
          throw new HttpError(
            409,
            "price_list_shared",
            `${s.name} shares its price list with other stores or customers. Change this price on the Price lists page.`,
          );
        }
        let listId: string | null = s.price_list_id;
        if (!listId) {
          if (price === null) continue;
          listId = randomUUID();
          await tx.query("INSERT INTO price_lists (id, tenant_id, name) VALUES ($1, $2, $3)", [
            listId,
            ctx.tenantId,
            await freeListName(tx, ctx.tenantId, `${s.name} prices`),
          ]);
          await tx.query("UPDATE stores SET price_list_id = $2, updated_at = now() WHERE id = $1", [s.id, listId]);
        }
        if (price === null) {
          await tx.query(
            "UPDATE price_list_items SET active = false, updated_at = now() WHERE price_list_id = $1 AND variant_id = $2",
            [listId, p.variantId],
          );
        } else {
          await tx.query(
            `INSERT INTO price_list_items (price_list_id, variant_id, tenant_id, price, active, updated_at)
             VALUES ($1, $2, $3, $4, true, now())
             ON CONFLICT (price_list_id, variant_id) DO UPDATE SET price = excluded.price, active = true, updated_at = now()`,
            [listId, p.variantId, ctx.tenantId, price],
          );
        }
      }
      // Tills learn about a product leaving or joining their range from the product row.
      if (hiddenChanged) await tx.query("UPDATE products SET updated_at = now() WHERE id = $1", [p.id]);
      await adminAudit(tx, ctx, "product.stores", "product", p.id, { stores: body.stores });
    });
    return { id: req.params.id };
  });

  /**
   * All stores side by side for a period: sales against the period before, stock value, goods
   * in transit and whether the tills are online. A store manager sees their own stores.
   */
  app.get("/hq/overview", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = RangeSchema.parse(req.query);
    const n = days(q.from, q.to);
    const stores = storeParam(ctx);
    const p = [ctx.tenantId, stores, q.from, q.to];
    const local = "(o.created_at AT TIME ZONE s.timezone)::date";
    const [list, prev, trend, stock, transit, devices] = await Promise.all([
      app.db.query(
        `SELECT s.id, s.code, s.name, s.ownership, s.franchisee,
                COUNT(o.id) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS bills,
                COUNT(o.id) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS refunds,
                COALESCE(-SUM(o.total) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS "refundTotal",
                COALESCE(SUM(o.total), 0)::int AS total, COALESCE(SUM(o.subtotal_net), 0)::int AS net,
                COALESCE(SUM(o.tax_total), 0)::int AS vat, COALESCE(SUM(o.discount_total), 0)::int AS discounts,
                MAX(o.created_at) AS "lastSaleAt"
           FROM stores s LEFT JOIN orders o ON o.store_id = s.id AND ${local} BETWEEN $3::date AND $4::date
          WHERE s.tenant_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
          GROUP BY s.id ORDER BY s.code`,
        p,
      ),
      // The same number of days just before, for the change in sales.
      app.db.query(
        `SELECT o.store_id AS id, SUM(o.total)::int AS total
           FROM orders o JOIN stores s ON s.id = o.store_id
          WHERE o.tenant_id = $1 AND ($2::uuid[] IS NULL OR o.store_id = ANY($2::uuid[]))
            AND ${local} BETWEEN $3::date - $4::int AND $3::date - 1
          GROUP BY 1`,
        [ctx.tenantId, stores, q.from, n],
      ),
      app.db.query(
        `SELECT to_char(${local}, 'YYYY-MM-DD') AS date, o.store_id AS "storeId", SUM(o.total)::int AS total
           FROM orders o JOIN stores s ON s.id = o.store_id
          WHERE o.tenant_id = $1 AND ($2::uuid[] IS NULL OR o.store_id = ANY($2::uuid[]))
            AND ${local} BETWEEN $3::date AND $4::date
          GROUP BY 1, 2 ORDER BY 1`,
        p,
      ),
      // Stock at cost; products without a cost count as zero and are counted separately.
      app.db.query(
        `SELECT x.store_id AS id, ROUND(SUM(GREATEST(x.qty, 0) * COALESCE(v.cost, 0)))::bigint AS value,
                COUNT(*) FILTER (WHERE x.qty > 0 AND v.cost IS NULL)::int AS "noCost"
           FROM (SELECT m.store_id, m.variant_id, SUM(m.qty) AS qty FROM stock_moves m
                  WHERE m.tenant_id = $1 AND ($2::uuid[] IS NULL OR m.store_id = ANY($2::uuid[])) GROUP BY 1, 2) x
           JOIN variants v ON v.id = x.variant_id
          GROUP BY 1`,
        [ctx.tenantId, stores],
      ),
      app.db.query(
        `SELECT s.id,
                (SELECT COUNT(*)::int FROM transfers t WHERE t.to_store_id = s.id AND t.status = 'sent') AS incoming,
                (SELECT COUNT(*)::int FROM transfers t WHERE t.from_store_id = s.id AND t.status = 'draft') AS "toSend"
           FROM stores s WHERE s.tenant_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))`,
        [ctx.tenantId, stores],
      ),
      app.db.query(
        `SELECT r.store_id AS id, COUNT(DISTINCT r.id)::int AS registers,
                COUNT(d.id) FILTER (WHERE d.role = 'till')::int AS tills,
                COUNT(d.id) FILTER (WHERE d.role = 'till' AND d.last_seen_at > now() - make_interval(mins => $3))::int AS online,
                (SELECT COUNT(*)::int FROM sessions se JOIN registers r2 ON r2.id = se.register_id
                  WHERE r2.store_id = r.store_id AND se.state = 'open') AS "openShifts"
           FROM registers r JOIN stores s ON s.id = r.store_id
           LEFT JOIN devices d ON d.register_id = r.id AND d.revoked_at IS NULL
          WHERE s.tenant_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
          GROUP BY r.store_id`,
        [ctx.tenantId, stores, ONLINE_MINUTES],
      ),
    ]);
    const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const prevBy = by(prev.rows);
    const stockBy = by(stock.rows);
    const transitBy = by(transit.rows);
    const devBy = by(devices.rows);
    const rows = list.rows.map((s) => {
      const previous = prevBy.get(s.id)?.total ?? 0;
      const st = stockBy.get(s.id);
      const dv = devBy.get(s.id);
      return {
        ...s,
        averageBill: s.bills ? Math.round((s.total + s.refundTotal) / s.bills) : 0,
        previousTotal: previous,
        change: previous > 0 ? Math.round(((s.total - previous) / previous) * 1000) / 10 : null,
        stockValue: Number(st?.value ?? 0),
        stockNoCost: st?.noCost ?? 0,
        incomingTransfers: transitBy.get(s.id)?.incoming ?? 0,
        transfersToSend: transitBy.get(s.id)?.toSend ?? 0,
        registers: dv?.registers ?? 0,
        tills: dv?.tills ?? 0,
        tillsOnline: dv?.online ?? 0,
        openShifts: dv?.openShifts ?? 0,
      };
    });
    const sum = (k: "bills" | "refunds" | "refundTotal" | "total" | "net" | "vat" | "discounts" | "previousTotal" | "stockValue") =>
      rows.reduce((t, r) => t + (r[k] as number), 0);
    const totals = {
      bills: sum("bills"),
      refunds: sum("refunds"),
      refundTotal: sum("refundTotal"),
      total: sum("total"),
      net: sum("net"),
      vat: sum("vat"),
      discounts: sum("discounts"),
      previousTotal: sum("previousTotal"),
      stockValue: sum("stockValue"),
      averageBill: sum("bills") ? Math.round((sum("total") + sum("refundTotal")) / sum("bills")) : 0,
      change: sum("previousTotal") > 0 ? Math.round(((sum("total") - sum("previousTotal")) / sum("previousTotal")) * 1000) / 10 : null,
    };
    if (q.format === "csv") {
      const csv = toCsv(
        ["Store code", "Store", "Type", "Bills", "Refunds", "Refunded", "Net", "VAT", "Total", "Average bill", "Previous period", "Change %", "Stock value"],
        rows.map((r) => [
          r.code, r.name, r.ownership, r.bills, r.refunds, money(r.refundTotal), money(r.net), money(r.vat), money(r.total),
          money(r.averageBill), money(r.previousTotal), r.change, money(r.stockValue),
        ]),
      );
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="stores-${q.from}-to-${q.to}.csv"`)
        .send(csv);
    }
    return { from: q.from, to: q.to, days: n, stores: rows, totals, trend: trend.rows };
  });

  /**
   * What each franchise store owes head office for a period: royalty and marketing fee as a
   * share of net sales before VAT. Refunds reduce the base; gift cards sold are not sales.
   */
  app.get("/reports/royalties", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = RangeSchema.parse(req.query);
    days(q.from, q.to);
    const { rows } = await app.db.query(
      `SELECT s.id, s.code, s.name, s.franchisee, s.royalty_bp AS "royaltyBp", s.marketing_fee_bp AS "marketingFeeBp",
              COALESCE(SUM(ol.net) FILTER (WHERE o.refund_of_order_id IS NULL), 0)::int AS sales,
              COALESCE(-SUM(ol.net) FILTER (WHERE o.refund_of_order_id IS NOT NULL), 0)::int AS refunds,
              COALESCE(SUM(ol.net), 0)::int AS net
         FROM stores s
         LEFT JOIN orders o ON o.store_id = s.id AND (o.created_at AT TIME ZONE s.timezone)::date BETWEEN $2::date AND $3::date
         LEFT JOIN order_lines ol ON ol.order_id = o.id AND ol.gift_card_code IS NULL
        WHERE s.tenant_id = $1 AND s.ownership = 'franchise'
        GROUP BY s.id ORDER BY s.code`,
      [ctx.tenantId, q.from, q.to],
    );
    const stores = rows.map((r) => {
      const royalty = share(r.net, r.royaltyBp);
      const marketingFee = share(r.net, r.marketingFeeBp);
      return { ...r, royalty, marketingFee, due: royalty + marketingFee };
    });
    const totals = stores.reduce(
      (t, r) => ({ net: t.net + r.net, royalty: t.royalty + r.royalty, marketingFee: t.marketingFee + r.marketingFee, due: t.due + r.due }),
      { net: 0, royalty: 0, marketingFee: 0, due: 0 },
    );
    if (q.format === "csv") {
      const csv = toCsv(
        ["Store code", "Store", "Franchisee", "Sales net", "Refunds net", "Royalty base", "Royalty %", "Royalty", "Marketing fee %", "Marketing fee", "Total due"],
        stores.map((r) => [
          r.code, r.name, r.franchisee, money(r.sales), money(r.refunds), money(r.net), (r.royaltyBp / 100).toFixed(2), money(r.royalty),
          (r.marketingFeeBp / 100).toFixed(2), money(r.marketingFee), money(r.due),
        ]),
      );
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="royalties-${q.from}-to-${q.to}.csv"`)
        .send(csv);
    }
    return { from: q.from, to: q.to, stores, totals };
  });
}

async function freeListName(tx: { query: (sql: string, p: unknown[]) => Promise<{ rowCount: number | null }> }, tenantId: string, base: string) {
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    const { rowCount } = await tx.query("SELECT 1 FROM price_lists WHERE tenant_id = $1 AND name = $2", [tenantId, name]);
    if (!rowCount) return name;
  }
  return `${base} ${randomUUID().slice(0, 6)}`;
}
