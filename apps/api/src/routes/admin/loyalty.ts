import { GiftCardCodeSchema, newGiftCardCode } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx, type Db, type Tx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { loyaltySettings, lockGiftCard, moveGiftCard, movePoints } from "../../loyalty.js";
import { adminAudit, forbidden } from "./common.js";

const SettingsSchema = z.object({
  enabled: z.boolean(),
  pointsPerAed: z.number().int().min(1).max(1000),
  pointValueFils: z.number().int().min(1).max(10_000),
  minRedeemPoints: z.number().int().min(0).max(1_000_000),
});

const Fils = z.number().int().min(1).max(100_000_000);
const Note = z.string().trim().min(1, "Say why").max(300);
const Expiry = z.string().datetime({ offset: true }).nullish();

const IssueSchema = z.object({
  /** Leave out to get a new random number. */
  code: GiftCardCodeSchema.nullish(),
  amount: Fils,
  expiresAt: Expiry,
  customerId: z.string().uuid().nullish(),
  note: z.string().trim().max(300).nullish(),
});

const CardPatchSchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  expiresAt: Expiry,
  customerId: z.string().uuid().nullish(),
  note: z.string().trim().max(300).nullish(),
});

const AdjustSchema = z.object({
  amount: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0, "Enter an amount"),
  note: Note,
});

const PointsAdjustSchema = z.object({
  points: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, "Enter the points"),
  note: Note,
});

const ListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "disabled", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** A spend the till took but never put on a sale is held this long before the owner can give it back. */
const HOLD_MINUTES = 15;

const ownerOnly = (role: string, what: string) => {
  if (role !== "owner") throw forbidden(`Only the owner can ${what}`);
};

/**
 * Loyalty points and gift cards in the back office. Changing the programme, issuing cards and
 * changing balances by hand are for the owner; every change is in the audit log.
 */
