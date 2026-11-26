import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailyRecipients } from "../src/reports/deliver.js";
import { createPairingCode } from "../src/seed.js";
import { isHqOnly } from "../src/stores.js";
import { share } from "../src/routes/admin/hq.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

type Method = "GET" | "POST" | "PUT";
let ctx: Ctx;
let owner: { authorization: string };
let auh: string; // second store, a franchise
let shj: string; // third store
let auhTill: Ctx; // a till paired to the Abu Dhabi store
let manager: { authorization: string }; // store manager for Abu Dhabi only
let managerId: string;

function api(method: Method, url: string, payload?: object, headers = owner) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
}
async function ok<T = any>(method: Method, url: string, payload?: object, headers = owner): Promise<T> {
  const res = await api(method, url, payload, headers);
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json();
}
async function login(email: string, password: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return { authorization: `Bearer ${res.json().token}` };
}
const storeBody = (name: string, extra: object = {}) => ({ name, timezone: "Asia/Dubai", cashRoundingStep: 25, ...extra });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

beforeAll(async () => {
  ctx = await setup();
  owner = await login(ctx.data.ownerEmail, ctx.data.ownerPassword);
});
afterAll(async () => teardown(ctx));

describe("stores", () => {
  it("adds franchise and owned stores, and keeps fees only on franchises", async () => {
    auh = (
      await ok("POST", "/stores", { code: "AUH1", ...storeBody("Abu Dhabi Mall", { ownership: "franchise", franchisee: "Gulf Retail LLC", royaltyBp: 600, marketingFeeBp: 200 }) })
    ).id;
    shj = (await ok("POST", "/stores", { code: "SHJ1", ...storeBody("Sharjah", { royaltyBp: 900 }) })).id;
    const { stores } = await ok("GET", "/stores");
    expect(stores.find((s: any) => s.id === auh)).toMatchObject({ ownership: "franchise", franchisee: "Gulf Retail LLC", royaltyBp: 600, marketingFeeBp: 200 });
    // An owned store pays no royalty, whatever was sent.
    expect(stores.find((s: any) => s.id === shj)).toMatchObject({ ownership: "owned", royaltyBp: 0, franchisee: null });
    expect((await api("POST", "/stores", { code: "BAD", ...storeBody("x", { royaltyBp: 20000 }) })).statusCode).toBe(400);
  });

  it("pairs a till at the second store", async () => {
    const { rows } = await ctx.db.query("SELECT id FROM registers WHERE store_id = $1", [auh]);
    const registerId = rows[0].id;
    const code = await createPairingCode(ctx.db, registerId);
    const res = await ctx.app.inject({ method: "POST", url: "/pairing/claim", payload: { code, deviceId: randomUUID(), deviceName: "AUH till" } });
    const token = res.json().token as string;
    auhTill = { ...ctx, data: { ...ctx.data, registerId }, token, auth: { authorization: `Bearer ${token}` } };
  });
});

