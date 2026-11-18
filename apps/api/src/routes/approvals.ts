import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceContext } from "../app.js";
import type { Db, Tx } from "../db.js";
import { HttpError } from "../errors.js";
import { audit } from "./audit.js";

export const APPROVAL_KINDS = ["refund", "discount", "void", "price_override", "cash_out", "no_sale", "other"] as const;

/** How long a request waits for the owner before it lapses, by default and at most. */
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3600;

const RequestSchema = z.object({
  /** Made on the till before sending, so a retry is the same request. */
  id: z.string().uuid(),
  kind: z.enum(APPROVAL_KINDS),
  amount: z.number().int().min(0).max(100_000_000).optional(),
  summary: z.string().trim().min(3).max(200),
  reason: z.string().trim().max(300).optional(),
  details: z.record(z.unknown()).optional(),
  requestedBy: z.string().uuid().optional(),
  waitSeconds: z.number().int().min(30).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS),
});

/** Requests whose time ran out become expired, so nobody approves something the till gave up on. */
export async function expireApprovals(db: Db | Tx, tenantId: string) {
  await db.query(
    "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND status = 'pending' AND expires_at <= now()",
    [tenantId],
  );
}

/** What the till sees while it waits. */
function tillView(r: Record<string, unknown>) {
  return {
    id: r.id,
    kind: r.kind,
    amount: r.amount ?? null,
    summary: r.summary,
    status: r.status,
    decidedBy: r.decided_by_name ?? null,
    decidedById: r.decided_by ?? null,
    decidedAt: r.decided_at ?? null,
    note: r.decision_note ?? null,
    expiresAt: r.expires_at,
  };
}

async function load(db: Db | Tx, id: string, device: DeviceContext) {
  await expireApprovals(db, device.tenantId);
  const { rows } = await db.query(
    `SELECT a.*, u.name AS decided_by_name FROM approval_requests a LEFT JOIN users u ON u.id = a.decided_by
      WHERE a.id = $1 AND a.tenant_id = $2 AND a.register_id = $3`,
    [id, device.tenantId, device.registerId],
  );
  if (!rows[0]) throw new HttpError(404, "not_found", "Approval request not found");
  return rows[0];
}

/** Till side of remote approvals: ask, wait (poll), or give up. */
export async function approvalRoutes(app: FastifyInstance) {
  app.post("/approvals", async (req) => {
    const device = await app.authenticate(req);
    const body = RequestSchema.parse(req.body);
    if (body.requestedBy) {
      const user = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2", [body.requestedBy, device.tenantId]);
      if (!user.rows[0]) throw new HttpError(400, "bad_request", "Unknown staff member");
    }
    const inserted = await app.db.query(
      `INSERT INTO approval_requests (id, tenant_id, store_id, register_id, device_id, kind, amount, reason, summary,
                                      details, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(secs => $12))
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        body.id,
        device.tenantId,
        device.storeId,
        device.registerId,
        device.deviceId,
        body.kind,
        body.amount ?? null,
        body.reason ?? null,
        body.summary,
        JSON.stringify(body.details ?? {}),
        body.requestedBy ?? null,
        body.waitSeconds,
      ],
    );
    if (inserted.rows[0]) {
      await audit(app.db, device, body.requestedBy ?? null, "approval.request", "approval", body.id, {
        kind: body.kind,
        amount: body.amount ?? null,
      });
    }
    // A retry of the same id answers with the request as it stands.
    return tillView(await load(app.db, body.id, device));
  });

  app.get<{ Params: { id: string } }>("/approvals/:id", async (req) => {
    const device = await app.authenticate(req);
    return tillView(await load(app.db, req.params.id, device));
  });

  app.post<{ Params: { id: string } }>("/approvals/:id/cancel", async (req) => {
    const device = await app.authenticate(req);
    await load(app.db, req.params.id, device);
    await app.db.query("UPDATE approval_requests SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [
      req.params.id,
    ]);
    return tillView(await load(app.db, req.params.id, device));
  });
}