export async function loyaltyRoutes(app: FastifyInstance) {
  app.get("/loyalty", async (req) => {
    const ctx = await app.authAdmin(req);
    const settings = await loyaltySettings(app.db, ctx.tenantId);
    const { rows } = await app.db.query(
      `SELECT (SELECT COALESCE(SUM(points), 0) FROM customers WHERE tenant_id = $1 AND points > 0)::bigint AS "pointsOutstanding",
              (SELECT COUNT(*) FROM customers WHERE tenant_id = $1 AND points > 0)::int AS members,
              (SELECT COALESCE(SUM(points), 0) FROM loyalty_moves WHERE tenant_id = $1 AND kind = 'earn' AND at > now() - interval '30 days')::bigint AS "earned30",
              (SELECT COALESCE(-SUM(points), 0) FROM loyalty_moves WHERE tenant_id = $1 AND kind = 'redeem' AND at > now() - interval '30 days')::bigint AS "redeemed30",
              (SELECT COALESCE(SUM(balance), 0) FROM gift_cards WHERE tenant_id = $1 AND status = 'active')::bigint AS "giftCardBalance",
              (SELECT COUNT(*) FROM gift_cards WHERE tenant_id = $1 AND status = 'active' AND balance > 0)::int AS "giftCardsLive"`,
      [ctx.tenantId],
    );
    const r = rows[0];
    return {
      settings,
      stats: {
        pointsOutstanding: Number(r.pointsOutstanding),
        pointsValue: Number(r.pointsOutstanding) * settings.pointValueFils,
        members: r.members,
        earned30: Number(r.earned30),
        redeemed30: Number(r.redeemed30),
        giftCardBalance: Number(r.giftCardBalance),
        giftCardsLive: r.giftCardsLive,
      },
    };
  });

  app.put("/loyalty", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx.role, "change the points programme");
    const b = SettingsSchema.parse(req.body);
    await app.db.query(
      `INSERT INTO loyalty_settings (tenant_id, enabled, points_per_aed, point_value_fils, min_redeem_points, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, points_per_aed = $3, point_value_fils = $4,
         min_redeem_points = $5, updated_at = now()`,
      [ctx.tenantId, b.enabled, b.pointsPerAed, b.pointValueFils, b.minRedeemPoints],
    );
    await adminAudit(app.db, ctx, "loyalty.settings", "tenant", ctx.tenantId, b);
    return { ok: true };
  });

  // Gift cards

  app.get("/gift-cards", async (req) => {
    const ctx = await app.authAdmin(req);
    const { q, status, limit, offset } = ListSchema.parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    let where = "g.tenant_id = $1";
    if (status !== "all") {
      params.push(status);
      where += ` AND g.status = $${params.length}`;
    }
    if (q) {
      params.push(`%${q.toUpperCase()}%`, `%${q}%`);
      where += ` AND (g.code LIKE $${params.length - 1} OR c.name ILIKE $${params.length} OR c.phone LIKE $${params.length})`;
    }
    const count = await app.db.query(`SELECT COUNT(*)::int AS n FROM gift_cards g LEFT JOIN customers c ON c.id = g.customer_id WHERE ${where}`, params);
    const { rows } = await app.db.query(
      `SELECT g.id, g.code, g.status, g.balance, g.loaded, g.expires_at AS "expiresAt", g.note, g.created_at AS "createdAt",
              g.customer_id AS "customerId", c.name AS "customerName",
              (SELECT MAX(m.at) FROM gift_card_moves m WHERE m.gift_card_id = g.id) AS "lastUsed"
         FROM gift_cards g LEFT JOIN customers c ON c.id = g.customer_id
        WHERE ${where} ORDER BY g.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { giftCards: rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/gift-cards/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await app.db.query(
      `SELECT g.id, g.code, g.status, g.balance, g.loaded, g.expires_at AS "expiresAt", g.note, g.created_at AS "createdAt",
              g.customer_id AS "customerId", c.name AS "customerName", c.phone AS "customerPhone"
         FROM gift_cards g LEFT JOIN customers c ON c.id = g.customer_id WHERE g.id = $1 AND g.tenant_id = $2`,
      [id, ctx.tenantId],
    );
    if (!rows[0]) throw notFound("Gift card");
    const moves = await app.db.query(
      `SELECT m.id, m.kind, m.amount, m.at, m.note, m.order_id AS "orderId", o.number AS "orderNumber", s.name AS "storeName",
              u.name AS "userName",
              (m.kind = 'redeem' AND m.order_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM gift_card_moves v WHERE v.payment_id = m.payment_id AND v.kind = 'redeem_void')) AS unclaimed,
              m.at < now() - make_interval(mins => ${HOLD_MINUTES}) AS "releasable"
         FROM gift_card_moves m
         LEFT JOIN orders o ON o.id = m.order_id
         LEFT JOIN stores s ON s.id = m.store_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.gift_card_id = $1 ORDER BY m.at DESC, m.id LIMIT 200`,
      [id],
    );
    return { ...rows[0], moves: moves.rows.map((m) => ({ ...m, releasable: m.unclaimed && m.releasable })) };
  });

  app.post("/gift-cards", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx.role, "issue gift cards");
    const b = IssueSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      if (b.customerId) await checkCustomer(tx, ctx.tenantId, b.customerId);
      let code = b.code ?? null;
      if (code) {
        if (await lockGiftCard(tx, ctx.tenantId, code)) throw new HttpError(409, "code_taken", "A gift card with this number already exists");
      } else {
        // 16 random digits: a clash is all but impossible, but check anyway.
        do code = newGiftCardCode();
        while (await lockGiftCard(tx, ctx.tenantId, code));
      }
      const { rows } = await tx.query(
        `INSERT INTO gift_cards (tenant_id, code, expires_at, customer_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ctx.tenantId, code, b.expiresAt ?? null, b.customerId ?? null, b.note || null],
      );
      const id = rows[0].id as string;
      await moveGiftCard(tx, { tenantId: ctx.tenantId, cardId: id, amount: b.amount, kind: "issue", userId: ctx.userId, note: b.note || null });
      await adminAudit(tx, ctx, "gift_card.issue", "gift_card", id, { code, amount: b.amount });
      return { id, code };
    });
  });

  app.patch<{ Params: { id: string } }>("/gift-cards/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const b = CardPatchSchema.parse(req.body);
    if ((b.expiresAt !== undefined || b.status === "active") && ctx.role !== "owner") {
      throw forbidden("Only the owner can switch a card back on or change its expiry");
    }
    if (b.customerId) await checkCustomer(app.db, ctx.tenantId, b.customerId);
    const sets: string[] = [];
    const params: unknown[] = [id, ctx.tenantId];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.status !== undefined) set("status", b.status);
    if (b.expiresAt !== undefined) set("expires_at", b.expiresAt);
    if (b.customerId !== undefined) set("customer_id", b.customerId);
    if (b.note !== undefined) set("note", b.note || null);
    if (!sets.length) return { id };
    const res = await app.db.query(`UPDATE gift_cards SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING code`, params);
    if (!res.rowCount) throw notFound("Gift card");
    await adminAudit(app.db, ctx, "gift_card.update", "gift_card", id, { code: res.rows[0].code, ...b });
    return { id };
  });

  /** Corrects a balance by hand. A card never goes below zero this way. */
  app.post<{ Params: { id: string } }>("/gift-cards/:id/adjust", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx.role, "change a gift card balance");
    const id = z.string().uuid().parse(req.params.id);
    const b = AdjustSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const { rows } = await tx.query("SELECT code, balance FROM gift_cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, ctx.tenantId]);
      if (!rows[0]) throw notFound("Gift card");
      if (rows[0].balance + b.amount < 0) throw new HttpError(409, "gift_card_balance", "That would take the card below zero");
      const balance = await moveGiftCard(tx, { tenantId: ctx.tenantId, cardId: id, amount: b.amount, kind: "adjust", userId: ctx.userId, note: b.note });
      await adminAudit(tx, ctx, "gift_card.adjust", "gift_card", id, { code: rows[0].code, amount: b.amount, note: b.note, balance });
      return { id, balance };
    });
  });

  /**
   * Gives back a spend a till took but never put on a sale (the till lost power, say). Only
   * after a while, so a sale that is still being paid for is not undone under the cashier.
   */
  app.post<{ Params: { id: string; moveId: string } }>("/gift-cards/:id/release/:moveId", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const moveId = z.string().uuid().parse(req.params.moveId);
    return withTx(app.db, async (tx) => {
      const card = await tx.query("SELECT code FROM gift_cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, ctx.tenantId]);
      if (!card.rowCount) throw notFound("Gift card");
      const { rows } = await tx.query(
        `SELECT m.amount, m.payment_id, m.order_id, m.at < now() - make_interval(mins => ${HOLD_MINUTES}) AS old,
                EXISTS (SELECT 1 FROM gift_card_moves v WHERE v.payment_id = m.payment_id AND v.kind = 'redeem_void') AS voided
           FROM gift_card_moves m WHERE m.id = $1 AND m.gift_card_id = $2 AND m.kind = 'redeem'`,
        [moveId, id],
      );
      const m = rows[0];
      if (!m) throw notFound("Gift card spend");
      if (m.order_id) throw new HttpError(409, "gift_card_used", "This spend is on a sale; refund the sale instead");
      if (m.voided) return { id, released: false };
      if (!m.old) throw new HttpError(409, "too_soon", `Wait ${HOLD_MINUTES} minutes: the sale may still be going through`);
      const balance = await moveGiftCard(tx, {
        tenantId: ctx.tenantId,
        cardId: id,
        amount: -m.amount,
        kind: "redeem_void",
        paymentId: m.payment_id,
        userId: ctx.userId,
        note: "Given back from the back office",
      });
      await adminAudit(tx, ctx, "gift_card.release", "gift_card", id, { code: card.rows[0].code, amount: -m.amount, balance });
      return { id, released: true, balance };
    });
  });

  // Customer points

  app.get<{ Params: { id: string } }>("/customers/:id/loyalty", async (req) => {
    const ctx = await app.authAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const c = await app.db.query("SELECT points FROM customers WHERE id = $1 AND tenant_id = $2", [id, ctx.tenantId]);
    if (!c.rows[0]) throw notFound("Customer");
    const [moves, cards] = await Promise.all([
      app.db.query(
        `SELECT m.id, m.kind, m.points, m.at, m.note, m.order_id AS "orderId", o.number AS "orderNumber", u.name AS "userName"
           FROM loyalty_moves m LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN users u ON u.id = m.user_id
          WHERE m.customer_id = $1 ORDER BY m.at DESC, m.id LIMIT 100`,
        [id],
      ),
      app.db.query(
        `SELECT id, code, status, balance FROM gift_cards WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
        [id, ctx.tenantId],
      ),
    ]);
    return { points: c.rows[0].points, moves: moves.rows, giftCards: cards.rows };
  });

  app.post<{ Params: { id: string } }>("/customers/:id/points", async (req) => {
    const ctx = await app.authAdmin(req);
    ownerOnly(ctx.role, "change a customer's points");
    const id = z.string().uuid().parse(req.params.id);
    const b = PointsAdjustSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const { rows } = await tx.query("SELECT name, points FROM customers WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, ctx.tenantId]);
      if (!rows[0]) throw notFound("Customer");
      if (rows[0].points + b.points < 0) throw new HttpError(409, "points_balance", "That would take the customer below zero points");
      const points = await movePoints(tx, { tenantId: ctx.tenantId, customerId: id, points: b.points, kind: "adjust", userId: ctx.userId, note: b.note });
      await adminAudit(tx, ctx, "loyalty.adjust", "customer", id, { name: rows[0].name, points: b.points, note: b.note, balance: points });
      return { id, points };
    });
  });
}

async function checkCustomer(db: Db | Tx, tenantId: string, id: string) {
  const { rowCount } = await db.query("SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!rowCount) throw new HttpError(400, "bad_request", "That customer does not exist");
}