describe("store-scoped staff", () => {
  it("creates a store manager who only sees their store", async () => {
    managerId = (
      await ok("POST", "/staff", { name: "Omar (AUH manager)", role: "manager", pin: "4455", email: "omar@demo.ae", password: "omarpass1", storeIds: [auh] })
    ).id;
    manager = await login("omar@demo.ae", "omarpass1");
    const me = await ok("GET", "/me", undefined, manager);
    expect(me.user.storeIds).toEqual([auh]);
    expect(me.stores.map((s: any) => s.id)).toEqual([auh]);
    const { stores } = await ok("GET", "/stores", undefined, manager);
    expect(stores.map((s: any) => s.id)).toEqual([auh]);
    // Head office (the owner) still sees every store.
    expect((await ok("GET", "/me")).user.storeIds).toBeNull();
    expect((await ok("GET", "/me")).stores).toHaveLength(3);
  });

  it("rejects a store that does not exist", async () => {
    const res = await api("POST", "/staff", { name: "X", role: "cashier", pin: "1212", storeIds: [randomUUID()] });
    expect(res.statusCode).toBe(400);
  });

  it("lets a store manager add cashiers only to their own stores", async () => {
    const nowhere = await api("POST", "/staff", { name: "Everywhere", role: "cashier", pin: "5151" }, manager);
    expect(nowhere.statusCode).toBe(403);
    const other = await api("POST", "/staff", { name: "DXB", role: "cashier", pin: "5151", storeIds: [ctx.data.storeId] }, manager);
    expect(other.statusCode).toBe(403);
    const mine = await ok("POST", "/staff", { name: "Sara (AUH)", role: "cashier", pin: "5151", storeIds: [auh] }, manager);
    const { staff } = await ok("GET", "/staff", undefined, manager);
    expect(staff.map((s: any) => s.id).sort()).toEqual([managerId, mine.id].sort());
    // People who work at every store, like the seeded cashier, are head office's to change.
    const res = await api("PUT", `/staff/${ctx.data.cashierId}`, { name: "Aisha", role: "cashier", active: true }, manager);
    expect(res.statusCode).toBe(403);
    // Managers are the owner's to change, so a store manager cannot widen their own access.
    expect((await api("PUT", `/staff/${managerId}`, { name: "Omar", role: "manager", active: true, storeIds: [] }, manager)).statusCode).toBe(403);
    expect((await ok("GET", "/me", undefined, manager)).user.storeIds).toEqual([auh]);
  });

  it("keeps a person's stores when an update leaves them out", async () => {
    await ok("PUT", `/staff/${managerId}`, { name: "Omar", role: "manager", active: true });
    const { staff } = await ok("GET", "/staff");
    expect(staff.find((s: any) => s.id === managerId).storeIds).toEqual([auh]);
  });

  it("only lets staff of this store sign in on its tills", async () => {
    const sara = (await ok("GET", "/staff")).staff.find((s: any) => s.name === "Sara (AUH)");
    const dxb = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth })).json();
    const auhSync = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: auhTill.auth })).json();
    const active = (body: any, id: string) => body.users.find((u: any) => u.id === id)?.active;
    expect(active(dxb, sara.id)).toBe(false);
    expect(active(auhSync, sara.id)).toBe(true);
    // Unassigned staff and owners work everywhere.
    expect(active(dxb, ctx.data.cashierId)).toBe(true);
    expect(active(auhSync, ctx.data.cashierId)).toBe(true);
    expect(active(auhSync, ctx.data.ownerId)).toBe(true);

    // Moving the cashier to Dubai reaches both tills on their next incremental sync.
    await ok("PUT", `/staff/${sara.id}`, { name: "Sara", role: "cashier", active: true, storeIds: [ctx.data.storeId] });
    const delta = (await ctx.app.inject({ method: "GET", url: `/sync/catalog?since=${encodeURIComponent(dxb.serverTime)}`, headers: ctx.auth })).json();
    expect(active(delta, sara.id)).toBe(true);
    const delta2 = (await ctx.app.inject({ method: "GET", url: `/sync/catalog?since=${encodeURIComponent(auhSync.serverTime)}`, headers: auhTill.auth })).json();
    expect(active(delta2, sara.id)).toBe(false);
    await ok("PUT", `/staff/${sara.id}`, { name: "Sara (AUH)", role: "cashier", active: true, storeIds: [auh] });
  });

  it("leaves store managers out of the whole-business daily email", async () => {
    await ctx.db.query("INSERT INTO report_subscriptions (user_id, tenant_id, daily) VALUES ($1, $2, true)", [managerId, ctx.data.tenantId]);
    expect(await dailyRecipients(ctx.db, ctx.data.tenantId)).not.toContain("omar@demo.ae");
  });
});

