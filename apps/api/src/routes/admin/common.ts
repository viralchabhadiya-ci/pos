import type { AdminContext } from "../../app.js";
import type { Db, Tx } from "../../db.js";
import { HttpError } from "../../errors.js";

/** Back office changes go to the same audit log as till actions, without a device. */
export async function adminAudit(
  db: Db | Tx,
  ctx: AdminContext,
  action: string,
  entity: string,
  entityId: string,
  data: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.tenantId, ctx.userId, action, entity, entityId, JSON.stringify(data)],
  );
}

export const forbidden = (message: string) => new HttpError(403, "forbidden", message);

/** Postgres unique violation, e.g. a barcode or email already in use. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && (!constraint || e.constraint === constraint);
}
