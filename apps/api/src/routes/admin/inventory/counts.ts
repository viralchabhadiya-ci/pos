import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../../../app.js";
import { withTx, type Tx } from "../../../db.js";
import { adminAudit } from "../common.js";
import { bad, checkStore, checkVariants, checkWhole, empty, mustFind, nextNumber, Paging, writeMove, wrongState } from "./common.js";

const CreateSchema = z.object({
  storeId: z.string().uuid(),
  name: z.string().trim().max(120).nullish(),
  /** Count one category only; leave out for the whole store. */
  categoryId: z.string().uuid().nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

const LinesSchema = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        /** null clears a count entered by mistake. */
        counted: z.number().min(0).max(1_000_000).nullable(),
      }),
    )
    .min(1)
    .max(1000),
});

const CompleteSchema = z.object({
  /** Products nobody counted are taken as none on the shelf. Off by default: they are left as they are. */
  zeroUncounted: z.boolean().default(false),
});

interface CountRow {
  id: string;
  number: string;
  status: string;
  storeId: string;
}

const lock = (tx: Tx, ctx: AdminContext, id: string) =>
  mustFind<CountRow>(
    tx,
    `SELECT id, number, status, store_id AS "storeId" FROM stock_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [id, ctx.tenantId],
    "Stock count",
  );

/** What the ledger held at a moment, so sales made after a shelf was counted are left out. */
const AT_COUNT = `(SELECT COALESCE(SUM(m.qty), 0) FROM stock_moves m
                    WHERE m.store_id = c.store_id AND m.variant_id = l.variant_id AND m.at <= COALESCE(l.counted_at, now()))`;

export async function countRoutes(app: FastifyInstance) {
  app.get("/stock-counts", async (req) => {
    const ctx = await app.authAdmin(req);
    const f = Paging.extend({ status: z.enum(["open", "completed", "cancelled", "all"]).default("all") }).parse(req.query);
    const params: unknown[] = [ctx.tenantId];
    const where = ["c.tenant_id = $1"];
    if (f.status !== "all") where.push(`c.status = $${params.push(f.status)}`);
    const sql = `FROM stock_counts c WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      app.db.query(
        `SELECT c.id, c.number, c.name, c.status, c.store_id AS "storeId", s.name AS "storeName", cat.name AS "categoryName",
                c.created_at AS "createdAt", c.completed_at AS "completedAt",
                (SELECT COUNT(*)::int FROM stock_count_lines l WHERE l.count_id = c.id) AS lines,
                (SELECT COUNT(*)::int FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted IS NOT NULL) AS counted
           FROM stock_counts c JOIN stores s ON s.id = c.store_id LEFT JOIN categories cat ON cat.id = c.category_id
          WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
        params,
      ),
      app.db.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    ]);
    return { counts: list.rows, count: count.rows[0].n };
  });

  app.get<{ Params: { id: string } }>("/stock-counts/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const c = await mustFind<Record<string, unknown>>(
      app.db,
      `SELECT c.id, c.number, c.name, c.status, c.store_id AS "storeId", s.name AS "storeName", c.category_id AS "categoryId",
              cat.name AS "categoryName", c.notes, c.created_at AS "createdAt", cu.name AS "createdBy", c.completed_at AS "completedAt",
              du.name AS "completedBy"
         FROM stock_counts c JOIN stores s ON s.id = c.store_id LEFT JOIN categories cat ON cat.id = c.category_id
         LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users du ON du.id = c.completed_by
        WHERE c.id = $1 AND c.tenant_id = $2`,
      [req.params.id, ctx.tenantId],
      "Stock count",
    );
    const lines = await app.db.query(
      `SELECT l.variant_id AS "variantId", p.name, p.name_ar AS "nameAr", p.uom, v.barcode, v.sku, v.cost, l.expected, l.counted,
              l.counted_at AS "countedAt", l.adjustment,
              CASE WHEN c.status = 'open' THEN ${AT_COUNT} END AS "systemAtCount"
         FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id
         JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
        WHERE l.count_id = $1 ORDER BY p.name`,
      [req.params.id],
    );
    return { ...c, lines: lines.rows };
  });

  /** Starts a count with every active product in the store (or one category) and today's figure. */
  app.post("/stock-counts", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = CreateSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const store = await checkStore(tx, ctx.tenantId, b.storeId);
      let catName: string | null = null;
      if (b.categoryId) {
        const { rows } = await tx.query("SELECT name FROM categories WHERE id = $1 AND tenant_id = $2", [b.categoryId, ctx.tenantId]);
        if (!rows[0]) throw bad("That category does not exist");
        catName = rows[0].name;
      }
      const id = randomUUID();
      const number = await nextNumber(tx, ctx.tenantId, "count");
      const name = empty(b.name) ?? `${catName ?? "Full count"} · ${store.name}`;
      await tx.query(
        `INSERT INTO stock_counts (id, tenant_id, number, store_id, name, category_id, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, number, b.storeId, name, b.categoryId ?? null, empty(b.notes), ctx.userId],
      );
      const ins = await tx.query(
        `INSERT INTO stock_count_lines (count_id, variant_id, expected)
         SELECT $1, v.id, COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.store_id = $3 AND m.variant_id = v.id), 0)
           FROM variants v JOIN products p ON p.id = v.product_id
          WHERE v.tenant_id = $2 AND p.active AND v.active AND ($4::uuid IS NULL OR p.category_id = $4)`,
        [id, ctx.tenantId, b.storeId, b.categoryId ?? null],
      );
      await adminAudit(tx, ctx, "count.create", "stock_count", id, { number, storeId: b.storeId, lines: ins.rowCount });
      return { id, number, lines: ins.rowCount };
    });
  });

  /**
   * Saves counted quantities. Each line is stamped with the time it was counted. A product not on
   * the sheet (e.g. found on the shelf but switched off) is added.
   */
  app.put<{ Params: { id: string } }>("/stock-counts/:id/lines", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = LinesSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const c = await lock(tx, ctx, req.params.id);
      if (c.status !== "open") throw wrongState(`${c.number} is ${c.status}`);
      const variants = await checkVariants(tx, ctx.tenantId, b.lines.map((l) => l.variantId));
      for (const l of b.lines) {
        if (l.counted !== null) checkWhole(variants.get(l.variantId)!, l.counted);
        await tx.query(
          `INSERT INTO stock_count_lines (count_id, variant_id, expected, counted, counted_at)
           VALUES ($1, $2, COALESCE((SELECT SUM(qty) FROM stock_moves WHERE store_id = $5 AND variant_id = $2), 0), $3, $4)
           ON CONFLICT (count_id, variant_id) DO UPDATE SET counted = EXCLUDED.counted, counted_at = EXCLUDED.counted_at
             WHERE stock_count_lines.counted IS DISTINCT FROM EXCLUDED.counted`,
          [c.id, l.variantId, l.counted, l.counted === null ? null : new Date().toISOString(), c.storeId],
        );
      }
      return { id: c.id, saved: b.lines.length };
    });
  });

  /** Writes the differences to the stock ledger and closes the count. */
  app.post<{ Params: { id: string } }>("/stock-counts/:id/complete", async (req) => {
    const ctx = await app.authAdmin(req);
    const b = CompleteSchema.parse(req.body ?? {});
    return withTx(app.db, async (tx) => {
      const c = await lock(tx, ctx, req.params.id);
      if (c.status !== "open") throw wrongState(`${c.number} is already ${c.status}`);
      if (b.zeroUncounted) {
        await tx.query("UPDATE stock_count_lines SET counted = 0, counted_at = now() WHERE count_id = $1 AND counted IS NULL", [c.id]);
      }
      const { rows } = await tx.query(
        `SELECT l.variant_id AS "variantId", l.counted, ${AT_COUNT} AS system, v.cost
           FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id JOIN variants v ON v.id = l.variant_id
          WHERE l.count_id = $1 AND l.counted IS NOT NULL`,
        [c.id],
      );
      if (!rows.length) throw bad("Nothing has been counted yet");
      let changed = 0;
      let value = 0;
      for (const r of rows) {
        const adj = Math.round((r.counted - r.system) * 1000) / 1000;
        await tx.query("UPDATE stock_count_lines SET adjustment = $3 WHERE count_id = $1 AND variant_id = $2", [c.id, r.variantId, adj]);
        if (adj === 0) continue;
        changed++;
        value += Math.round(adj * (r.cost ?? 0));
        await writeMove(tx, ctx, { storeId: c.storeId, variantId: r.variantId, qty: adj, reason: "count", refId: c.id });
      }
      await tx.query("UPDATE stock_counts SET status = 'completed', completed_at = now(), completed_by = $2 WHERE id = $1", [c.id, ctx.userId]);
      await adminAudit(tx, ctx, "count.complete", "stock_count", c.id, { number: c.number, counted: rows.length, changed, value });
      return { id: c.id, status: "completed", counted: rows.length, changed, value };
    });
  });

  app.post<{ Params: { id: string } }>("/stock-counts/:id/cancel", async (req) => {
    const ctx = await app.authAdmin(req);
    return withTx(app.db, async (tx) => {
      const c = await lock(tx, ctx, req.params.id);
      if (c.status !== "open") throw wrongState(`${c.number} is already ${c.status}`);
      await tx.query("UPDATE stock_counts SET status = 'cancelled' WHERE id = $1", [c.id]);
      await adminAudit(tx, ctx, "count.cancel", "stock_count", c.id, { number: c.number });
      return { id: c.id, status: "cancelled" };
    });
  });
}
