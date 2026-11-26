import { randomBytes } from "node:crypto";
import { priceOrder } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx, type Db, type Tx } from "../db.js";
import { HttpError } from "../errors.js";
import { grossOf, storeProducts, taxMap } from "./shop.js";

/** Orders one network can send in an hour (a restaurant's guests often share its Wi-Fi). */
const MAX_PER_IP_HOUR = 60;
/** Orders a table can have waiting for the staff at once. */
const MAX_WAITING_PER_TABLE = 3;
/** Orders a kiosk can have waiting to be paid at once. */
const MAX_WAITING_PER_KIOSK = 30;

const Token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const OrderSchema = z.object({
  /** Made on the guest's phone, so pressing the button twice gives one order. */
  id: z.string().uuid(),
  name: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(300).nullish(),
  lines: z
    .array(z.object({ variantId: z.string().uuid(), qty: z.number().int().positive().max(50), optionIds: z.array(z.string().uuid()).max(30).default([]) }))
    .min(1, "Your order is empty")
    .max(60),
  /** The total the guest saw; if prices changed meanwhile the order is refused, not changed. */
  expectedTotal: z.number().int(),
});

interface Place {
  kind: "table" | "kiosk";
  tenantId: string;
  storeId: string;
  business: string;
  store: string;
  storeAr: string | null;
  tableId: string | null;
  tableName: string | null;
  kioskId: string | null;
  open: boolean;
}

export const newToken = () => randomBytes(15).toString("base64url");

/** Where a QR code or kiosk link points: its table (or kiosk), store and business. */
async function loadPlace(db: Db | Tx, kind: "table" | "kiosk", token: string): Promise<Place> {
  const t = Token.safeParse(token);
  const notFound = new HttpError(404, "not_found", kind === "table" ? "This QR code is not in use. Ask the staff." : "This kiosk is not set up.");
  if (!t.success) throw notFound;
  const { rows } =
    kind === "table"
      ? await db.query(
          `SELECT d.id AS "tableId", d.name AS "tableName", NULL AS "kioskId", s.id AS "storeId", s.tenant_id AS "tenantId", s.name AS store, s.name_ar AS "storeAr",
                  s.table_ordering AS open, tn.name AS business
             FROM dining_tables d JOIN stores s ON s.id = d.store_id JOIN tenants tn ON tn.id = s.tenant_id
            WHERE d.qr_token = $1 AND d.active AND tn.status NOT IN ('suspended', 'cancelled')`,
          [t.data],
        )
      : await db.query(
          `SELECT NULL AS "tableId", NULL AS "tableName", k.id AS "kioskId", s.id AS "storeId", s.tenant_id AS "tenantId", s.name AS store, s.name_ar AS "storeAr",
                  true AS open, tn.name AS business
             FROM kiosks k JOIN stores s ON s.id = k.store_id JOIN tenants tn ON tn.id = s.tenant_id
            WHERE k.token = $1 AND k.active AND tn.status NOT IN ('suspended', 'cancelled')`,
          [t.data],
        );
  if (!rows[0]) throw notFound;
  return { kind, ...rows[0] } as Place;
}

interface Group {
  id: string;
  name: string;
  nameAr: string | null;
  minChoices: number;
  maxChoices: number;
  options: { id: string; name: string; nameAr: string | null; price: number }[];
}

async function groupsOf(db: Db | Tx, tenantId: string, ids: string[]): Promise<Map<string, Group>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<Group>(
    `SELECT id, name, name_ar AS "nameAr", min_choices AS "minChoices", max_choices AS "maxChoices", options
       FROM modifier_groups WHERE tenant_id = $1 AND active AND id = ANY($2) ORDER BY sort, name`,
    [tenantId, ids],
  );
  return new Map(rows.map((g) => [g.id, g]));
}

