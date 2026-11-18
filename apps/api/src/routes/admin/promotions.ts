import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../app.js";
import { withTx, type Tx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const ITEM_KINDS = ["percent_off", "buy_x_get_y", "multi_buy"] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 17:00");
const ids = z.array(z.string().uuid()).max(500).default([]);

const PromotionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["percent_off", "buy_x_get_y", "multi_buy", "order_percent_off", "order_amount_off"]),
    target: z.object({ all: z.boolean().default(false), categoryIds: ids, productIds: ids }).default({}),
    percentBp: z.number().int().min(1).max(10_000).nullish(),
    buyQty: z.number().int().min(1).max(100).nullish(),
    getQty: z.number().int().min(1).max(100).nullish(),
    bundleQty: z.number().int().min(2).max(100).nullish(),
    bundlePrice: z.number().int().min(0).max(100_000_000).nullish(),
    amount: z.number().int().min(1).max(100_000_000).nullish(),
    minSubtotal: z.number().int().min(0).max(100_000_000).nullish(),
    minQty: z.number().int().min(1).max(1000).nullish(),
    code: z
      .string()
      .trim()
      .transform((c) => c.toUpperCase())
      .pipe(z.string().regex(/^([A-Z0-9_-]{3,30})?$/, "A code is 3 to 30 letters, numbers, - or _"))
      .nullish(),
    startsAt: z.string().datetime({ offset: true }).nullish(),
    endsAt: z.string().datetime({ offset: true }).nullish(),
    days: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
    startTime: time.nullish(),
    endTime: time.nullish(),
    storeIds: z.array(z.string().uuid()).max(200).nullish(),
    priority: z.number().int().min(0).max(10_000).default(100),
    maxUses: z.number().int().min(1).max(10_000_000).nullish(),
    active: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    const need = (field: keyof typeof p, message: string) => {
      if (p[field] === null || p[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message });
    };
    if (p.kind === "percent_off" || p.kind === "order_percent_off") need("percentBp", "Enter the percentage off");
    if (p.kind === "buy_x_get_y") {
      need("buyQty", "Enter how many the customer buys");
      need("getQty", "Enter how many they get");
    }
    if (p.kind === "multi_buy") {
      need("bundleQty", "Enter how many items make the deal");
      need("bundlePrice", "Enter the deal price");
    }
    if (p.kind === "order_amount_off") need("amount", "Enter the amount off");
    if ((ITEM_KINDS as readonly string[]).includes(p.kind) && !p.target.all && !p.target.categoryIds.length && !p.target.productIds.length) {
      ctx.addIssue({ code: "custom", path: ["target"], message: "Pick the products or categories it applies to" });
    }
    if (p.startsAt && p.endsAt && Date.parse(p.endsAt) <= Date.parse(p.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start" });
    }
    if (!!p.startTime !== !!p.endTime) ctx.addIssue({ code: "custom", path: ["endTime"], message: "Give both a start and an end time" });
    if (p.startTime && p.startTime === p.endTime) ctx.addIssue({ code: "custom", path: ["endTime"], message: "The end time must differ from the start" });
  });
type PromotionInput = z.infer<typeof PromotionSchema>;

/** Only the fields that the kind uses are kept, so a promotion never carries stale settings. */
function normalize(p: PromotionInput) {
  const item = (ITEM_KINDS as readonly string[]).includes(p.kind);
  const use = <T>(on: boolean, v: T | null | undefined) => (on ? (v ?? null) : null);
  return {
    ...p,
    target: item ? { all: p.target.all, categoryIds: p.target.all ? [] : p.target.categoryIds, productIds: p.target.all ? [] : p.target.productIds } : { all: false, categoryIds: [], productIds: [] },
    percentBp: use(p.kind === "percent_off" || p.kind === "order_percent_off" || p.kind === "buy_x_get_y", p.kind === "buy_x_get_y" ? (p.percentBp ?? 10_000) : p.percentBp),
    buyQty: use(p.kind === "buy_x_get_y", p.buyQty),
    getQty: use(p.kind === "buy_x_get_y", p.getQty),
    bundleQty: use(p.kind === "multi_buy", p.bundleQty),
    bundlePrice: use(p.kind === "multi_buy", p.bundlePrice),
    amount: use(p.kind === "order_amount_off", p.amount),
    minSubtotal: use(!item, p.minSubtotal),
    minQty: use(p.kind === "percent_off", p.minQty),
    code: p.code || null,
    days: p.days?.length ? [...new Set(p.days)].sort() : null,
    storeIds: p.storeIds?.length ? [...new Set(p.storeIds)] : null,
  };
}

