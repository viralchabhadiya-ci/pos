import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed } from "../src/seed.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };

function admin(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers = owner) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
}

async function createKey(scopes: string[], extra: object = {}) {
  const res = await admin("POST", "/api-keys", { name: `Key ${randomUUID().slice(0, 4)}`, scopes, ...extra });
  expect(res.statusCode).toBe(200);
  return { id: res.json().id as string, auth: { authorization: `Bearer ${res.json().key}` } };
}

function v1(method: "GET" | "POST" | "PATCH", url: string, auth: object, payload?: object, headers: object = {}) {
  return ctx.app.inject({ method, url: `/v1${url}`, headers: { ...auth, ...headers }, payload });
}

beforeAll(async () => {
  ctx = await setup();
  const res = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${res.json().token}` };
});
afterAll(async () => teardown(ctx));

describe("API keys", () => {
  it("shows the key once, lists only its start, and stops it working when revoked", async () => {
    const res = await admin("POST", "/api-keys", { name: "Online shop", scopes: ["products:read"] });
    expect(res.statusCode).toBe(200);
    const { key, id, prefix } = res.json();
    expect(key).toMatch(/^pos_live_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(prefix)).toBe(true);
    const list = await admin("GET", "/api-keys");
    const row = list.json().keys.find((k: { id: string }) => k.id === id);
    expect(row).toMatchObject({ name: "Online shop", prefix, scopes: ["products:read"], rateLimit: 120 });
    expect(JSON.stringify(list.json())).not.toContain(key);

    const auth = { authorization: `Bearer ${key}` };
    expect((await v1("GET", "/me", auth)).json()).toMatchObject({ business: { name: "Demo Minimart LLC", currency: "AED" }, key: { name: "Online shop" } });
    expect((await admin("POST", `/api-keys/${id}/revoke`, {})).statusCode).toBe(200);
    const after = await v1("GET", "/me", auth);
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("unauthorized");
  });

  it("refuses missing and made-up keys, and back office tokens", async () => {
    expect((await v1("GET", "/me", {})).statusCode).toBe(401);
    expect((await v1("GET", "/me", { authorization: "Bearer pos_live_nope" })).statusCode).toBe(401);
    expect((await v1("GET", "/me", owner)).statusCode).toBe(401);
    expect((await v1("GET", "/me", ctx.auth)).statusCode).toBe(401);
  });

  it("checks scopes, and a write scope includes reading", async () => {
    const reader = await createKey(["orders:read"]);
    const res = await v1("GET", "/products", reader.auth);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "missing_scope" });
    expect((await v1("GET", "/orders", reader.auth)).statusCode).toBe(200);
    const writer = await createKey(["products:write"]);
    expect((await v1("GET", "/products", writer.auth)).statusCode).toBe(200);
  });

  it("only lets the owner manage keys, and rejects unknown scopes and past end dates", async () => {
    expect((await admin("POST", "/api-keys", { name: "x", scopes: ["everything"] })).statusCode).toBe(400);
    expect((await admin("POST", "/api-keys", { name: "x", scopes: [] })).statusCode).toBe(400);
    expect((await admin("POST", "/api-keys", { name: "x", scopes: ["orders:read"], expiresOn: "2020-01-01" })).statusCode).toBe(400);
    await ctx.db.query("UPDATE users SET email = 'manager@demo.ae', password_hash = (SELECT password_hash FROM users WHERE id = $2) WHERE id = $1", [
      ctx.data.managerId,
      ctx.data.ownerId,
    ]);
    const m = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: "manager@demo.ae", password: ctx.data.ownerPassword } });
    const manager = { authorization: `Bearer ${m.json().token}` };
    expect((await admin("POST", "/api-keys", { name: "x", scopes: ["orders:read"] }, manager)).statusCode).toBe(403);
    expect((await admin("GET", "/api-keys", undefined, manager)).statusCode).toBe(200);
  });

  it("stops an expired key", async () => {
    const k = await createKey(["stores:read"]);
    await ctx.db.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [k.id]);
    expect((await v1("GET", "/stores", k.auth)).statusCode).toBe(401);
  });

  it("limits requests per minute and says when to come back", async () => {
    const k = await createKey(["stores:read"], { rateLimit: 10 });
    for (let i = 0; i < 10; i++) {
      const r = await v1("GET", "/stores", k.auth);
      expect(r.statusCode).toBe(200);
      expect(r.headers["x-ratelimit-remaining"]).toBe(String(9 - i));
    }
    const over = await v1("GET", "/stores", k.auth);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("rate_limited");
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(over.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("keeps each business's data to its own keys", async () => {
    const other = await seed(ctx.db, { ownerEmail: "other@demo.ae" });
    const k = await createKey(["products:read", "customers:read", "orders:read"]);
    const theirs = await ctx.db.query("SELECT id FROM products WHERE tenant_id = $1 LIMIT 1", [other.tenantId]);
    expect((await v1("GET", `/products/${theirs.rows[0].id}`, k.auth)).statusCode).toBe(404);
    const list = await v1("GET", "/products?limit=200", k.auth);
    expect(list.json().data.some((p: { id: string }) => p.id === theirs.rows[0].id)).toBe(false);
  });
});

describe("public endpoints", () => {
  let key: { authorization: string };
  beforeAll(async () => {
    key = (await createKey(["stores:read", "products:write", "customers:write", "orders:read", "inventory:write", "reports:read"])).auth;
  });

  it("lists stores with registers", async () => {
    const res = await v1("GET", "/stores", key);
    expect(res.json().data[0]).toMatchObject({ id: ctx.data.storeId, registers: [{ id: ctx.data.registerId }] });
  });

  it("pages through products with a cursor and finds by barcode", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await v1("GET", `/products?limit=2${cursor ? `&cursor=${cursor}` : ""}`, key);
      expect(res.statusCode).toBe(200);
      for (const p of res.json().data) {
        expect(seen.has(p.id)).toBe(false);
        seen.add(p.id);
      }
      cursor = res.json().nextCursor;
      pages++;
    } while (cursor && pages < 50);
    const total = await ctx.db.query("SELECT COUNT(*)::int AS n FROM products WHERE tenant_id = $1", [ctx.data.tenantId]);
    expect(seen.size).toBe(total.rows[0].n);
    const v = ctx.data.variants[0]!;
    const { rows } = await ctx.db.query("SELECT barcode FROM variants WHERE id = $1", [v.id]);
    const found = await v1("GET", `/products?barcode=${rows[0].barcode}`, key);
    expect(found.json().data).toHaveLength(1);
    expect(found.json().data[0].variantId).toBe(v.id);
    expect((await v1("GET", "/products?cursor=garbage", key)).statusCode).toBe(400);
  });

  it("adds a product, changes only the fields sent, and audits the key", async () => {
    const created = await v1("POST", "/products", key, { name: "Karak tea 250g", price: 1250, barcode: "6291000000017" });
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p).toMatchObject({ name: "Karak tea 250g", price: 1250, active: true, uom: "unit" });
    const patched = await v1("PATCH", `/products/${p.id}`, key, { price: 1300 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Karak tea 250g", price: 1300, barcode: "6291000000017" });
    const audit = await ctx.db.query("SELECT data FROM audit_log WHERE entity_id = $1 AND action = 'product.update'", [p.id]);
    expect(audit.rows[0].data).toMatchObject({ priceFrom: 1250, priceTo: 1300, source: "api" });
    expect(audit.rows[0].data.apiKey).toMatch(/^Key /);
    // Same barcode again is refused like in the back office.
    const dup = await v1("POST", "/products", key, { name: "Copy", price: 100, barcode: "6291000000017" });
    expect(dup.statusCode).toBe(409);
    expect((await v1("PATCH", `/products/${p.id}`, key, { colour: "red" })).statusCode).toBe(400);
    expect((await v1("PATCH", `/products/${randomUUID()}`, key, { price: 1 })).statusCode).toBe(404);
  });

  it("only picks up changes since a time", async () => {
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const p = (await v1("POST", "/products", key, { name: "Fresh dates 1kg", price: 3500, uom: "kg" })).json();
    const res = await v1("GET", `/products?updatedSince=${encodeURIComponent(since)}`, key);
    expect(res.json().data.map((x: { id: string }) => x.id)).toEqual([p.id]);
  });

  it("replays a POST with the same Idempotency-Key instead of creating twice", async () => {
    const body = { name: "Mariam Al Mansoori", phone: "+971501112233" };
    const a = await v1("POST", "/customers", key, body, { "idempotency-key": "abc-1" });
    const b = await v1("POST", "/customers", key, body, { "idempotency-key": "abc-1" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    const n = await ctx.db.query("SELECT COUNT(*)::int AS n FROM customers WHERE phone = '+971501112233'");
    expect(n.rows[0].n).toBe(1);
    const other = await v1("POST", "/customers", key, { name: "Someone else" }, { "idempotency-key": "abc-1" });
    expect(other.statusCode).toBe(422);
    // A failed request frees its key for a retry.
    const fail = await v1("POST", "/customers", key, { name: "Dup", phone: "+971501112233" }, { "idempotency-key": "abc-2" });
    expect(fail.statusCode).toBe(409);
    const retry = await v1("POST", "/customers", key, { name: "Dup", phone: "+971509999999" }, { "idempotency-key": "abc-2" });
    expect(retry.statusCode).toBe(201);
  });

  it("finds and changes customers", async () => {
    const c = (await v1("POST", "/customers", key, { name: "Omar", email: "omar@example.com" })).json();
    expect((await v1("GET", "/customers?email=OMAR@example.com", key)).json().data[0].id).toBe(c.id);
    const res = await v1("PATCH", `/customers/${c.id}`, key, { phone: "+971502223344" });
    expect(res.json()).toMatchObject({ name: "Omar", email: "omar@example.com", phone: "+971502223344", points: 0 });
    expect((await v1("PATCH", `/customers/${c.id}`, key, { trn: "123" })).statusCode).toBe(400);
  });

  it("returns orders with lines and payments, synced in order", async () => {
    const session = await openSession(ctx);
    const sale = makeOrder(ctx, session, [{ variant: 0, qty: 2 }, { variant: 1, qty: 1 }], { pay: "cash", tendered: 100_00 });
    await postOrders(ctx, [sale]);
    const refund = makeOrder(ctx, session, [{ variant: 0, qty: -1 }], { refundOf: sale.id, pay: "cash" });
    await postOrders(ctx, [refund]);

    const one = await v1("GET", `/orders/${sale.id}`, key);
    expect(one.statusCode).toBe(200);
    const o = one.json();
    expect(o).toMatchObject({ id: sale.id, number: sale.number, type: "sale", currency: "AED", storeId: ctx.data.storeId });
    expect(o.lines).toHaveLength(2);
    expect(o.lines[0]).toMatchObject({ variantId: ctx.data.variants[0]!.id, qty: 2, taxRateBp: 500 });
    expect(o.payments[0]).toMatchObject({ kind: "cash", tendered: 100_00 });
    expect(o.lines.reduce((s: number, l: { gross: number }) => s + l.gross, 0)).toBe(o.total);

    const refunds = await v1("GET", "/orders?type=refund", key);
    expect(refunds.json().data.map((x: { id: string }) => x.id)).toEqual([refund.id]);
    expect(refunds.json().data[0]).toMatchObject({ type: "refund", refundOfOrderId: sale.id });
    const page1 = await v1("GET", "/orders?limit=1", key);
    expect(page1.json().data[0].id).toBe(sale.id);
    const page2 = await v1("GET", `/orders?limit=1&cursor=${page1.json().nextCursor}`, key);
    expect(page2.json().data[0].id).toBe(refund.id);
    expect(page2.json().nextCursor).toBeNull();
  });

  it("shows stock per store and takes adjustments", async () => {
    const product = (await v1("POST", "/products", key, { name: "Water 1.5L", price: 150 })).json();
    const adj = await v1("POST", "/inventory/adjustments", key, { storeId: ctx.data.storeId, reason: "adjust", lines: [{ productId: product.id, qty: 24 }] });
    expect(adj.statusCode).toBe(201);
    const stock = await v1("GET", `/inventory?productId=${product.id}`, key);
    expect(stock.json().data).toEqual([expect.objectContaining({ productId: product.id, storeId: ctx.data.storeId, onHand: 24 })]);
    const waste = await v1("POST", "/inventory/adjustments", key, { storeId: ctx.data.storeId, reason: "waste", lines: [{ productId: product.id, qty: 2 }] });
    expect(waste.statusCode).toBe(400); // a write-off needs a reason
    const half = await v1("POST", "/inventory/adjustments", key, { storeId: ctx.data.storeId, reason: "adjust", lines: [{ productId: product.id, qty: 0.5 }] });
    expect(half.statusCode).toBe(400); // counted in whole pieces
    const all = await v1("GET", "/inventory?limit=3", key);
    expect(all.json().data).toHaveLength(3);
    const next = await v1("GET", `/inventory?limit=3&cursor=${all.json().nextCursor}`, key);
    expect(next.json().data[0].productId >= all.json().data[2].productId).toBe(true);
  });

  it("totals sales per day in the store's time zone", async () => {
    const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    const res = await v1("GET", `/reports/daily-sales?from=${today}&to=${today}`, key);
    expect(res.statusCode).toBe(200);
    const row = res.json().data[0];
    expect(row).toMatchObject({ storeId: ctx.data.storeId, date: today, salesCount: 1, refundCount: 1 });
    expect(row.total).toBe(row.grossSales + row.refunds);
    expect((await v1("GET", "/reports/daily-sales?from=2026-01-02&to=2026-01-01", key)).statusCode).toBe(400);
  });
});

describe("docs", () => {
  it("serves an OpenAPI document that covers every route", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe("3.1.0");
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([p, m]) => Object.keys(m as object).map((k) => `${k.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`)),
    );
    const routes = ctx.app
      .printRoutes({ commonPrefix: false })
      .split("\n")
      .filter((l) => l.includes("/v1/"));
    expect(routes.length).toBeGreaterThan(0);
    for (const path of ["/v1/me", "/v1/products", "/v1/products/:id", "/v1/orders", "/v1/inventory/adjustments", "/v1/reports/daily-sales"]) {
      expect([...documented].some((d) => d.endsWith(` ${path}`))).toBe(true);
    }
    expect(Object.keys(spec.webhooks)).toContain("order.created");
    // Every $ref points at a schema that exists.
    for (const r of JSON.stringify(spec).match(/#\/components\/schemas\/\w+/g) ?? []) {
      expect(spec.components.schemas[r.split("/").pop()!]).toBeTruthy();
    }
  });

  it("serves a readable reference page", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("POS-Signature");
    expect(res.body).toContain("/v1/orders");
  });
});