/** The menu at that store: products on the online menu, their prices and their choices, VAT included. */
async function menu(db: Db, place: Place) {
  const taxes = await taxMap(db, place.tenantId);
  const products = await storeProducts(db, place.tenantId, place.storeId);
  const groups = await groupsOf(db, place.tenantId, [...new Set(products.flatMap((p) => (p.modifierGroupIds as string[] | null) ?? []))]);
  const used = new Set(products.map((p) => p.categoryId));
  const categories = (await db.query(`SELECT id, name, name_ar AS "nameAr" FROM categories WHERE tenant_id = $1 ORDER BY sort, name`, [place.tenantId])).rows.filter((c) =>
    used.has(c.id),
  );
  return {
    categories,
    products: products
      .filter((p) => p.uom !== "kg")
      .map((p) => ({
        variantId: p.variantId,
        productId: p.productId,
        name: p.name,
        nameAr: p.nameAr,
        description: p.description,
        categoryId: p.categoryId,
        price: grossOf(p.price, p.taxId, taxes),
        modifierGroupIds: ((p.modifierGroupIds as string[] | null) ?? []).filter((id) => groups.has(id)),
      })),
    // Extra prices as set (VAT included in the usual UAE set-up); the quote gives the exact total.
    modifierGroups: [...groups.values()],
  };
}

/**
 * Checks and prices what the guest picked: each item is sold at that store, each choice is one
 * of the item's and within its group's limits. The choices' prices go into the item's price,
 * as on the till.
 */
export async function priceDineIn(db: Db | Tx, place: Place, input: z.infer<typeof OrderSchema>["lines"]) {
  const taxes = await taxMap(db, place.tenantId);
  const found = await storeProducts(db, place.tenantId, place.storeId, [...new Set(input.map((l) => l.variantId))]);
  const byId = new Map(found.map((p) => [p.variantId as string, p]));
  const groups = await groupsOf(db, place.tenantId, [...new Set(found.flatMap((p) => (p.modifierGroupIds as string[] | null) ?? []))]);
  const lines = input.map((l) => {
    const p = byId.get(l.variantId);
    if (!p || p.uom === "kg") throw new HttpError(409, "unavailable", "Something you picked is no longer on the menu. Refresh the page.");
    const own = ((p.modifierGroupIds as string[] | null) ?? []).map((id) => groups.get(id)).filter((g): g is Group => !!g);
    const modifiers: { groupId: string; optionId: string; name: string; price: number }[] = [];
    const picked = new Set(l.optionIds);
    for (const g of own) {
      const chosen = g.options.filter((o) => picked.has(o.id));
      if (chosen.length < g.minChoices) throw new HttpError(400, "choose", `Choose ${g.name} for ${p.name}`);
      if (g.maxChoices && chosen.length > g.maxChoices) throw new HttpError(400, "choose", `Too many ${g.name} for ${p.name}`);
      for (const o of chosen) {
        modifiers.push({ groupId: g.id, optionId: o.id, name: o.name, price: o.price });
        picked.delete(o.id);
      }
    }
    if (picked.size) throw new HttpError(409, "unavailable", `A choice for ${p.name} is no longer offered. Refresh the page.`);
    const unitPrice = (p.price as number) + modifiers.reduce((s, m) => s + m.price, 0);
    return { variantId: l.variantId, productId: p.productId as string, name: p.name as string, qty: l.qty, unitPrice, taxId: p.taxId as string | null, modifiers };
  });
  const totals = priceOrder(
    lines.map((l, i) => ({ id: String(i), variantId: l.variantId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, taxId: l.taxId })),
    { taxes },
  );
  return { lines, totals, taxes };
}

/**
 * Guests ordering for themselves: from the QR code on their table (the staff add it to the
 * table's bill and the kitchen gets it), or at a self-order kiosk (paid at the counter).
 */
