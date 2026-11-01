import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../api/src/app.js";
import { createPool, type Db } from "../../api/src/db.js";
import { migrate } from "../../api/src/migrate.js";
import { createPairingCode, seed, type SeedResult } from "../../api/src/seed.js";
import { makeOrder, type Ctx } from "../../api/test/helpers.js";
import { buildHub, type Hub } from "../src/app.js";
import { HubStore } from "../src/store.js";

/**
 * Runs the real cloud API on a local port, puts the hub in front of it, and switches the
 * cloud off and on to play out a store losing its internet in the middle of a shift.
 */

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pos_test";
const HUB_DB = BASE.replace(/\/[^/]+$/, "/pos_hub_test");

let db: Db;
let data: SeedResult;
let cloud: FastifyInstance | null = null;
let cloudPort = 0;
let hub: Hub;
let printer: Server;
let printed: Buffer[] = [];
const tillA = { authorization: "" };
const tillB = { authorization: "" };

async function startCloud() {
  cloud = await buildApp(db);
  await cloud.listen({ port: cloudPort, host: "127.0.0.1" });
  cloudPort = (cloud.server.address() as AddressInfo).port;
}

async function stopCloud() {
  await cloud?.close();
  cloud = null;
}

async function pairThroughHub(name: string) {
  const code = await createPairingCode(db, data.registerId);
  const res = await hub.app.inject({
    method: "POST",
    url: "/pairing/claim",
    payload: { code, deviceId: randomUUID(), deviceName: name },
  });
  expect(res.statusCode).toBe(200);
  return `Bearer ${res.json().token}`;
}

const ctx = () => ({ data }) as unknown as Ctx;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'pos_hub_test'");
  if (!exists.rowCount) await admin.query("CREATE DATABASE pos_hub_test");
  await admin.end();

  db = createPool(HUB_DB);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  data = await seed(db);
  await startCloud();

  printer = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => printed.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => printer.listen(0, "127.0.0.1", resolve));

  hub = await buildHub(
    {
      cloudUrl: `http://127.0.0.1:${cloudPort}`,
      port: 0,
      host: "127.0.0.1",
      dataDir: ":memory:",
      printer: { host: "127.0.0.1", port: (printer.address() as AddressInfo).port, width: 32 },
      flushIntervalMs: 60_000,
      catalogIntervalMs: 60_000,
    },
    { store: new HubStore(":memory:") },
  );
  tillA.authorization = await pairThroughHub("Till A");
  tillB.authorization = await pairThroughHub("Till B");
});

afterAll(async () => {
  await hub?.close();
  await stopCloud();
  printer?.close();
  await db?.end();
});