describe("sales seen by a store manager", () => {
  let dxbOrder: string;
  let auhOrder: string;

  beforeAll(async () => {
    const s1 = await openSession(ctx);
    const s2 = await openSession(auhTill);
    const a = makeOrder(ctx, s1, [{ variant: 0, qty: 2 }]); // 3.00 in Dubai
    const b = makeOrder(auhTill, s2, [{ variant: 4, qty: 10 }]); // 65.00 in Abu Dhabi
    b.number = "AUH1-R1-0001-0001";
    const c = makeOrder(auhTill, s2, [{ variant: 4, qty: 1 }], { refundOf: b.id });
    c.number = "AUH1-R1-0001-0002";
    c.lines = c.lines.map((l) => ({ ...l, qty: -1 }));
    c.payments[0]!.amount = -650;
    c.clientTotals = { subtotalNet: -619, taxTotal: -31, total: -650 };
    await postOrders(ctx, [a]);
    await postOrders(auhTill, [b, c]);
    dxbOrder = a.id;
    auhOrder = b.id;
  });

  it("lists and opens only their store's bills", async () => {
    const mine = await ok("GET", "/orders", undefined, manager);
    expect(mine.orders.map((o: any) => o.id)).toContain(auhOrder);
    expect(mine.orders.map((o: any) => o.id)).not.toContain(dxbOrder);
    expect((await api("GET", `/orders/${dxbOrder}`, undefined, manager)).statusCode).toBe(404);
    expect((await api("GET", `/orders/${auhOrder}`, undefined, manager)).statusCode).toBe(200);
    expect((await api("GET", `/orders?storeId=${ctx.data.storeId}`, undefined, manager)).statusCode).toBe(403);
    // Head office sees both.
    const all = await ok("GET", "/orders");
    expect(all.orders.map((o: any) => o.id)).toEqual(expect.arrayContaining([dxbOrder, auhOrder]));
  });

  it("scopes the dashboard and reports", async () => {
    const dash = await ok("GET", "/dashboard", undefined, manager);
    expect(dash.total).toBe(6500 - 650);
    const rep = await ok("GET", `/reports/sales?from=${today()}&to=${today()}&groupBy=day`, undefined, manager);
    expect(rep.rows[0].total).toBe(6500 - 650);
    const hq = await ok("GET", `/reports/sales?from=${today()}&to=${today()}&groupBy=day`);
    expect(hq.rows[0].total).toBe(6500 - 650 + 300);
    expect((await api("GET", `/reports/sales?from=${today()}&to=${today()}&storeId=${ctx.data.storeId}`, undefined, manager)).statusCode).toBe(403);
  });

  it("shows only their registers and tills", async () => {
    const { registers } = await ok("GET", "/registers", undefined, manager);
    expect(registers.every((r: any) => r.storeId === auh)).toBe(true);
    const dxbRegister = ctx.data.registerId;
    expect((await api("POST", `/registers/${dxbRegister}/pairing-code`, {}, manager)).statusCode).toBe(404);
    expect((await api("POST", "/registers", { storeId: ctx.data.storeId, code: "R9", name: "x" }, manager)).statusCode).toBe(403);
  });

  it("keeps the catalog, offers, accounting and settings with head office", async () => {
    const product = ctx.data.variants[0]!;
    expect((await api("GET", "/products", undefined, manager)).statusCode).toBe(200);
    const blocked: [Method, string, object?][] = [
      ["POST", "/products", { name: "X", price: 100 }],
      ["PUT", `/stores/${auh}`, storeBody("x")],
      ["POST", "/categories", { name: "X" }],
      ["POST", "/promotions", {}],
      ["POST", "/price-lists", { name: "X" }],
      ["GET", `/accounting/journals?from=${today()}&to=${today()}`],
      ["GET", "/audit"],
      ["GET", `/reports/royalties?from=${today()}&to=${today()}`],
      ["PUT", `/products/${randomUUID()}/stores`, { stores: [] }],
      ["GET", "/einvoicing/settings"],
      ["GET", "/report-schedules"],
      ["GET", "/api-keys"],
      ["GET", `/reports/sales?from=${today()}&to=${today()}&groupBy=staff&storeId=${ctx.data.storeId}`],
    ];
    for (const [m, url, body] of blocked) {
      const res = await api(m, url, body, manager);
      expect(res.statusCode, `${m} ${url}`).toBe(403);
    }
    expect(product).toBeTruthy();
  });

  it("only adjusts stock in their stores", async () => {
    const { rows } = await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [ctx.data.variants[0]!.id]);
    const pid = rows[0].product_id;
    expect((await api("POST", `/products/${pid}/stock`, { storeId: ctx.data.storeId, qty: 5, reason: "adjust" }, manager)).statusCode).toBe(403);
    expect((await api("POST", `/products/${pid}/stock`, { storeId: auh, qty: 5, reason: "receive" }, manager)).statusCode).toBe(200);
    const stock = await ok("GET", "/inventory/stock", undefined, manager);
    expect(stock.items.find((i: any) => i.variantId === ctx.data.variants[0]!.id).onHand).toBe(5);
  });
});

