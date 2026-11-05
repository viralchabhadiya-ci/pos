import type { Db } from "../db.js";

/** Everything a till needs to know about where it is, returned on pairing and on refresh. */
export async function loadDeviceSetup(db: Db, registerId: string, role: "till" | "display" = "till") {
  const { rows } = await db.query(
    `SELECT r.id AS register_id, r.code AS register_code, r.name AS register_name,
            s.id AS store_id, s.code AS store_code, s.name AS store_name, s.name_ar AS store_name_ar,
            s.address, s.phone, s.trn, s.timezone, s.cash_rounding_step, s.receipt_footer,
            t.id AS tenant_id, t.name AS tenant_name, t.currency
       FROM registers r JOIN stores s ON s.id = r.store_id JOIN tenants t ON t.id = s.tenant_id
      WHERE r.id = $1`,
    [registerId],
  );
  const r = rows[0];
  const seq = await db.query(
    "SELECT COALESCE(MAX(seq), 0) AS last_seq FROM sessions WHERE register_id = $1",
    [registerId],
  );
  const open = await db.query(
    "SELECT id, seq, opened_by, opened_at, opening_cash FROM sessions WHERE register_id = $1 AND state = 'open'",
    [registerId],
  );
  return {
    tenant: { id: r.tenant_id, name: r.tenant_name, currency: r.currency },
    store: {
      id: r.store_id,
      code: r.store_code,
      name: r.store_name,
      nameAr: r.store_name_ar,
      address: r.address,
      phone: r.phone,
      trn: r.trn,
      timezone: r.timezone,
      cashRoundingStep: r.cash_rounding_step,
      receiptFooter: r.receipt_footer,
    },
    register: { id: r.register_id, code: r.register_code, name: r.register_name },
    device: { role },
    /** Where customers open digital receipts (the QR on the receipt); null when not set up. */
    publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, "") || null,
    lastSessionSeq: seq.rows[0].last_seq as number,
    openSession: open.rows[0]
      ? {
          id: open.rows[0].id,
          seq: open.rows[0].seq,
          openedBy: open.rows[0].opened_by,
          openedAt: open.rows[0].opened_at,
          openingCash: open.rows[0].opening_cash,
        }
      : null,
  };
}