describe("store hub", () => {
  let sessionId: string;
  let soldOffline: ReturnType<typeof makeOrder>;
  let customerId: string;

  it("tells a till it is a hub", async () => {
    const res = await hub.app.inject({ method: "GET", url: "/hub/info" });
    expect(res.json()).toMatchObject({ hub: true, cloudOnline: true, pending: 0, printer: { width: 32 } });
  });

  it("forwards straight to the cloud while online", async () => {
    sessionId = randomUUID();
    const open = await hub.app.inject({
      method: "POST",
      url: "/sessions/open",
      headers: tillA,
      payload: {
        id: sessionId,
        registerId: data.registerId,
        seq: 1,
        openedBy: data.cashierId,
        openingCash: 50_000,
        openedAt: new Date().toISOString(),
      },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ sessionId, state: "open", openingCash: 50_000 });
    expect(open.json().queued).toBeUndefined();

    const order = makeOrder(ctx(), sessionId, [{ variant: 0, qty: 2 }], { pay: "card" });
    const sale = await hub.app.inject({ method: "POST", url: "/orders/batch", headers: tillA, payload: { orders: [order] } });
    expect(sale.json().results).toEqual([expect.objectContaining({ id: order.id, status: "created" })]);
    expect(sale.json().results[0].queued).toBeUndefined();

    const catalog = await hub.app.inject({ method: "GET", url: "/sync/catalog", headers: tillA });
    expect(catalog.json().variants).toHaveLength(data.variants.length);
    await hub.refreshCatalogs();
  });

  it("keeps taking sales when the internet drops", async () => {
    await stopCloud();

    soldOffline = makeOrder(ctx(), sessionId, [{ variant: 1, qty: 1 }, { variant: 2, qty: 3 }], { pay: "cash" });
    const sale = await hub.app.inject({ method: "POST", url: "/orders/batch", headers: tillA, payload: { orders: [soldOffline] } });
    expect(sale.statusCode).toBe(200);
    expect(sale.json().results).toEqual([{ id: soldOffline.id, status: "created", queued: true }]);

    // The till retries because it never saw the answer: the hub does not queue it twice.
    const retry = await hub.app.inject({ method: "POST", url: "/orders/batch", headers: tillA, payload: { orders: [soldOffline] } });
    expect(retry.json().results).toEqual([{ id: soldOffline.id, status: "duplicate", queued: true }]);

    const bad = makeOrder(ctx(), sessionId, [{ variant: 0, qty: 1 }]);
    bad.lines[0]!.variantId = randomUUID();
    await hub.app.inject({ method: "POST", url: "/orders/batch", headers: tillA, payload: { orders: [bad] } });

    const move = await hub.app.inject({
      method: "POST",
      url: "/cash-moves",
      headers: tillA,
      payload: { id: randomUUID(), sessionId, kind: "out", amount: 1_000, reason: "Ice delivery", userId: data.cashierId, at: new Date().toISOString() },
    });
    expect(move.json()).toEqual({ ok: true, queued: true });

    customerId = randomUUID();
    const customer = await hub.app.inject({
      method: "POST",
      url: "/customers",
      headers: tillA,
      payload: { id: customerId, name: "Fatima Al Mansoori", phone: "+971501234567" },
    });
    expect(customer.json()).toEqual({ id: customerId, queued: true });

    const info = await hub.app.inject({ method: "GET", url: "/hub/info" });
    expect(info.json()).toMatchObject({ cloudOnline: false, pending: 4 });
  });

  it("lets another till find the offline sale and customer", async () => {
    const found = await hub.app.inject({ method: "GET", url: `/orders?number=${soldOffline.number}`, headers: tillB });
    expect(found.json().orders).toEqual([expect.objectContaining({ id: soldOffline.id, number: soldOffline.number })]);

    const full = await hub.app.inject({ method: "GET", url: `/orders/${soldOffline.id}`, headers: tillB });
    expect(full.json().lines).toEqual([
      expect.objectContaining({ variant_id: soldOffline.lines[0]!.variantId, qty: 1, unit_price: soldOffline.lines[0]!.unitPrice }),
      expect.objectContaining({ variant_id: soldOffline.lines[1]!.variantId, qty: 3 }),
    ]);

    const customers = await hub.app.inject({ method: "GET", url: "/customers?q=4567", headers: tillB });
    expect(customers.json().customers).toEqual([expect.objectContaining({ id: customerId })]);
  });

  it("serves the catalog and shift state from its own copy", async () => {
    const catalog = await hub.app.inject({ method: "GET", url: "/sync/catalog", headers: tillB });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().variants).toHaveLength(data.variants.length);
    expect(catalog.json().users[0]).toHaveProperty("pinHash");

    const delta = await hub.app.inject({
      method: "GET",
      url: `/sync/catalog?since=${encodeURIComponent(new Date().toISOString())}`,
      headers: tillB,
    });
    expect(delta.json()).toMatchObject({ full: false, variants: [], products: [] });

    const setup = await hub.app.inject({ method: "GET", url: "/device/setup", headers: tillB });
    expect(setup.json()).toMatchObject({ lastSessionSeq: 1, openSession: { id: sessionId } });
  });

  it("refuses tills it has never seen and work that needs the cloud", async () => {
    const stranger = await hub.app.inject({ method: "GET", url: "/sync/catalog", headers: { authorization: "Bearer nope" } });
    expect(stranger.statusCode).toBe(401);
    expect(stranger.json().error).toBe("unknown_device");

    const report = await hub.app.inject({ method: "GET", url: "/reports/daily", headers: tillA });
    expect(report.statusCode).toBe(503);
  });

  it("closes the shift offline and the register shows no open shift", async () => {
    const close = await hub.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/close`,
      headers: tillA,
      payload: { closedBy: data.cashierId, closingCashCounted: 50_000, closedAt: new Date().toISOString() },
    });
    expect(close.json()).toMatchObject({ sessionId, state: "closed", queued: true });
    const setup = await hub.app.inject({ method: "GET", url: "/device/setup", headers: tillB });
    expect(setup.json().openSession).toBeNull();
  });

  it("sends everything to the cloud exactly once when the internet is back", async () => {
    await startCloud();
    expect(await hub.flush()).toBe(5);
    expect(await hub.flush()).toBe(0);

    const { rows: orders } = await db.query("SELECT id FROM orders WHERE session_id = $1 ORDER BY created_at", [sessionId]);
    expect(orders.map((o) => o.id)).toContain(soldOffline.id);
    expect(orders).toHaveLength(2);

    const { rows: sessions } = await db.query("SELECT state, closing_cash_counted FROM sessions WHERE id = $1", [sessionId]);
    expect(sessions[0]).toMatchObject({ state: "closed", closing_cash_counted: 50_000 });
    const { rows: moves } = await db.query("SELECT amount FROM cash_moves WHERE session_id = $1", [sessionId]);
    expect(moves).toEqual([{ amount: 1_000 }]);
    const { rows: customers } = await db.query("SELECT name FROM customers WHERE id = $1", [customerId]);
    expect(customers).toEqual([{ name: "Fatima Al Mansoori" }]);

    // The order the cloud refused is kept at the hub for a manager to see.
    const info = await hub.app.inject({ method: "GET", url: "/hub/info" });
    expect(info.json()).toMatchObject({ cloudOnline: true, pending: 0, rejected: 1 });
    const rejections = await hub.app.inject({ method: "GET", url: "/hub/rejections", headers: tillA });
    expect(rejections.json().rejections).toEqual([expect.objectContaining({ kind: "orders", error: "unknown_variant" })]);

    // A late retry from the till is now a duplicate at the cloud.
    const retry = await hub.app.inject({ method: "POST", url: "/orders/batch", headers: tillA, payload: { orders: [soldOffline] } });
    expect(retry.json().results).toEqual([{ id: soldOffline.id, status: "duplicate" }]);
  });
});

describe("printer and cash drawer", () => {
  it("prints a receipt, cuts, and opens the drawer for a cash sale", async () => {
    printed = [];
    const res = await hub.app.inject({
      method: "POST",
      url: "/hub/print",
      headers: tillA,
      payload: {
        doc: {
          blocks: [
            { type: "text", text: "Demo Minimart", align: "center", bold: true },
            { type: "row", left: "Total AED", right: "27.46", bold: true },
          ],
          openDrawer: true,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => printed.length === 1);
    const bytes = printed[0]!;
    expect(bytes.toString("latin1")).toContain("Demo Minimart");
    expect(includes(bytes, [0x1d, 0x56, 0x42, 3])).toBe(true);
    expect(includes(bytes, [0x1b, 0x70, 0, 25, 250])).toBe(true);
  });

  it("opens the drawer on its own, only for a known till", async () => {
    printed = [];
    const anon = await hub.app.inject({ method: "POST", url: "/hub/drawer" });
    expect(anon.statusCode).toBe(401);
    const res = await hub.app.inject({ method: "POST", url: "/hub/drawer", headers: tillB });
    expect(res.statusCode).toBe(200);
    await waitFor(() => printed.length === 1);
    expect(includes(printed[0]!, [0x1b, 0x70, 0, 25, 250])).toBe(true);
  });
});

function includes(haystack: Buffer, needle: number[]) {
  return haystack.indexOf(Buffer.from(needle)) !== -1;
}

async function waitFor(check: () => boolean, ms = 2_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