async function checkRefs(tx: Tx, tenantId: string, p: ReturnType<typeof normalize>) {
  const count = async (table: string, list: string[]) => {
    if (!list.length) return;
    const { rows } = await tx.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND id = ANY($2)`, [tenantId, list]);
    if (rows[0].n !== new Set(list).size) throw new HttpError(400, "bad_request", `Some of the ${table} picked do not exist`);
  };
  await count("categories", p.target.categoryIds);
  await count("products", p.target.productIds);
  await count("stores", p.storeIds ?? []);
}

const SELECT = `
  SELECT p.id, p.name, p.kind, json_build_object('all', p.target_all, 'categoryIds', p.category_ids, 'productIds', p.product_ids) AS target,
         p.percent_bp AS "percentBp", p.buy_qty AS "buyQty", p.get_qty AS "getQty", p.bundle_qty AS "bundleQty",
         p.bundle_price AS "bundlePrice", p.amount, p.min_subtotal AS "minSubtotal", p.min_qty AS "minQty", p.code,
         p.starts_at AS "startsAt", p.ends_at AS "endsAt", p.days, p.start_time AS "startTime", p.end_time AS "endTime",
         p.store_ids AS "storeIds", p.priority, p.max_uses AS "maxUses", p.uses, p.active, p.updated_at AS "updatedAt",
         st.sales, st.discount, st."lastUsed"
    FROM promotions p
    JOIN LATERAL (SELECT COUNT(*)::int AS sales, COALESCE(SUM(op.amount), 0)::int AS discount, MAX(op.created_at) AS "lastUsed"
                    FROM order_promotions op WHERE op.promotion_id = p.id) st ON true`;

const codeTaken = () => new HttpError(409, "code_taken", "Another active promotion already uses this code");

async function save(tx: Tx, ctx: AdminContext, id: string | null, body: PromotionInput) {
  const p = normalize(body);
  await checkRefs(tx, ctx.tenantId, p);
  const values = [
    p.name, p.kind, p.target.all, p.target.categoryIds, p.target.productIds, p.percentBp, p.buyQty, p.getQty, p.bundleQty,
    p.bundlePrice, p.amount, p.minSubtotal, p.minQty, p.code, p.startsAt ?? null, p.endsAt ?? null, p.days, p.startTime ?? null,
    p.endTime ?? null, p.storeIds, p.priority, p.maxUses ?? null, p.active,
  ];
  if (!id) {
    const newId = randomUUID();
    await tx.query(
      `INSERT INTO promotions (id, tenant_id, name, kind, target_all, category_ids, product_ids, percent_bp, buy_qty, get_qty,
         bundle_qty, bundle_price, amount, min_subtotal, min_qty, code, starts_at, ends_at, days, start_time, end_time,
         store_ids, priority, max_uses, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
      [newId, ctx.tenantId, ...values],
    );
    await adminAudit(tx, ctx, "promotion.create", "promotion", newId, { name: p.name, kind: p.kind, code: p.code });
    return newId;
  }
  const res = await tx.query(
    `UPDATE promotions SET name = $3, kind = $4, target_all = $5, category_ids = $6, product_ids = $7, percent_bp = $8,
            buy_qty = $9, get_qty = $10, bundle_qty = $11, bundle_price = $12, amount = $13, min_subtotal = $14, min_qty = $15,
            code = $16, starts_at = $17, ends_at = $18, days = $19, start_time = $20, end_time = $21, store_ids = $22,
            priority = $23, max_uses = $24, active = $25, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId, ...values],
  );
  if (!res.rowCount) throw notFound("Promotion");
  await adminAudit(tx, ctx, "promotion.update", "promotion", id, { name: p.name, kind: p.kind, code: p.code, active: p.active });
  return id;
}

/**
 * Promotions and coupons. Tills get them with the catalog sync and apply them offline,
 * so a change reaches a till within its next sync (a few seconds when online).
 */
export async function promotionRoutes(app: FastifyInstance) {
  app.get("/promotions", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${SELECT} WHERE p.tenant_id = $1 ORDER BY p.active DESC, p.priority, p.name`, [ctx.tenantId]);
    return { promotions: rows };
  });

  app.get<{ Params: { id: string } }>("/promotions/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`${SELECT} WHERE p.id = $1 AND p.tenant_id = $2`, [req.params.id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Promotion");
    const recent = await app.db.query(
      `SELECT o.id, o.number, o.created_at AS "createdAt", op.amount, op.code
         FROM order_promotions op JOIN orders o ON o.id = op.order_id
        WHERE op.promotion_id = $1 ORDER BY op.created_at DESC LIMIT 20`,
      [req.params.id],
    );
    return { ...rows[0], recent: recent.rows };
  });

  const write = async (ctx: AdminContext, id: string | null, raw: unknown) => {
    const body = PromotionSchema.parse(raw);
    try {
      return await withTx(app.db, (tx) => save(tx, ctx, id, body));
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
  };

  app.post("/promotions", async (req) => {
    const ctx = await app.authAdmin(req);
    return { id: await write(ctx, null, req.body) };
  });

  app.put<{ Params: { id: string } }>("/promotions/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    return { id: await write(ctx, req.params.id, req.body) };
  });

  /** Switch on or off from the list without resending the whole promotion. */
  app.patch<{ Params: { id: string } }>("/promotions/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const res = await app.db.query(
        "UPDATE promotions SET active = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING name",
        [req.params.id, ctx.tenantId, active],
      );
      if (!res.rowCount) throw notFound("Promotion");
      await adminAudit(app.db, ctx, active ? "promotion.on" : "promotion.off", "promotion", req.params.id, { name: res.rows[0].name });
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
    return { id: req.params.id };
  });
}
