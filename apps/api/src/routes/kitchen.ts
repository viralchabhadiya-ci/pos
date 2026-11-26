import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";

/** Tickets done longer ago than this drop off the screen's "Recall" list. */
const RECALL_MINUTES = 60;

const TICKET_SELECT = `SELECT k.id, k.tab_id AS "tabId", k.label, k.guests, k.lines, k.done_lines AS "doneLines", k.status,
         k.created_at AS "createdAt", k.started_at AS "startedAt", k.ready_at AS "readyAt", k.done_at AS "doneAt",
         u.name AS "createdBy", r.name AS "registerName"
    FROM kitchen_tickets k LEFT JOIN users u ON u.id = k.created_by LEFT JOIN registers r ON r.id = k.register_id`;

const StatusSchema = z.object({ status: z.enum(["new", "preparing", "ready", "done"]) });
const LineSchema = z.object({ lineId: z.string().min(1).max(60), done: z.boolean() });

/**
 * The kitchen display: a screen paired as a "kitchen" device sees its store's tickets and moves
 * them along: new, preparing, ready (the waiter is told), done (picked up).
 */
export async function kitchenRoutes(app: FastifyInstance) {
  const kitchen = async (req: Parameters<typeof app.authenticate>[0]) => {
    const device = await app.authenticate(req);
    if (device.role !== "kitchen") throw new HttpError(403, "forbidden", "Only a kitchen screen can do this");
    return device;
  };

  app.get("/kitchen/tickets", async (req) => {
    const device = await kitchen(req);
    const open = await app.db.query(`${TICKET_SELECT} WHERE k.store_id = $1 AND k.status <> 'done' ORDER BY k.created_at LIMIT 200`, [device.storeId]);
    const recent = await app.db.query(
      `${TICKET_SELECT} WHERE k.store_id = $1 AND k.status = 'done' AND k.done_at > now() - make_interval(mins => $2) ORDER BY k.done_at DESC LIMIT 20`,
      [device.storeId, RECALL_MINUTES],
    );
    return { tickets: open.rows, recent: recent.rows, serverTime: new Date().toISOString() };
  });

  /** Moves a ticket along, or back (Recall puts a done ticket back to ready). */
  app.post<{ Params: { id: string } }>("/kitchen/tickets/:id/status", async (req) => {
    const device = await kitchen(req);
    const id = z.string().uuid().parse(req.params.id);
    const { status } = StatusSchema.parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE kitchen_tickets SET status = $3, updated_at = now(),
              started_at = CASE WHEN $3 IN ('preparing', 'ready', 'done') THEN COALESCE(started_at, now()) ELSE started_at END,
              ready_at = CASE WHEN $3 IN ('ready', 'done') THEN COALESCE(ready_at, now()) WHEN $3 IN ('new', 'preparing') THEN NULL ELSE ready_at END,
              done_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
              done_lines = CASE WHEN $3 IN ('ready', 'done') THEN ARRAY(SELECT jsonb_array_elements(lines)->>'lineId') ELSE done_lines END
        WHERE id = $1 AND store_id = $2 RETURNING id`,
      [id, device.storeId, status],
    );
    if (!rows[0]) throw new HttpError(404, "not_found", "Ticket not found");
    return (await app.db.query(`${TICKET_SELECT} WHERE k.id = $1`, [id])).rows[0];
  });

  /** Ticks an item off (or back on). The first tick starts the ticket. */
  app.post<{ Params: { id: string } }>("/kitchen/tickets/:id/lines", async (req) => {
    const device = await kitchen(req);
    const id = z.string().uuid().parse(req.params.id);
    const { lineId, done } = LineSchema.parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE kitchen_tickets SET updated_at = now(),
              done_lines = CASE WHEN $4 THEN array_append(array_remove(done_lines, $3), $3) ELSE array_remove(done_lines, $3) END,
              status = CASE WHEN status = 'new' AND $4 THEN 'preparing' ELSE status END,
              started_at = CASE WHEN $4 THEN COALESCE(started_at, now()) ELSE started_at END
        WHERE id = $1 AND store_id = $2 AND lines @> jsonb_build_array(jsonb_build_object('lineId', $3::text)) RETURNING id`,
      [id, device.storeId, lineId, done],
    );
    if (!rows[0]) throw new HttpError(404, "not_found", "Ticket or item not found");
    return (await app.db.query(`${TICKET_SELECT} WHERE k.id = $1`, [id])).rows[0];
  });
}
