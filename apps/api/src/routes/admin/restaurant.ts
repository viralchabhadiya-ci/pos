import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { assertStore } from "../../stores.js";
import { adminAudit, isUniqueViolation } from "./common.js";

const TableSchema = z.object({
  area: z.string().trim().min(1).max(40).default("Main"),
  name: z.string().trim().min(1, "Give the table a name").max(30),
  seats: z.number().int().min(1).max(100).default(4),
  sort: z.number().int().min(0).max(10_000).optional(),
});

const BulkSchema = z
  .object({
    storeId: z.string().uuid(),
    area: z.string().trim().min(1).max(40).default("Main"),
    prefix: z.string().trim().max(10).default(""),
    from: z.number().int().min(0).max(999),
    to: z.number().int().min(0).max(999),
    seats: z.number().int().min(1).max(100).default(4),
  })
  .refine((b) => b.to >= b.from && b.to - b.from < 100, "Add up to 100 tables at a time");

const OptionSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Name every option").max(60),
  nameAr: z.string().trim().max(60).nullish().transform((v) => v || null),
  price: z.number().int().min(0, "Options can't lower the price").max(1_000_000),
});

const GroupSchema = z
  .object({
    name: z.string().trim().min(1, "Give the group a name").max(60),
    nameAr: z.string().trim().max(60).nullish().transform((v) => v || null),
    minChoices: z.number().int().min(0).max(20).default(0),
    maxChoices: z.number().int().min(0).max(20).default(1),
    options: z.array(OptionSchema).min(1, "Add at least one option").max(40),
    productIds: z.array(z.string().uuid()).max(2000).default([]),
  })
  .refine((g) => g.maxChoices === 0 || g.maxChoices >= g.minChoices, "The most a cashier may pick can't be less than what they must pick")
  .refine((g) => g.minChoices <= g.options.length, "There are fewer options than the cashier must pick");

