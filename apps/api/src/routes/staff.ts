import { randomUUID } from "node:crypto";
import { pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import { DEFAULT_SCALE_RULES, parseScaleBarcode, type ScaleBarcodeRule } from "@pos/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdminContext } from "../app.js";
import { withTx } from "../db.js";
import { HttpError, unauthorized } from "../errors.js";
import { hashToken, newDeviceToken, PIN_ITERATIONS } from "../security.js";
import { CountLinesSchema, saveCountLines } from "./admin/inventory/counts.js";
import { ReceivePurchaseSchema, receivePurchaseOrder } from "./admin/inventory/purchases.js";
import { adminAudit } from "./admin/common.js";
import { loadDeviceSetup } from "./setup.js";

const pbkdf2Async = promisify(pbkdf2);

/** Someone signed in on a staff phone, in a store. */
export interface StaffContext {
  userId: string;
  tenantId: string;
  role: "cashier" | "manager" | "owner";
  name: string;
  storeId: string;
  deviceId: string;
  registerId: string;
}

/** How long a staff sign-in lasts without use; each request pushes it on. */
const SESSION_HOURS = 12;
/** Wrong PINs in a row on one phone before it waits. */
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

const failures = new Map<string, { count: number; until: number }>();

async function pinMatches(pin: string, salt: string, hash: string) {
  const key = await pbkdf2Async(pin, Buffer.from(salt, "hex"), PIN_ITERATIONS, 32, "sha256");
  return key.toString("hex") === hash;
}

const forbidden = (message: string) => new HttpError(403, "forbidden", message);

/** Inventory helpers record who did it the same way for back office and staff phone. */
const asActor = (s: StaffContext): AdminContext => ({ userId: s.userId, tenantId: s.tenantId, role: s.role === "owner" ? "owner" : "manager", name: s.name });

export async function staffRoutes(app: FastifyInstance) {
  /** The phone's own token, which must belong to a staff device. */
  const staffDevice = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const { rows } = await app.db.query(
      `UPDATE devices d SET last_seen_at = now() FROM registers r JOIN stores s ON s.id = r.store_id
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND d.role = 'staff' AND r.id = d.register_id
        RETURNING d.id, d.register_id, r.store_id, s.tenant_id`,
      [hashToken(header.slice(7))],
    );
    if (!rows[0]) throw unauthorized();
    return { deviceId: rows[0].id as string, registerId: rows[0].register_id as string, storeId: rows[0].store_id as string, tenantId: rows[0].tenant_id as string };
  };

  /** The device plus the person signed in on it (X-Staff-Session). */
  const authStaff = async (req: FastifyRequest): Promise<StaffContext> => {
    const device = await staffDevice(req);
    const token = req.headers["x-staff-session"];
    if (typeof token !== "string" || !token) throw new HttpError(401, "signed_out", "Sign in with your PIN");
    const { rows } = await app.db.query(
      `UPDATE staff_sessions ss SET expires_at = now() + make_interval(hours => ${SESSION_HOURS})
         FROM users u, tenants t
        WHERE ss.token_hash = $1 AND ss.device_id = $2 AND ss.revoked_at IS NULL AND ss.expires_at > now()
          AND u.id = ss.user_id AND u.active AND t.id = ss.tenant_id AND t.status NOT IN ('suspended', 'cancelled')
        RETURNING u.id, u.role, u.name`,
      [hashToken(token), device.deviceId],
    );
    if (!rows[0]) throw new HttpError(401, "signed_out", "Sign in with your PIN");
    return { ...device, userId: rows[0].id, role: rows[0].role, name: rows[0].name };
  };

  const needManager = (s: StaffContext, what: string) => {
    if (s.role === "cashier") throw forbidden(`Ask a manager to ${what}`);
  };

  app.get("/staff/device", async (req) => {
    const d = await staffDevice(req);
    return loadDeviceSetup(app.db, d.registerId, "staff");
  });

  app.post("/staff/login", async (req) => {
    const d = await staffDevice(req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{4,8}$/, "Enter your PIN") }).parse(req.body);
    const f = failures.get(d.deviceId);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      throw new HttpError(429, "too_many_tries", "Too many wrong PINs. Wait 5 minutes and try again.");
    }
    const { rows } = await app.db.query(
      "SELECT id, name, role, pin_salt, pin_hash FROM users WHERE tenant_id = $1 AND active",
      [d.tenantId],
    );
    const checks = await Promise.all(rows.map((u) => pinMatches(pin, u.pin_salt, u.pin_hash)));
    const user = rows[checks.indexOf(true)];
    if (!user) {
      const count = (f && f.until > Date.now() ? f.count : 0) + 1;
      failures.set(d.deviceId, { count, until: Date.now() + LOCK_MS });
      throw new HttpError(401, "wrong_pin", "That PIN is not right");
    }
    failures.delete(d.deviceId);
    const { token, hash } = newDeviceToken();
    await app.db.query(
      `INSERT INTO staff_sessions (id, token_hash, device_id, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => ${SESSION_HOURS}))`,
      [randomUUID(), hash, d.deviceId, user.id, d.tenantId],
    );
    return { token, user: { id: user.id, name: user.name, role: user.role } };
  });

  app.post("/staff/logout", async (req) => {
    const d = await staffDevice(req);
    const token = req.headers["x-staff-session"];
    if (typeof token === "string") {
      await app.db.query("UPDATE staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND device_id = $2", [hashToken(token), d.deviceId]);
    }
    return { ok: true };
  });

  /**
   * Price check: a barcode (also extra barcodes and scale barcodes), SKU or item code, or words
   * from the name. Shows price, VAT and stock here and in the other stores.
   */
  app.get("/staff/lookup", async (req) => {
    const s = await authStaff(req);
    const { q } = z.object({ q: z.string().trim().min(1).max(80) }).parse(req.query);
    const { rows: scale } = await app.db.query("SELECT rules FROM scale_settings WHERE tenant_id = $1", [s.tenantId]);
    const rules = (scale[0]?.rules ?? DEFAULT_SCALE_RULES) as ScaleBarcodeRule[];
    const weighed = /^\d{13}$/.test(q) ? parseScaleBarcode(q, rules) : null;
    const { rows } = await app.db.query(
      `SELECT p.id AS "productId", v.id AS "variantId", p.name, p.name_ar AS "nameAr", p.uom, p.active, c.name AS "categoryName",
              v.price, v.barcode, v.sku, v.plu, v.reorder_level AS "reorderLevel", t.name AS "taxName", t.rate_bp AS "taxRateBp",
              COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.variant_id = v.id AND m.store_id = $3), 0)::float AS "onHand",
              COALESCE((SELECT json_agg(x ORDER BY x.name) FROM (
                 SELECT st.name, COALESCE(SUM(m.qty), 0)::float AS qty FROM stores st
                   LEFT JOIN stock_moves m ON m.store_id = st.id AND m.variant_id = v.id
                  WHERE st.tenant_id = $1 AND st.id <> $3 GROUP BY st.id) x), '[]') AS "otherStores",
              (SELECT MAX(m.at) FROM stock_moves m WHERE m.variant_id = v.id AND m.store_id = $3 AND m.reason = 'receive') AS "lastReceivedAt"
         FROM variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN taxes t ON t.id = p.tax_id
        WHERE v.tenant_id = $1 AND (
              v.barcode = $2 OR $2 = ANY(v.extra_barcodes) OR v.sku = $2 OR v.plu = $4
              OR ($5 AND (p.name ILIKE '%' || $2 || '%' OR p.name_ar ILIKE '%' || $2 || '%')))
        ORDER BY (v.barcode = $2 OR v.plu = $4) DESC, p.active DESC, p.name LIMIT 20`,
      [s.tenantId, q, s.storeId, weighed?.plu ?? null, !/^\d+$/.test(q) || q.length < 6],
    );
    return {
      items: rows,
      // A weighed item's barcode carries its weight or price; the phone shows what that label means.
      scale: weighed ? { kind: weighed.rule.kind, value: weighed.value } : null,
    };
  });

  /** Open stock counts in this store. */
  app.get("/staff/counts", async (req) => {
    const s = await authStaff(req);
    const { rows } = await app.db.query(
      `SELECT c.id, c.number, c.name, c.created_at AS "createdAt",
              (SELECT COUNT(*)::int FROM stock_count_lines l WHERE l.count_id = c.id) AS lines,
              (SELECT COUNT(*)::int FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted IS NOT NULL) AS counted
         FROM stock_counts c WHERE c.tenant_id = $1 AND c.store_id = $2 AND c.status = 'open' ORDER BY c.created_at DESC`,
      [s.tenantId, s.storeId],
    );
    return { counts: rows };
  });

  /** One count's sheet. The expected figure is left out so counters count what they see. */
  app.get<{ Params: { id: string } }>("/staff/counts/:id", async (req) => {
    const s = await authStaff(req);
    const id = z.string().uuid().parse(req.params.id);
    const { rows: head } = await app.db.query(
      "SELECT id, number, name, status FROM stock_counts WHERE id = $1 AND tenant_id = $2 AND store_id = $3",
      [id, s.tenantId, s.storeId],
    );
    if (!head[0]) throw new HttpError(404, "not_found", "Stock count not found");
    const { rows } = await app.db.query(
      `SELECT l.variant_id AS "variantId", p.name, p.uom, v.barcode, v.extra_barcodes AS "extraBarcodes", v.sku, l.counted,
              l.counted_at AS "countedAt"
         FROM stock_count_lines l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
        WHERE l.count_id = $1 ORDER BY p.name`,
      [id],
    );
    return { ...head[0], lines: rows };
  });

  app.put<{ Params: { id: string } }>("/staff/counts/:id/lines", async (req) => {
    const s = await authStaff(req);
    const id = z.string().uuid().parse(req.params.id);
    const b = CountLinesSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const r = await saveCountLines(tx, s, id, b.lines);
      if (r.storeId !== s.storeId) throw new HttpError(404, "not_found", "Stock count not found");
      return { id: r.id, saved: r.saved };
    });
  });

  /** Orders waiting for goods in this store. */
  app.get("/staff/deliveries", async (req) => {
    const s = await authStaff(req);
    const { rows } = await app.db.query(
      `SELECT po.id, po.number, po.status, po.expected_on AS "expectedOn", sp.name AS "supplierName",
              (SELECT COUNT(*)::int FROM purchase_order_lines l WHERE l.po_id = po.id) AS lines
         FROM purchase_orders po JOIN suppliers sp ON sp.id = po.supplier_id
        WHERE po.tenant_id = $1 AND po.store_id = $2 AND po.status IN ('ordered', 'partial')
        ORDER BY po.expected_on NULLS LAST, po.number`,
      [s.tenantId, s.storeId],
    );
    return { orders: rows };
  });

  app.get<{ Params: { id: string } }>("/staff/deliveries/:id", async (req) => {
    const s = await authStaff(req);
    const id = z.string().uuid().parse(req.params.id);
    const { rows: head } = await app.db.query(
      `SELECT po.id, po.number, po.status, sp.name AS "supplierName" FROM purchase_orders po JOIN suppliers sp ON sp.id = po.supplier_id
        WHERE po.id = $1 AND po.tenant_id = $2 AND po.store_id = $3`,
      [id, s.tenantId, s.storeId],
    );
    if (!head[0]) throw new HttpError(404, "not_found", "Order not found");
    const { rows } = await app.db.query(
      `SELECT l.id, l.variant_id AS "variantId", p.name, p.uom, v.barcode, v.extra_barcodes AS "extraBarcodes", v.sku,
              v.track_expiry AS "trackExpiry", l.qty_ordered::float AS ordered, l.qty_received::float AS received
         FROM purchase_order_lines l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
        WHERE l.po_id = $1 ORDER BY p.name`,
      [id],
    );
    return { ...head[0], lines: rows };
  });

  /** Books a delivery against the order. Managers and owners only, since it changes stock and cost. */
  app.post<{ Params: { id: string } }>("/staff/deliveries/:id/receive", async (req) => {
    const s = await authStaff(req);
    needManager(s, "receive deliveries");
    const id = z.string().uuid().parse(req.params.id);
    const b = ReceivePurchaseSchema.parse(req.body);
    return withTx(app.db, async (tx) => {
      const { rows } = await tx.query("SELECT 1 FROM purchase_orders WHERE id = $1 AND tenant_id = $2 AND store_id = $3", [id, s.tenantId, s.storeId]);
      if (!rows[0]) throw new HttpError(404, "not_found", "Order not found");
      return receivePurchaseOrder(tx, asActor(s), id, { ...b, notes: b.notes ?? `Received on ${s.name}'s staff phone` });
    });
  });

  /** Asks for shelf labels (a new price, a torn label); the back office prints them. */
  app.post("/staff/labels", async (req) => {
    const s = await authStaff(req);
    const b = z
      .object({ variantId: z.string().uuid(), copies: z.number().int().min(1).max(100).default(1), reason: z.string().trim().max(120).nullish() })
      .parse(req.body);
    const { rows } = await app.db.query("SELECT 1 FROM variants WHERE id = $1 AND tenant_id = $2", [b.variantId, s.tenantId]);
    if (!rows[0]) throw new HttpError(404, "not_found", "Product not found");
    const id = randomUUID();
    await app.db.query(
      `INSERT INTO label_requests (id, tenant_id, store_id, variant_id, copies, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, s.tenantId, s.storeId, b.variantId, b.copies, b.reason ?? null, s.userId],
    );
    await adminAudit(app.db, asActor(s), "label.request", "variant", b.variantId, { copies: b.copies, storeId: s.storeId, device: s.deviceId });
    return { id };
  });

  app.get("/staff/labels", async (req) => {
    const s = await authStaff(req);
    const { rows } = await app.db.query(
      `SELECT lr.id, p.name, lr.copies, lr.created_at AS "createdAt", u.name AS "requestedBy"
         FROM label_requests lr JOIN variants v ON v.id = lr.variant_id JOIN products p ON p.id = v.product_id
         LEFT JOIN users u ON u.id = lr.requested_by
        WHERE lr.tenant_id = $1 AND lr.store_id = $2 AND lr.printed_at IS NULL ORDER BY lr.created_at DESC LIMIT 100`,
      [s.tenantId, s.storeId],
    );
    return { requests: rows };
  });
}
