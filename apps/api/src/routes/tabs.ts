import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceContext } from "../app.js";
import { withTx, type Db, type Tx } from "../db.js";
import { HttpError } from "../errors.js";

/** A tab's cart is the till's own shape; the server keeps it whole and only checks its size. */
const MAX_CART_BYTES = 256 * 1024;
const CartSchema = z.object({ lines: z.array(z.record(z.unknown())).max(500) }).passthrough();

const TabSchema = z.object({
  tableId: z.string().uuid().nullable(),
  name: z.string().trim().max(60).nullish(),
  guests: z.number().int().min(0).max(500).nullish(),
  cart: CartSchema,
  total: z.number().int(),
  /** The version the till last saw; 0 for a new tab. */
  version: z.number().int().min(0),
  userId: z.string().uuid(),
});

const TicketSchema = z.object({
  id: z.string().uuid(),
  tabId: z.string().uuid().nullish(),
  label: z.string().trim().min(1).max(60),
  guests: z.number().int().min(0).max(500).nullish(),
  lines: z
    .array(
      z.object({
        lineId: z.string().max(60),
        name: z.string().min(1).max(200),
        qty: z.number().finite(),
        modifiers: z.array(z.string().max(100)).max(30).default([]),
        note: z.string().max(500).nullish(),
      }),
    )
    .min(1)
    .max(200),
  userId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export const TAB_SELECT = `SELECT t.id, t.table_id AS "tableId", dt.name AS "tableName", dt.area, t.name, t.guests, t.cart, t.total, t.version, t.status,
         t.opened_at AS "openedAt", t.updated_at AS "updatedAt", t.closed_at AS "closedAt", t.order_id AS "orderId",
         ou.name AS "openedBy", uu.name AS "updatedBy"
    FROM tabs t LEFT JOIN dining_tables dt ON dt.id = t.table_id
    LEFT JOIN users ou ON ou.id = t.opened_by LEFT JOIN users uu ON uu.id = t.updated_by`;

async function loadTab(db: Db | Tx, device: DeviceContext, id: string) {
  const { rows } = await db.query(`${TAB_SELECT} WHERE t.id = $1 AND t.store_id = $2`, [id, device.storeId]);
  return rows[0] ?? null;
}

async function checkUser(db: Db | Tx, device: DeviceContext, userId: string) {
  const { rows } = await db.query(`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [userId, device.tenantId]);
  if (!rows[0]) throw new HttpError(400, "bad_request", "Unknown staff member");
}

async function checkTable(db: Db | Tx, device: DeviceContext, tableId: string | null) {
  if (!tableId) return;
  const { rows } = await db.query(`SELECT 1 FROM dining_tables WHERE id = $1 AND store_id = $2 AND active`, [tableId, device.storeId]);
  if (!rows[0]) throw new HttpError(400, "bad_request", "That table is not in this store");
}

/**
 * Restaurant tabs for the store's tills: open bills by table, shared so any till can add to
 * or take payment for a table, and kitchen tickets sent from the till.
 */
export async function tabRoutes(app: FastifyInstance) {
  const till = async (req: Parameters<typeof app.authenticate>[0]) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can do this");
    return device;
  };

  app.get("/tabs", async (req) => {
    const device = await till(req);
    const { rows } = await app.db.query(`${TAB_SELECT} WHERE t.store_id = $1 AND t.status = 'open' ORDER BY t.opened_at`, [device.storeId]);
    // Food the kitchen has marked ready and nobody has picked up yet, by tab.
    const ready = await app.db.query(
      `SELECT tab_id, COUNT(*)::int AS n FROM kitchen_tickets WHERE store_id = $1 AND status = 'ready' AND tab_id IS NOT NULL GROUP BY tab_id`,
      [device.storeId],
    );
    const readyBy = new Map(ready.rows.map((r) => [r.tab_id as string, r.n as number]));
    return { tabs: rows.map((t) => ({ ...t, readyTickets: readyBy.get(t.id) ?? 0 })), serverTime: new Date().toISOString() };
  });

  app.get<{ Params: { id: string } }>("/tabs/:id", async (req) => {
    const device = await till(req);
    const tab = await loadTab(app.db, device, z.string().uuid().parse(req.params.id));
    if (!tab) throw new HttpError(404, "not_found", "Tab not found");
    return tab;
  });

  /** Saves a tab. A till that saw an older version gets 409 with the tab as it is now. */
  app.put<{ Params: { id: string } }>("/tabs/:id", async (req, reply) => {
    const device = await till(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = TabSchema.parse(req.body);
    const cart = JSON.stringify(body.cart);
    if (cart.length > MAX_CART_BYTES) throw new HttpError(413, "too_big", "This bill is too long. Pay part of it first.");
    await checkUser(app.db, device, body.userId);
    await checkTable(app.db, device, body.tableId);

    const result = await withTx(app.db, async (tx) => {
      const { rows } = await tx.query(`SELECT id, store_id, status, version, table_id FROM tabs WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, device.tenantId]);
      const now = rows[0];
      if (now && now.store_id !== device.storeId) throw new HttpError(404, "not_found", "Tab not found");
      if (now && now.status !== "open") return { conflict: "closed" as const };
      if (now && now.version !== body.version) return { conflict: "changed" as const };
      if (!now && body.version !== 0) return { conflict: "closed" as const };
      if (body.tableId && body.tableId !== now?.table_id) {
        const busy = await tx.query(`SELECT id FROM tabs WHERE table_id = $1 AND status = 'open' AND id <> $2`, [body.tableId, id]);
        if (busy.rows[0]) return { conflict: "table_busy" as const, other: busy.rows[0].id as string };
      }
      if (now) {
        await tx.query(
          `UPDATE tabs SET table_id = $2, name = $3, guests = $4, cart = $5, total = $6, version = version + 1, updated_by = $7, updated_at = now() WHERE id = $1`,
          [id, body.tableId, body.name ?? null, body.guests ?? null, cart, body.total, body.userId],
        );
        if (now.table_id !== body.tableId) {
          await tx.query(`INSERT INTO audit_log (tenant_id, device_id, user_id, action, entity, entity_id, data) VALUES ($1, $2, $3, 'tab.move', 'tab', $4, $5)`, [
            device.tenantId,
            device.deviceId,
            body.userId,
            id,
            JSON.stringify({ from: now.table_id, to: body.tableId }),
          ]);
        }
      } else {
        await tx.query(
          `INSERT INTO tabs (id, tenant_id, store_id, table_id, name, guests, cart, total, opened_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [id, device.tenantId, device.storeId, body.tableId, body.name ?? null, body.guests ?? null, cart, body.total, body.userId],
        );
      }
      return { ok: true as const };
    });

    if ("conflict" in result) {
      reply.status(409);
      const tab = await loadTab(app.db, device, result.conflict === "table_busy" ? result.other! : id);
      const message =
        result.conflict === "closed"
          ? "This bill was already paid or cleared on another till."
          : result.conflict === "changed"
            ? "Another till changed this bill. Check the items and try again."
            : "That table already has an open bill.";
      return { error: result.conflict, message, tab };
    }
    return loadTab(app.db, device, id);
  });

  /** Closes a tab: paid (with the sale) or cleared (nothing to pay, or let go with a reason). */
  app.post<{ Params: { id: string } }>("/tabs/:id/close", async (req) => {
    const device = await till(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({ userId: z.string().uuid(), orderId: z.string().uuid().nullish(), reason: z.string().trim().max(200).nullish() }).parse(req.body);
    await checkUser(app.db, device, body.userId);
    const tab = await loadTab(app.db, device, id);
    if (!tab) throw new HttpError(404, "not_found", "Tab not found");
    if (tab.status !== "open") return tab;
    const lines = (tab.cart as { lines?: unknown[] }).lines?.length ?? 0;
    if (!body.orderId && lines && !body.reason) throw new HttpError(400, "reason_needed", "Give a reason to clear a bill that still has items");
    await app.db.query(
      `UPDATE tabs SET status = $2, order_id = COALESCE(order_id, $3), close_reason = $4, closed_at = now(), updated_by = $5, updated_at = now() WHERE id = $1 AND status = 'open'`,
      [id, body.orderId ? "paid" : "cleared", body.orderId ?? null, body.reason ?? null, body.userId],
    );
    if (!body.orderId && lines) {
      await app.db.query(`INSERT INTO audit_log (tenant_id, device_id, user_id, action, entity, entity_id, data) VALUES ($1, $2, $3, 'tab.clear', 'tab', $4, $5)`, [
        device.tenantId,
        device.deviceId,
        body.userId,
        id,
        JSON.stringify({ reason: body.reason, total: tab.total, table: tab.tableName }),
      ]);
    }
    return loadTab(app.db, device, id);
  });

  /** A kitchen ticket from the till; sent through the outbox, so the same id is saved once. */
  app.post("/kitchen-tickets", async (req, reply) => {
    const device = await till(req);
    const body = TicketSchema.parse(req.body);
    await checkUser(app.db, device, body.userId);
    if (body.tabId) {
      const { rows } = await app.db.query(`SELECT 1 FROM tabs WHERE id = $1 AND store_id = $2`, [body.tabId, device.storeId]);
      // The tab may not have reached the server yet; the ticket still counts.
      if (!rows[0]) body.tabId = null;
    }
    const { rowCount } = await app.db.query(
      `INSERT INTO kitchen_tickets (id, tenant_id, store_id, register_id, tab_id, label, guests, lines, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [body.id, device.tenantId, device.storeId, device.registerId, body.tabId ?? null, body.label, body.guests ?? null, JSON.stringify(body.lines), body.userId, body.createdAt],
    );
    reply.status(rowCount ? 201 : 200);
    return { id: body.id, status: rowCount ? "created" : "duplicate" };
  });
}