/** Back office Restaurant: tables of each store, modifier groups, and the bills open now. */
export async function restaurantRoutes(app: FastifyInstance) {
  async function loadTable(tenantId: string, storeIds: string[] | null, id: string) {
    const { rows } = await app.db.query(`SELECT * FROM dining_tables WHERE id = $1 AND tenant_id = $2 AND active`, [id, tenantId]);
    const t = rows[0];
    if (!t || (storeIds && !storeIds.includes(t.store_id))) throw notFound("Table");
    return t;
  }

  const tableTaken = (err: unknown) => {
    if (isUniqueViolation(err)) return new HttpError(409, "name_taken", "This store already has a table with that name");
    return err;
  };

  app.get<{ Querystring: { storeId?: string } }>("/restaurant", async (req) => {
    const ctx = await app.authAdmin(req);
    const storeId = req.query.storeId ?? (ctx.storeIds ? ctx.storeIds[0] : (await app.db.query(`SELECT id FROM stores WHERE tenant_id = $1 ORDER BY code LIMIT 1`, [ctx.tenantId])).rows[0]?.id);
    if (!storeId) throw notFound("Store");
    assertStore(ctx, storeId);
    const tables = await app.db.query(
      `SELECT id, area, name, seats, sort FROM dining_tables WHERE store_id = $1 AND tenant_id = $2 AND active ORDER BY area, sort, name`,
      [storeId, ctx.tenantId],
    );
    const tabs = await app.db.query(
      `SELECT t.id, t.table_id AS "tableId", dt.name AS "tableName", t.name, t.guests, t.total, t.opened_at AS "openedAt", t.updated_at AS "updatedAt",
              u.name AS "openedBy", jsonb_array_length(t.cart->'lines') AS lines
         FROM tabs t LEFT JOIN dining_tables dt ON dt.id = t.table_id LEFT JOIN users u ON u.id = t.opened_by
        WHERE t.store_id = $1 AND t.tenant_id = $2 AND t.status = 'open' ORDER BY t.opened_at`,
      [storeId, ctx.tenantId],
    );
    const groups = await app.db.query(
      `SELECT g.id, g.name, g.name_ar AS "nameAr", g.min_choices AS "minChoices", g.max_choices AS "maxChoices", g.options,
              COALESCE((SELECT array_agg(p.id ORDER BY p.name) FROM products p WHERE p.tenant_id = g.tenant_id AND g.id = ANY(p.modifier_group_ids)), '{}') AS "productIds"
         FROM modifier_groups g WHERE g.tenant_id = $1 AND g.active ORDER BY g.sort, g.name`,
      [ctx.tenantId],
    );
    // The kitchen today, in the store's time: how many tickets and how long food took.
    const kitchen = await app.db.query(
      `WITH day AS (
         SELECT k.* FROM kitchen_tickets k JOIN stores s ON s.id = k.store_id
          WHERE k.store_id = $1 AND k.tenant_id = $2 AND (k.created_at AT TIME ZONE s.timezone)::date = (now() AT TIME ZONE s.timezone)::date)
       SELECT COUNT(*)::int AS tickets,
              COUNT(*) FILTER (WHERE status <> 'done')::int AS open,
              COUNT(*) FILTER (WHERE status = 'ready')::int AS ready,
              ROUND(AVG(EXTRACT(EPOCH FROM ready_at - created_at)) FILTER (WHERE ready_at IS NOT NULL))::int AS "avgSeconds",
              MAX(EXTRACT(EPOCH FROM ready_at - created_at))::int AS "maxSeconds",
              (SELECT ROUND(EXTRACT(EPOCH FROM now() - MIN(created_at)))::int FROM day WHERE status IN ('new', 'preparing')) AS "oldestOpenSeconds"
         FROM day`,
      [storeId, ctx.tenantId],
    );
    return { storeId, tables: tables.rows, openTabs: tabs.rows, modifierGroups: groups.rows, kitchen: kitchen.rows[0] };
  });

  // Tables: each store's managers lay out their own.
  app.post("/dining-tables", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const body = TableSchema.extend({ storeId: z.string().uuid() }).parse(req.body);
    assertStore(ctx, body.storeId);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [body.storeId, ctx.tenantId]);
    if (!store.rows[0]) throw new HttpError(400, "bad_request", "That store does not exist");
    const id = randomUUID();
    try {
      await app.db.query(`INSERT INTO dining_tables (id, tenant_id, store_id, area, name, seats, sort) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        id,
        ctx.tenantId,
        body.storeId,
        body.area,
        body.name,
        body.seats,
        body.sort ?? 0,
      ]);
    } catch (err) {
      throw tableTaken(err);
    }
    await adminAudit(app.db, ctx, "table.create", "dining_table", id, { name: body.name, area: body.area });
    reply.status(201);
    return { id, area: body.area, name: body.name, seats: body.seats, sort: body.sort ?? 0 };
  });

  app.post("/dining-tables/bulk", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const body = BulkSchema.parse(req.body);
    assertStore(ctx, body.storeId);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [body.storeId, ctx.tenantId]);
    if (!store.rows[0]) throw new HttpError(400, "bad_request", "That store does not exist");
    let added = 0;
    try {
      await withTx(app.db, async (tx) => {
        for (let n = body.from; n <= body.to; n++) {
          const name = `${body.prefix}${n}`;
          const r = await tx.query(
            `INSERT INTO dining_tables (id, tenant_id, store_id, area, name, seats, sort)
             SELECT $1, $2, $3, $4, $5, $6, $7 WHERE NOT EXISTS (SELECT 1 FROM dining_tables WHERE store_id = $3 AND lower(name) = lower($5) AND active)`,
            [randomUUID(), ctx.tenantId, body.storeId, body.area, name, body.seats, n],
          );
          added += r.rowCount ?? 0;
        }
        await adminAudit(tx, ctx, "table.bulk_create", "store", body.storeId, { area: body.area, from: `${body.prefix}${body.from}`, to: `${body.prefix}${body.to}`, added });
      });
    } catch (err) {
      throw tableTaken(err);
    }
    reply.status(201);
    return { added, skipped: body.to - body.from + 1 - added };
  });

  app.put<{ Params: { id: string } }>("/dining-tables/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const t = await loadTable(ctx.tenantId, ctx.storeIds, req.params.id);
    const body = TableSchema.parse(req.body);
    try {
      await app.db.query(`UPDATE dining_tables SET area = $2, name = $3, seats = $4, sort = $5, updated_at = now() WHERE id = $1`, [
        t.id,
        body.area,
        body.name,
        body.seats,
        body.sort ?? t.sort,
      ]);
    } catch (err) {
      throw tableTaken(err);
    }
    await adminAudit(app.db, ctx, "table.update", "dining_table", t.id, body);
    return { id: t.id, ...body, sort: body.sort ?? t.sort };
  });

  app.delete<{ Params: { id: string } }>("/dining-tables/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const t = await loadTable(ctx.tenantId, ctx.storeIds, req.params.id);
    const open = await app.db.query(`SELECT 1 FROM tabs WHERE table_id = $1 AND status = 'open'`, [t.id]);
    if (open.rows[0]) throw new HttpError(409, "table_busy", "This table has an open bill. Pay or clear it on the till first.");
    // Kept, switched off, so past bills still show their table.
    await app.db.query(`UPDATE dining_tables SET active = false, updated_at = now() WHERE id = $1`, [t.id]);
    await adminAudit(app.db, ctx, "table.delete", "dining_table", t.id, { name: t.name });
    return { ok: true };
  });

  // Modifier groups belong to the business's products, so head office keeps them.
  async function saveGroup(ctx: Awaited<ReturnType<typeof app.authAdmin>>, id: string, body: z.infer<typeof GroupSchema>, isNew: boolean) {
    const ids = [...new Set(body.productIds)];
    if (ids.length) {
      const { rows } = await app.db.query(`SELECT COUNT(*)::int AS n FROM products WHERE tenant_id = $1 AND id = ANY($2)`, [ctx.tenantId, ids]);
      if (rows[0].n !== ids.length) throw new HttpError(400, "bad_request", "Some of those products do not exist");
    }
    const options = body.options.map((o) => ({ id: o.id ?? randomUUID(), name: o.name, nameAr: o.nameAr, price: o.price }));
    await withTx(app.db, async (tx) => {
      if (isNew) {
        await tx.query(
          `INSERT INTO modifier_groups (id, tenant_id, name, name_ar, min_choices, max_choices, options) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, ctx.tenantId, body.name, body.nameAr, body.minChoices, body.maxChoices, JSON.stringify(options)],
        );
      } else {
        await tx.query(
          `UPDATE modifier_groups SET name = $2, name_ar = $3, min_choices = $4, max_choices = $5, options = $6, updated_at = now() WHERE id = $1`,
          [id, body.name, body.nameAr, body.minChoices, body.maxChoices, JSON.stringify(options)],
        );
      }
      // Products gaining or losing the group change, so tills pick it up with the catalog.
      await tx.query(
        `UPDATE products SET modifier_group_ids = array_append(modifier_group_ids, $2::uuid), updated_at = now()
          WHERE tenant_id = $1 AND id = ANY($3) AND NOT ($2::uuid = ANY(modifier_group_ids))`,
        [ctx.tenantId, id, ids],
      );
      await tx.query(
        `UPDATE products SET modifier_group_ids = array_remove(modifier_group_ids, $2::uuid), updated_at = now()
          WHERE tenant_id = $1 AND $2::uuid = ANY(modifier_group_ids) AND NOT (id = ANY($3))`,
        [ctx.tenantId, id, ids],
      );
      await adminAudit(tx, ctx, isNew ? "modifier_group.create" : "modifier_group.update", "modifier_group", id, {
        name: body.name,
        options: options.length,
        products: ids.length,
      });
    });
    return { id, name: body.name, nameAr: body.nameAr, minChoices: body.minChoices, maxChoices: body.maxChoices, options, productIds: ids };
  }

  app.post("/modifier-groups", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const body = GroupSchema.parse(req.body);
    reply.status(201);
    return saveGroup(ctx, randomUUID(), body, true);
  });

  app.put<{ Params: { id: string } }>("/modifier-groups/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`SELECT 1 FROM modifier_groups WHERE id = $1 AND tenant_id = $2 AND active`, [req.params.id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Modifier group");
    return saveGroup(ctx, req.params.id, GroupSchema.parse(req.body), false);
  });

  app.delete<{ Params: { id: string } }>("/modifier-groups/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`SELECT name FROM modifier_groups WHERE id = $1 AND tenant_id = $2 AND active`, [req.params.id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Modifier group");
    await withTx(app.db, async (tx) => {
      await tx.query(`UPDATE modifier_groups SET active = false, updated_at = now() WHERE id = $1`, [req.params.id]);
      await tx.query(
        `UPDATE products SET modifier_group_ids = array_remove(modifier_group_ids, $2::uuid), updated_at = now() WHERE tenant_id = $1 AND $2::uuid = ANY(modifier_group_ids)`,
        [ctx.tenantId, req.params.id],
      );
      await adminAudit(tx, ctx, "modifier_group.delete", "modifier_group", req.params.id, { name: rows[0].name });
    });
    return { ok: true };
  });
}