export async function dineInRoutes(app: FastifyInstance) {
  for (const kind of ["table", "kiosk"] as const) {
    app.get<{ Params: { token: string } }>(`/shop-api/${kind}/:token`, async (req, reply) => {
      const place = await loadPlace(app.db, kind, req.params.token);
      if (kind === "kiosk") await app.db.query("UPDATE kiosks SET last_seen_at = now() WHERE id = $1", [place.kioskId]);
      const m = await menu(app.db, place);
      reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
      return {
        kind,
        business: place.business,
        store: { name: place.store, nameAr: place.storeAr },
        table: place.tableName ? { name: place.tableName } : null,
        open: place.open,
        ...m,
      };
    });

    app.post<{ Params: { token: string } }>(`/shop-api/${kind}/:token/quote`, async (req) => {
      const place = await loadPlace(app.db, kind, req.params.token);
      const body = z.object({ lines: OrderSchema.shape.lines }).parse(req.body);
      const { lines, totals, taxes } = await priceDineIn(app.db, place, body.lines);
      return {
        lines: lines.map((l, i) => ({ variantId: l.variantId, name: l.name, qty: l.qty, price: grossOf(l.unitPrice, l.taxId, taxes), total: totals.lines[i]!.gross })),
        total: totals.total,
      };
    });

    app.post<{ Params: { token: string } }>(`/shop-api/${kind}/:token/orders`, async (req) => {
      const place = await loadPlace(app.db, kind, req.params.token);
      if (!place.open) throw new HttpError(409, "closed", "Ordering from the table is off right now. Ask the staff.");
      const body = OrderSchema.parse(req.body);
      const again = await app.db.query("SELECT token, number, seq FROM web_orders WHERE id = $1 AND tenant_id = $2", [body.id, place.tenantId]);
      if (again.rows[0]) return { id: body.id, token: again.rows[0].token, number: again.rows[0].number, short: again.rows[0].seq % 1000 };

      const recent = await app.db.query("SELECT COUNT(*)::int AS n FROM web_orders WHERE ip = $1 AND created_at > now() - interval '1 hour'", [req.ip]);
      if (recent.rows[0].n >= MAX_PER_IP_HOUR) throw new HttpError(429, "too_many_orders", "Too many orders from this network. Ask the staff.");
      const waiting = await app.db.query(
        `SELECT COUNT(*)::int AS n FROM web_orders WHERE status = 'new' AND ${kind === "table" ? "table_id" : "kiosk_id"} = $1`,
        [kind === "table" ? place.tableId : place.kioskId],
      );
      if (waiting.rows[0].n >= (kind === "table" ? MAX_WAITING_PER_TABLE : MAX_WAITING_PER_KIOSK)) {
        throw new HttpError(429, "too_many_waiting", kind === "table" ? "This table has orders waiting for the staff. They will be with you shortly." : "Too many orders are waiting to be paid. Pay at the counter first.");
      }

      return withTx(app.db, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('web_orders:' || $1))", [place.tenantId]);
        const { lines, totals } = await priceDineIn(tx, place, body.lines);
        if (totals.total !== body.expectedTotal) throw new HttpError(409, "price_changed", "Prices changed while you were ordering. Check your order and send it again.");
        const seq = (await tx.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM web_orders WHERE tenant_id = $1", [place.tenantId])).rows[0].n as number;
        const token = newToken();
        const number = `W-${String(seq).padStart(5, "0")}`;
        await tx.query(
          `INSERT INTO web_orders (id, tenant_id, store_id, seq, number, name, note, lines, subtotal_net, tax_total, total, token, pickup_code, ip,
                                   channel, table_id, kiosk_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            body.id, place.tenantId, place.storeId, seq, number, body.name || null, body.note || null, JSON.stringify(lines), totals.subtotalNet, totals.taxTotal,
            totals.total, token, String(seq % 1000).padStart(3, "0"), req.ip, kind, place.tableId, place.kioskId,
          ],
        );
        await tx.query(`INSERT INTO audit_log (tenant_id, action, entity, entity_id, data) VALUES ($1, 'web_order.create', 'web_order', $2, $3)`, [
          place.tenantId,
          body.id,
          JSON.stringify({ channel: kind, table: place.tableName, total: totals.total, lines: lines.length }),
        ]);
        return { id: body.id, token, number, short: seq % 1000 };
      });
    });
  }

  /** The guest's view of their order, by its private link: waiting, added to the bill, or not taken. */
  app.get<{ Params: { token: string } }>("/shop-api/dine-in/orders/:token", async (req, reply) => {
    const t = Token.safeParse(req.params.token);
    const { rows } = t.success
      ? await app.db.query(
          `SELECT number, seq % 1000 AS short, channel, status, lines, total, cancel_reason AS "cancelReason", created_at AS "createdAt"
             FROM web_orders WHERE token = $1 AND channel IN ('table', 'kiosk')`,
          [t.data],
        )
      : { rows: [] };
    if (!rows[0]) throw new HttpError(404, "not_found", "Order not found");
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
    const o = rows[0];
    return { ...o, lines: (o.lines as { name: string; qty: number; modifiers?: { name: string }[] }[]).map((l) => ({ name: l.name, qty: l.qty, modifiers: (l.modifiers ?? []).map((m) => m.name) })) };
  });
}
