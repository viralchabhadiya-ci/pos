import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { priceOrder, type TaxRate } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizePhone } from "../crm/segments.js";
import type { Db, Tx } from "../db.js";
import { withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { loadCustomer } from "../public/serialize.js";
import { notifyWebOrder } from "../shop/notify.js";
import { emitEvent } from "../webhooks/events.js";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/);
/** Orders one network can place in an hour, and open orders one phone can have. */
const MAX_ORDERS_PER_IP_HOUR = 10;
const MAX_OPEN_PER_PHONE = 3;
const MAX_LINES = 100;

const OrderSchema = z.object({
  /** Made on the phone, so pressing the button twice gives one order. */
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  name: z.string().trim().min(2, "Enter your name").max(120),
  phone: z.string().trim().min(6, "Enter your mobile number").max(30),
  email: z.string().trim().toLowerCase().email("Enter an email like name@example.com").max(200).nullish().or(z.literal("")),
  note: z.string().trim().max(500).nullish(),
  /** The customer asked for offers by message. */
  marketingConsent: z.boolean().default(false),
  lines: z
    .array(z.object({ variantId: z.string().uuid(), qty: z.number().positive().max(999) }))
    .min(1, "Your basket is empty")
    .max(MAX_LINES),
  /** The total the customer saw; if prices changed meanwhile the order is refused, not silently changed. */
  expectedTotal: z.number().int(),
});

interface Shop {
  tenant_id: string;
  slug: string;
  name: string;
  notice: string | null;
  min_order: number;
  ready_minutes: number;
  check_stock: boolean;
  pickup_store_ids: string[];
}

export async function loadShop(db: Db | Tx, slug: string): Promise<Shop> {
  const s = Slug.safeParse(slug);
  const { rows } = s.success
    ? await db.query<Shop>(
        `SELECT o.tenant_id, o.slug, t.name, o.notice, o.min_order, o.ready_minutes, o.check_stock, o.pickup_store_ids
           FROM online_stores o JOIN tenants t ON t.id = o.tenant_id
          WHERE o.slug = $1 AND o.enabled AND t.status NOT IN ('suspended', 'cancelled')`,
        [s.data],
      )
    : { rows: [] };
  if (!rows[0]) throw new HttpError(404, "not_found", "This shop is not open online");
  return rows[0];
}

/** Taxes of the business, as the pricing engine wants them. */
async function taxMap(db: Db | Tx, tenantId: string) {
  const { rows } = await db.query<TaxRate>(
    `SELECT id, name, rate_bp AS "rateBp", price_included AS "priceIncluded" FROM taxes WHERE tenant_id = $1`,
    [tenantId],
  );
  return Object.fromEntries(rows.map((t) => [t.id, t]));
}

/**
 * Products on sale online at one store: published, active, in that store's range, at that
 * store's prices (its price list, else the normal price). Stock is what the store holds less
 * what open online orders have asked for.
 */
async function storeProducts(db: Db | Tx, tenantId: string, storeId: string, variantIds?: string[]) {
  const { rows } = await db.query(
    `SELECT v.id AS "variantId", p.id AS "productId", p.name, p.name_ar AS "nameAr", p.description, p.uom, p.category_id AS "categoryId",
            p.tax_id AS "taxId", COALESCE(pli.price, v.price) AS price,
            (SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.variant_id = v.id AND m.store_id = $2)
              - (SELECT COALESCE(SUM((l->>'qty')::numeric), 0) FROM web_orders w, jsonb_array_elements(w.lines) l
                  WHERE w.tenant_id = $1 AND w.store_id = $2 AND w.status IN ('new', 'accepted', 'ready') AND l->>'variantId' = v.id::text) AS available
       FROM products p
       JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id AND v.active ORDER BY v.id LIMIT 1) v ON true
       JOIN stores s ON s.id = $2
       LEFT JOIN price_list_items pli ON pli.price_list_id = s.price_list_id AND pli.variant_id = v.id AND pli.active
      WHERE p.tenant_id = $1 AND p.online AND p.active
        AND NOT EXISTS (SELECT 1 FROM store_hidden_products h WHERE h.store_id = $2 AND h.product_id = p.id)
        ${variantIds ? "AND v.id = ANY($3)" : ""}
      ORDER BY p.name`,
    variantIds ? [tenantId, storeId, variantIds] : [tenantId, storeId],
  );
  return rows.map((r) => ({ ...r, price: Number(r.price), available: Number(r.available) }));
}

