import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as Sqlite } from "node:sqlite";

// Loaded through require because bundlers used in tests do not know the newer built-in yet.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * The hub's own SQLite file: known devices, the forward queue, a copy of every catalog
 * it has seen, and the orders and customers that passed through it (for lookups while
 * the cloud is unreachable).
 */

export const CATALOG_KINDS = ["taxes", "categories", "products", "variants", "paymentMethods", "users"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export interface DeviceRow {
  tokenHash: string;
  token: string;
  tenantId: string;
  registerId: string;
  setup: DeviceSetup;
}

export interface DeviceSetup {
  tenant: { id: string };
  register: { id: string };
  lastSessionSeq: number;
  openSession: { id: string; seq: number; openedBy: string; openedAt: string; openingCash: number } | null;
  [key: string]: unknown;
}

export type OutboxKind = "orders" | "session.open" | "session.close" | "cash.move" | "customer";

export interface OutboxRow {
  seq: number;
  tokenHash: string;
  kind: OutboxKind;
  path: string;
  body: unknown;
  attempts: number;
}

export interface LocalOrder {
  id: string;
  number: string;
  total: number;
  createdAt: string;
  refundOfOrderId: string | null;
  body: {
    id: string;
    number: string;
    lines: { id: string; variantId: string; name: string; qty: number; unitPrice: number; discountBp: number; taxId: string | null }[];
    payments: { id: string; methodId: string; kind: string; amount: number }[];
    [key: string]: unknown;
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  token_hash TEXT PRIMARY KEY, token TEXT NOT NULL, tenant_id TEXT NOT NULL,
  register_id TEXT NOT NULL, setup TEXT NOT NULL, seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL, kind TEXT NOT NULL,
  path TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE IF NOT EXISTS rejected (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT, path TEXT NOT NULL,
  body TEXT NOT NULL, error TEXT NOT NULL, message TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, number TEXT NOT NULL, total INTEGER NOT NULL,
  refund_of TEXT, created_at TEXT NOT NULL, body TEXT NOT NULL, rejected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_number ON orders (tenant_id, number);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
  changed_at TEXT NOT NULL, PRIMARY KEY (tenant_id, kind, id)
);
CREATE TABLE IF NOT EXISTS catalog_state (tenant_id TEXT PRIMARY KEY, cloud_time TEXT NOT NULL);
`;

export class HubStore {
  readonly db: Sqlite;

  constructor(dataDir: string | ":memory:") {
    if (dataDir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, "hub.sqlite"));
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    }
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // Devices

  getDevice(tokenHash: string): DeviceRow | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(tokenHash) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash!,
      token: row.token!,
      tenantId: row.tenant_id!,
      registerId: row.register_id!,
      setup: JSON.parse(row.setup!),
    };
  }

  putDevice(tokenHash: string, token: string, setup: DeviceSetup) {
    this.db
      .prepare(
        `INSERT INTO devices (token_hash, token, tenant_id, register_id, setup, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (token_hash) DO UPDATE SET setup = excluded.setup, tenant_id = excluded.tenant_id,
           register_id = excluded.register_id, seen_at = excluded.seen_at`,
      )
      .run(tokenHash, token, setup.tenant.id, setup.register.id, JSON.stringify(setup), new Date().toISOString());
  }

  updateSetup(tokenHash: string, fn: (s: DeviceSetup) => DeviceSetup) {
    const device = this.getDevice(tokenHash);
    if (!device) return;
    this.db.prepare("UPDATE devices SET setup = ? WHERE token_hash = ?").run(JSON.stringify(fn(device.setup)), tokenHash);
  }

  /** Every device on the same register shares the shift, so their cached setups move together. */
  updateRegisterSetups(registerId: string, fn: (s: DeviceSetup) => DeviceSetup) {
    const rows = this.db.prepare("SELECT token_hash FROM devices WHERE register_id = ?").all(registerId) as { token_hash: string }[];
    for (const r of rows) this.updateSetup(r.token_hash, fn);
  }

  removeDevice(tokenHash: string) {
    this.db.prepare("DELETE FROM devices WHERE token_hash = ?").run(tokenHash);
  }

  /** One recently seen device per tenant, whose token the hub uses for its own catalog pulls. */
  tenantDevices(): { tenantId: string; tokenHash: string; token: string }[] {
    const rows = this.db
      .prepare(
        `SELECT tenant_id, token_hash, token FROM devices d
          WHERE seen_at = (SELECT MAX(seen_at) FROM devices WHERE tenant_id = d.tenant_id)
          GROUP BY tenant_id`,
      )
      .all() as Record<string, string>[];
    return rows.map((r) => ({ tenantId: r.tenant_id!, tokenHash: r.token_hash!, token: r.token! }));
  }

  // Outbox

  enqueue(tokenHash: string, kind: OutboxKind, path: string, body: unknown) {
    this.db
      .prepare("INSERT INTO outbox (token_hash, kind, path, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, kind, path, JSON.stringify(body), new Date().toISOString());
  }

  outboxHead(limit = 20): OutboxRow[] {
    const rows = this.db.prepare("SELECT * FROM outbox ORDER BY seq LIMIT ?").all(limit) as Record<string, string | number>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      tokenHash: String(r.token_hash),
      kind: r.kind as OutboxKind,
      path: String(r.path),
      body: JSON.parse(String(r.body)),
      attempts: Number(r.attempts),
    }));
  }

  pendingCount(tokenHash?: string): number {
    const row = tokenHash
      ? this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE token_hash = ?").get(tokenHash)
      : this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get();
    return Number((row as { n: number }).n);
  }

  removeOutbox(seq: number) {
    this.db.prepare("DELETE FROM outbox WHERE seq = ?").run(seq);
  }

  noteAttempt(seq: number, error: string) {
    this.db.prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?").run(error, seq);
  }

  // Rejections: work the cloud refused after the hub had already accepted it.

  reject(kind: string, refId: string | null, path: string, body: unknown, error: string, message?: string) {
    this.db
      .prepare("INSERT INTO rejected (kind, ref_id, path, body, error, message, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(kind, refId, path, JSON.stringify(body), error, message ?? null, new Date().toISOString());
    if (kind === "orders" && refId) this.markOrderRejected(refId);
  }

  markOrderRejected(id: string) {
    this.db.prepare("UPDATE orders SET rejected = 1 WHERE id = ?").run(id);
  }

  rejections(limit = 50) {
    return this.db.prepare("SELECT id, kind, ref_id AS refId, error, message, at FROM rejected ORDER BY id DESC LIMIT ?").all(limit);
  }

  rejectedCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM rejected").get() as { n: number }).n);
  }

  // Orders and customers seen by the hub

  putOrder(tenantId: string, order: LocalOrder["body"] & { createdAt: string; refundOfOrderId: string | null; clientTotals: { total: number } }) {
    this.db
      .prepare(
        `INSERT INTO orders (id, tenant_id, number, total, refund_of, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(order.id, tenantId, order.number, order.clientTotals.total, order.refundOfOrderId, order.createdAt, JSON.stringify(order));
  }

  hasOrder(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM orders WHERE id = ?").get(id);
  }

  getOrder(tenantId: string, id: string): LocalOrder | undefined {
    const row = this.db.prepare("SELECT * FROM orders WHERE tenant_id = ? AND id = ? AND rejected = 0").get(tenantId, id);
    return row ? toOrder(row as Record<string, string | number | null>) : undefined;
  }

  findOrders(tenantId: string, number: string): LocalOrder[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE tenant_id = ? AND number = ? AND refund_of IS NULL AND rejected = 0")
      .all(tenantId, number);
    return rows.map((r) => toOrder(r as Record<string, string | number | null>));
  }

  putCustomer(tenantId: string, c: { id: string; name: string; phone?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO customers (id, tenant_id, name, phone, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, phone = excluded.phone, body = excluded.body`,
      )
      .run(c.id, tenantId, c.name, c.phone ?? null, JSON.stringify(c));
  }

  searchCustomers(tenantId: string, q: string): Record<string, unknown>[] {
    const digits = q.replace(/\D/g, "");
    const rows = this.db
      .prepare(
        `SELECT body FROM customers WHERE tenant_id = ? AND (name LIKE ? OR (? <> '' AND phone LIKE ?))
          ORDER BY name LIMIT 20`,
      )
      .all(tenantId, `%${q}%`, digits, `%${digits}`) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body));
  }

  // Catalog copy

  /** Stores rows from a cloud catalog response; a row's change time only moves when its content changes. */
  mergeCatalog(tenantId: string, data: Partial<Record<CatalogKind, { id: string }[]>>, cloudTime?: string) {
    const now = new Date().toISOString();
    const get = this.db.prepare("SELECT body FROM catalog WHERE tenant_id = ? AND kind = ? AND id = ?");
    const put = this.db.prepare(
      `INSERT INTO catalog (tenant_id, kind, id, body, changed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, kind, id) DO UPDATE SET body = excluded.body, changed_at = excluded.changed_at`,
    );
    this.tx(() => {
      for (const kind of CATALOG_KINDS) {
        for (const row of data[kind] ?? []) {
          const body = JSON.stringify(row);
          const existing = get.get(tenantId, kind, row.id) as { body: string } | undefined;
          if (existing?.body !== body) put.run(tenantId, kind, row.id, body, now);
        }
      }
      if (cloudTime) {
        this.db
          .prepare(
            `INSERT INTO catalog_state (tenant_id, cloud_time) VALUES (?, ?)
             ON CONFLICT (tenant_id) DO UPDATE SET cloud_time = excluded.cloud_time`,
          )
          .run(tenantId, cloudTime);
      }
    });
  }

  catalogCloudTime(tenantId: string): string | undefined {
    const row = this.db.prepare("SELECT cloud_time FROM catalog_state WHERE tenant_id = ?").get(tenantId) as
      | { cloud_time: string }
      | undefined;
    return row?.cloud_time;
  }

  hasCatalog(tenantId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM catalog WHERE tenant_id = ? LIMIT 1").get(tenantId);
  }

  /** The catalog as the cloud would send it; `since` is in hub time. */
  readCatalog(tenantId: string, since?: string) {
    const out: Record<string, unknown> = { serverTime: new Date().toISOString(), full: !since };
    const stmt = this.db.prepare("SELECT body FROM catalog WHERE tenant_id = ? AND kind = ? AND changed_at > ? ORDER BY id");
    for (const kind of CATALOG_KINDS) {
      const rows = stmt.all(tenantId, kind, since ?? "") as { body: string }[];
      out[kind] = rows.map((r) => JSON.parse(r.body));
    }
    return out;
  }
}

function toOrder(row: Record<string, string | number | null>): LocalOrder {
  return {
    id: String(row.id),
    number: String(row.number),
    total: Number(row.total),
    createdAt: String(row.created_at),
    refundOfOrderId: row.refund_of == null ? null : String(row.refund_of),
    body: JSON.parse(String(row.body)),
  };
}