describe("per-store catalog", () => {
  let productId: string;
  let variantId: string;
  beforeAll(async () => {
    variantId = ctx.data.variants[2]!.id; // Coca-Cola, 2.50
    productId = (await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [variantId])).rows[0].product_id;
  });

  it("shows how a product sells in each store", async () => {
    const res = await ok("GET", `/products/${productId}/stores`);
    expect(res.basePrice).toBe(250);
    expect(res.stores).toHaveLength(3);
    expect(res.stores.every((s: any) => s.sold && s.price === 250)).toBe(true);
    // A store manager sees their own store only.
    expect((await ok("GET", `/products/${productId}/stores`, undefined, manager)).stores.map((s: any) => s.storeId)).toEqual([auh]);
  });

  it("hides a product at one store and its tills get it switched off", async () => {
    const before = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: auhTill.auth })).json();
    await ok("PUT", `/products/${productId}/stores`, { stores: [{ storeId: auh, sold: false, price: null }] });
    const delta = (await ctx.app.inject({ method: "GET", url: `/sync/catalog?since=${encodeURIComponent(before.serverTime)}`, headers: auhTill.auth })).json();
    expect(delta.products).toEqual([expect.objectContaining({ id: productId, active: false })]);
    const dxb = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth })).json();
    expect(dxb.products.find((p: any) => p.id === productId).active).toBe(true);
    await ok("PUT", `/products/${productId}/stores`, { stores: [{ storeId: auh, sold: true, price: null }] });
    const back = (await ctx.app.inject({ method: "GET", url: `/sync/catalog?since=${encodeURIComponent(delta.serverTime)}`, headers: auhTill.auth })).json();
    expect(back.products).toEqual([expect.objectContaining({ id: productId, active: true })]);
  });

  it("sets a store price on the store's own price list", async () => {
    await ok("PUT", `/products/${productId}/stores`, { stores: [{ storeId: shj, sold: true, price: 275 }] });
    const res = await ok("GET", `/products/${productId}/stores`);
    const s = res.stores.find((x: any) => x.storeId === shj);
    expect(s).toMatchObject({ price: 275, storePrice: 275, priceListName: "Sharjah prices" });
    const { rows } = await ctx.db.query("SELECT price_list_id FROM stores WHERE id = $1", [shj]);
    expect(rows[0].price_list_id).toBe(s.priceListId);
    // Back to the product's own price.
    await ok("PUT", `/products/${productId}/stores`, { stores: [{ storeId: shj, sold: true, price: 250 }] });
    expect((await ok("GET", `/products/${productId}/stores`)).stores.find((x: any) => x.storeId === shj)).toMatchObject({ price: 250, storePrice: null });
  });

  it("refuses to change a price list other stores share", async () => {
    const list = (await ctx.db.query("SELECT price_list_id FROM stores WHERE id = $1", [shj])).rows[0].price_list_id;
    await ctx.db.query("UPDATE stores SET price_list_id = $2 WHERE id = $1", [ctx.data.storeId, list]);
    const res = await api("PUT", `/products/${productId}/stores`, { stores: [{ storeId: shj, sold: true, price: 300 }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("price_list_shared");
    await ctx.db.query("UPDATE stores SET price_list_id = NULL WHERE id = $1", [ctx.data.storeId]);
  });
});

describe("transfers between stores", () => {
  it("lets a store ask for stock, the sender send it and the receiver receive it", async () => {
    const variantId = ctx.data.variants[1]!.id;
    const { rows } = await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [variantId]);
    await ok("POST", `/products/${rows[0].product_id}/stock`, { storeId: ctx.data.storeId, qty: 20, reason: "receive" });

    // Omar (Abu Dhabi) asks Dubai for 6.
    const t = await ok("POST", "/transfers", { fromStoreId: ctx.data.storeId, toStoreId: auh, lines: [{ variantId, qty: 6 }] }, manager);
    expect((await api("POST", `/transfers/${t.id}/send`, {}, manager)).statusCode).toBe(403);
    await ok("POST", `/transfers/${t.id}/send`, {});
    expect((await api("POST", `/transfers/${t.id}/cancel`, {}, manager)).statusCode).toBe(403);
    const got = await ok("POST", `/transfers/${t.id}/receive`, {}, manager);
    expect(got.status).toBe("received");

    // A transfer between two other stores is invisible to him and cannot be made by him.
    const other = await ok("POST", "/transfers", { fromStoreId: ctx.data.storeId, toStoreId: shj, lines: [{ variantId, qty: 1 }] });
    expect((await api("GET", `/transfers/${other.id}`, undefined, manager)).statusCode).toBe(404);
    expect((await ok("GET", "/transfers", undefined, manager)).transfers.map((x: any) => x.id)).toEqual([t.id]);
    expect(
      (await api("POST", "/transfers", { fromStoreId: ctx.data.storeId, toStoreId: shj, lines: [{ variantId, qty: 1 }] }, manager)).statusCode,
    ).toBe(403);
  });
});