/** The price with VAT for one unit, as the shop shows it. */
const grossOf = (price: number, taxId: string | null, taxes: Record<string, TaxRate>) =>
  priceOrder([{ id: "x", variantId: null, name: "", qty: 1, unitPrice: price, taxId }], { taxes }).total;

export async function shopRoutes(app: FastifyInstance) {
  /** The shop page: business, pickup stores, categories and products of the chosen store. */
  app.get<{ Params: { slug: string }; Querystring: { store?: string } }>("/shop-api/:slug", async (req, reply) => {
    const shop = await loadShop(app.db, req.params.slug);
    const stores = (
      await app.db.query(
        `SELECT id, name, name_ar AS "nameAr", address, phone FROM stores WHERE tenant_id = $1 AND id = ANY($2) ORDER BY code`,
        [shop.tenant_id, shop.pickup_store_ids],
      )
    ).rows;
    if (!stores.length) throw new HttpError(404, "not_found", "This shop is not open online");
    const storeId = stores.some((s) => s.id === req.query.store) ? req.query.store! : stores[0]!.id;
    const taxes = await taxMap(app.db, shop.tenant_id);
    const products = (await storeProducts(app.db, shop.tenant_id, storeId)).map(({ taxId, price, available, ...p }) => ({
      ...p,
      price: grossOf(price, taxId, taxes),
      inStock: !shop.check_stock || available > 0,
    }));
    const used = new Set(products.map((p) => p.categoryId));
    const categories = (
      await app.db.query(`SELECT id, name, name_ar AS "nameAr" FROM categories WHERE tenant_id = $1 ORDER BY sort, name`, [shop.tenant_id])
    ).rows.filter((c) => used.has(c.id));
    reply.header("cache-control", "no-store");
    return {
      shop: { slug: shop.slug, name: shop.name, notice: shop.notice, minOrder: shop.min_order, readyMinutes: shop.ready_minutes },
      stores,
      storeId,
      categories,
      products,
    };
  });

  /** Places a click-and-collect order. Prices and stock are checked again here. */
  app.post<{ Params: { slug: string } }>("/shop-api/:slug/orders", async (req) => {
    const shop = await loadShop(app.db, req.params.slug);
    const body = OrderSchema.parse(req.body);
    if (!shop.pickup_store_ids.includes(body.storeId)) throw new HttpError(400, "bad_request", "Pick a store to collect from");
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, "bad_phone", "Enter a mobile number, like 050 123 4567");

    const again = await app.db.query("SELECT token FROM web_orders WHERE id = $1 AND tenant_id = $2", [body.id, shop.tenant_id]);
    if (again.rows[0]) return { id: body.id, token: again.rows[0].token };

    const recent = await app.db.query("SELECT COUNT(*)::int AS n FROM web_orders WHERE ip = $1 AND created_at > now() - interval '1 hour'", [req.ip]);
    if (recent.rows[0].n >= MAX_ORDERS_PER_IP_HOUR) throw new HttpError(429, "too_many_orders", "Too many orders from this network. Try again in an hour or call the shop.");
    const open = await app.db.query("SELECT COUNT(*)::int AS n FROM web_orders WHERE tenant_id = $1 AND phone = $2 AND status IN ('new', 'accepted', 'ready')", [
      shop.tenant_id,
      phone,
    ]);
    if (open.rows[0].n >= MAX_OPEN_PER_PHONE) {
      throw new HttpError(429, "too_many_open", "You already have orders waiting. Collect them first, or call the shop.");
    }

    const result = await withTx(app.db, async (tx) => {
      // One order at a time per business, so two customers cannot both take the last item.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('web_orders:' || $1))", [shop.tenant_id]);
      const { lines, totals } = await priceBasket(tx, shop, body.storeId, body.lines);
      if (totals.total !== body.expectedTotal) {
        throw new HttpError(409, "price_changed", "Prices changed while you were shopping. Check your basket and order again.");
      }
      if (totals.total < shop.min_order) throw new HttpError(400, "below_minimum", "Your basket is below the shop's minimum order");

      const customerId = await findOrAddCustomer(tx, shop.tenant_id, { name: body.name, phone, email: body.email || null, consent: body.marketingConsent });
      const seq = (await tx.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM web_orders WHERE tenant_id = $1", [shop.tenant_id])).rows[0].n as number;
      const token = randomBytes(18).toString("base64url");
      await tx.query(
        `INSERT INTO web_orders (id, tenant_id, store_id, seq, number, customer_id, name, phone, email, note, lines, subtotal_net, tax_total, total,
                                 token, pickup_code, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          body.id, shop.tenant_id, body.storeId, seq, `W-${String(seq).padStart(5, "0")}`, customerId, body.name, phone, body.email || null,
          body.note ?? null, JSON.stringify(lines), totals.subtotalNet, totals.taxTotal, totals.total, token,
          String(randomInt(0, 10_000)).padStart(4, "0"), req.ip,
        ],
      );
      await tx.query(
        `INSERT INTO audit_log (tenant_id, action, entity, entity_id, data) VALUES ($1, 'web_order.create', 'web_order', $2, $3)`,
        [shop.tenant_id, body.id, JSON.stringify({ total: totals.total, lines: lines.length })],
      );
      return { id: body.id, token };
    });
    void notifyWebOrder(app, result.id, "placed").catch((err) => app.log.error(err, "web order notice failed"));
    return result;
  });

  /** The basket priced by the server, as the order would be, before the customer orders. */
  app.post<{ Params: { slug: string } }>("/shop-api/:slug/quote", async (req) => {
    const shop = await loadShop(app.db, req.params.slug);
    const body = z.object({ storeId: z.string().uuid(), lines: OrderSchema.shape.lines }).parse(req.body);
    if (!shop.pickup_store_ids.includes(body.storeId)) throw new HttpError(400, "bad_request", "Pick a store to collect from");
    const { lines, totals } = await priceBasket(app.db, shop, body.storeId, body.lines);
    const taxes = await taxMap(app.db, shop.tenant_id);
    return {
      lines: lines.map((l, i) => ({ variantId: l.variantId, name: l.name, qty: l.qty, price: grossOf(l.unitPrice, l.taxId, taxes), total: totals.lines[i]!.gross })),
      subtotalNet: totals.subtotalNet,
      taxTotal: totals.taxTotal,
      total: totals.total,
      minOrder: shop.min_order,
    };
  });

  /** The customer's order page, by its private link. */
  app.get<{ Params: { slug: string; token: string } }>("/shop-api/:slug/orders/:token", async (req, reply) => {
    const shop = await loadShopAny(app.db, req.params.slug);
    const { rows } = await app.db.query(
      `SELECT w.number, w.status, w.name, w.lines, w.total, w.tax_total AS "taxTotal", w.pickup_code AS "pickupCode", w.note,
              w.created_at AS "createdAt", w.ready_at AS "readyAt", w.collected_at AS "collectedAt", w.cancel_reason AS "cancelReason",
              json_build_object('name', s.name, 'nameAr', s.name_ar, 'address', s.address, 'phone', s.phone) AS store
         FROM web_orders w JOIN stores s ON s.id = w.store_id WHERE w.token = $1 AND w.tenant_id = $2`,
      [req.params.token, shop.tenant_id],
    );
    if (!rows[0]) throw new HttpError(404, "not_found", "Order not found");
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
    const o = rows[0];
    return { ...o, lines: (o.lines as { name: string; qty: number }[]).map((l) => ({ name: l.name, qty: l.qty })), shop: { name: shop.name, slug: shop.slug } };
  });

  /** Customers can cancel until the shop has started on the order. */
  app.post<{ Params: { slug: string; token: string } }>("/shop-api/:slug/orders/:token/cancel", async (req) => {
    const shop = await loadShopAny(app.db, req.params.slug);
    const { rows } = await app.db.query(
      `UPDATE web_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by the customer'
        WHERE token = $1 AND tenant_id = $2 AND status = 'new' RETURNING id`,
      [req.params.token, shop.tenant_id],
    );
    if (!rows[0]) throw new HttpError(409, "wrong_state", "The shop has already started on this order. Call them to change it.");
    await app.db.query(`INSERT INTO audit_log (tenant_id, action, entity, entity_id, data) VALUES ($1, 'web_order.cancel', 'web_order', $2, '{"by":"customer"}')`, [
      shop.tenant_id,
      rows[0].id,
    ]);
    return { status: "cancelled" };
  });
}

/** Checks and prices a basket at one store: what is sold there, its prices, and stock. */
async function priceBasket(db: Db | Tx, shop: Shop, storeId: string, input: { variantId: string; qty: number }[]) {
  const merged = new Map<string, number>();
  for (const l of input) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.qty);
  const taxes = await taxMap(db, shop.tenant_id);
  const found = await storeProducts(db, shop.tenant_id, storeId, [...merged.keys()]);
  const byId = new Map(found.map((p) => [p.variantId as string, p]));
  const lines = [];
  for (const [variantId, qty] of merged) {
    const p = byId.get(variantId);
    if (!p) throw new HttpError(409, "unavailable", "Something in your basket is no longer sold online. Refresh the page.");
    if (p.uom !== "kg" && !Number.isInteger(qty)) throw new HttpError(400, "bad_request", `${p.name} is sold by the piece`);
    if (shop.check_stock && p.available < qty) {
      throw new HttpError(409, "out_of_stock", p.available > 0 ? `Only ${p.available} of ${p.name} left` : `${p.name} is sold out`);
    }
    lines.push({ variantId, productId: p.productId as string, name: p.name as string, qty, unitPrice: p.price, taxId: p.taxId as string | null });
  }
  const totals = priceOrder(
    lines.map((l, i) => ({ id: String(i), variantId: l.variantId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, taxId: l.taxId })),
    { taxes },
  );
  return { lines, totals };
}

/** For order links: still works after the shop is switched off. */
async function loadShopAny(db: Db, slug: string) {
  const s = Slug.safeParse(slug);
  const { rows } = s.success
    ? await db.query(`SELECT o.tenant_id, o.slug, t.name FROM online_stores o JOIN tenants t ON t.id = o.tenant_id WHERE o.slug = $1`, [s.data])
    : { rows: [] };
  if (!rows[0]) throw new HttpError(404, "not_found", "Order not found");
  return rows[0] as { tenant_id: string; slug: string; name: string };
}

/**
 * Links the order to the customer with that mobile, or adds them. Ticking the offers box adds
 * consent; leaving it unticked never takes consent away.
 */
async function findOrAddCustomer(tx: Tx, tenantId: string, c: { name: string; phone: string; email: string | null; consent: boolean }) {
  const last9 = c.phone.replace(/\D/g, "").slice(-9);
  const { rows } = await tx.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = $2
      ORDER BY (consent_sms OR consent_whatsapp) DESC, id LIMIT 1`,
    [tenantId, last9],
  );
  if (rows[0]) {
    if (c.consent) {
      await tx.query(
        `UPDATE customers SET consent_sms = true, consent_whatsapp = true, consent_email = consent_email OR email IS NOT NULL,
                consent_at = now(), consent_source = 'online_store', updated_at = now()
          WHERE id = $1 AND NOT (consent_sms AND consent_whatsapp)`,
        [rows[0].id],
      );
    }
    return rows[0].id as string;
  }
  const id = randomUUID();
  // UAE mobiles are kept the way people write them here (050…), like the till does.
  const local = c.phone.startsWith("+971") ? `0${c.phone.slice(4)}` : c.phone;
  await tx.query(
    `INSERT INTO customers (id, tenant_id, name, phone, email, consent_email, consent_sms, consent_whatsapp, consent_at, consent_source)
     VALUES ($1, $2, $3, $4, $5, $6 AND $5::text IS NOT NULL, $6, $6, CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN 'online_store' END)`,
    [id, tenantId, c.name, local, c.email, c.consent],
  );
  await emitEvent(tx, tenantId, "customer.created", async () => loadCustomer(tx, tenantId, id));
  return id;
}
