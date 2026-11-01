import type { DeviceContext } from "../app.js";
import type { Tx } from "../db.js";

export async function audit(
  tx: Tx,
  device: DeviceContext,
  userId: string | null,
  action: string,
  entity: string,
  entityId: string,
  data: Record<string, unknown> = {},
) {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, user_id, device_id, action, entity, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [device.tenantId, userId, device.deviceId, action, entity, entityId, JSON.stringify(data)],
  );
}