describe("head office overview", () => {
  it("puts every store side by side with totals", async () => {
    const res = await ok("GET", `/hq/overview?from=${today()}&to=${today()}`);
    expect(res.stores).toHaveLength(3);
    const dxb = res.stores.find((s: any) => s.id === ctx.data.storeId);
    const ad = res.stores.find((s: any) => s.id === auh);
    expect(dxb).toMatchObject({ bills: 1, total: 300, registers: 1, tills: 1 });
    expect(ad).toMatchObject({ bills: 1, refunds: 1, refundTotal: 650, total: 5850, ownership: "franchise", averageBill: 6500 });
    expect(ad.stockValue).toBeGreaterThanOrEqual(0);
    expect(res.totals.total).toBe(6150);
    expect(res.totals.bills).toBe(2);
    expect(res.trend.length).toBeGreaterThan(0);
    // A store manager sees just their own.
    const mine = await ok("GET", `/hq/overview?from=${today()}&to=${today()}`, undefined, manager);
    expect(mine.stores.map((s: any) => s.id)).toEqual([auh]);
    const csv = await api("GET", `/hq/overview?from=${today()}&to=${today()}&format=csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("Abu Dhabi Mall");
  });

  it("compares with the period before", async () => {
    await ctx.db.query("UPDATE orders SET created_at = created_at - interval '1 day' WHERE store_id = $1", [ctx.data.storeId]);
    const res = await ok("GET", `/hq/overview?from=${today()}&to=${today()}`);
    const dxb = res.stores.find((s: any) => s.id === ctx.data.storeId);
    expect(dxb).toMatchObject({ total: 0, previousTotal: 300, change: -100 });
    await ctx.db.query("UPDATE orders SET created_at = created_at + interval '1 day' WHERE store_id = $1", [ctx.data.storeId]);
  });
});

describe("franchise royalties", () => {
  it("charges royalty and marketing fee on net sales before VAT", async () => {
    const res = await ok("GET", `/reports/royalties?from=${today()}&to=${today()}`);
    expect(res.stores).toHaveLength(1);
    const r = res.stores[0];
    // 10 milk at 6.50 = 61.90 net, then one refunded (-6.19): base 55.71.
    expect(r).toMatchObject({ id: auh, sales: 6190, refunds: 619, net: 5571, royaltyBp: 600, marketingFeeBp: 200 });
    expect(r.royalty).toBe(334); // 6% of 55.71 = 3.3426
    expect(r.marketingFee).toBe(111); // 2% of 55.71 = 1.1142
    expect(r.due).toBe(445);
    expect(res.totals.due).toBe(445);
    const csv = await api("GET", `/reports/royalties?from=${today()}&to=${today()}&format=csv`);
    expect(csv.body).toContain("Gulf Retail LLC");
    expect(csv.body).toContain("55.71");
  });

  it("rounds a share half away from zero", () => {
    expect(share(5571, 600)).toBe(334);
    expect(share(-5571, 600)).toBe(-334);
    expect(share(25, 200)).toBe(1); // 0.5 rounds up
  });
});

describe("head office routes", () => {
  it("knows which back office routes belong to head office", () => {
    expect(isHqOnly("GET", "/admin/accounting/journals?from=x")).toBe(true);
    expect(isHqOnly("GET", "/admin/products")).toBe(false);
    expect(isHqOnly("PUT", "/admin/products/abc")).toBe(true);
    expect(isHqOnly("POST", "/admin/products/abc/stock")).toBe(false);
    expect(isHqOnly("PUT", "/admin/report-settings/me")).toBe(false);
    expect(isHqOnly("PUT", "/admin/report-settings")).toBe(true);
    expect(isHqOnly("POST", "/admin/transfers")).toBe(false);
    expect(isHqOnly("GET", "/admin/report-schedules")).toBe(true);
    expect(isHqOnly("POST", "/admin/api-keys")).toBe(true);
    expect(isHqOnly("GET", "/admin/webhooks")).toBe(true);
  });
});
