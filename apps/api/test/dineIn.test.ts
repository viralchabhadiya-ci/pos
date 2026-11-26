import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let tableId: string;
let qr: string;
let kioskToken: string;
let groupId: string;
let large: string;
let water: { variantId: string; price: number };

const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers: owner, payload: payload as object });
const till = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => ctx.app.inject({ method, url, headers: ctx.auth, payload: payload as object });
const guest = (method: "GET" | "POST", url: string, payload?: unknown, ip = "10.0.0.1") =>
  ctx.app.inject({ method, url: `/shop-api${url}`, payload: payload as object, remoteAddress: ip });

const order = (lines: { variantId: string; qty: number; optionIds?: string[] }[], expectedTotal: number, extra = {}) => ({
  id: randomUUID(),
  lines,
  expectedTotal,
  ...extra,
});

beforeAll(async () => {
  ctx = await setup();
  const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${login.json().token}` };
  await ctx.db.query("UPDATE products SET online = true WHERE tenant_id = $1", [ctx.data.tenantId]);
  const t = await api("POST", "/dining-tables", { storeId: ctx.data.storeId, name: "12", area: "Inside", seats: 4 });
  tableId = t.json().id;
  const v = ctx.data.variants[0]!;
  water = { variantId: v.id, price: v.price };
  const productId = (await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [v.id])).rows[0].product_id;
  const g = await api("POST", "/modifier-groups", {
    name: "Size",
    minChoices: 1,
    maxChoices: 1,
    options: [{ name: "Small", price: 0 }, { name: "Large", price: 200 }],
    productIds: [productId],
  });
  groupId = g.json().id;
  large = g.json().options[1].id;
});
afterAll(async () => teardown(ctx));

describe("table QR ordering", () => {
  it("gives tables QR codes and shows the table's menu with its choices", async () => {
    expect((await api("POST", "/restaurant/qr-codes", { storeId: ctx.data.storeId })).json().made).toBe(1);
    expect((await api("POST", "/restaurant/qr-codes", { storeId: ctx.data.storeId })).json().made).toBe(0);
    const r = (await api("GET", `/restaurant?storeId=${ctx.data.storeId}`)).json();
    qr = r.tables[0].qrToken;
    expect(qr).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect(r.tableOrdering).toBe(false);

    const menu = await guest("GET", `/table/${qr}`);
    expect(menu.statusCode).toBe(200);
    const m = menu.json();
    expect(m).toMatchObject({ kind: "table", table: { name: "12" }, open: false });
    const p = m.products.find((x: { variantId: string }) => x.variantId === water.variantId);
    expect(p.modifierGroupIds).toEqual([groupId]);
    expect(m.modifierGroups[0].options.map((o: { name: string }) => o.name)).toEqual(["Small", "Large"]);
    expect((await guest("GET", "/table/not-a-real-token-at-all")).statusCode).toBe(404);
  });

  it("takes orders only when the store has it switched on, with the choices the item needs", async () => {
    const off = await guest("POST", `/table/${qr}/orders`, order([{ variantId: water.variantId, qty: 1, optionIds: [large] }], water.price + 200));
    expect(off.statusCode).toBe(409);
    expect((await api("PUT", "/restaurant/settings", { storeId: ctx.data.storeId, tableOrdering: true })).statusCode).toBe(200);

    const missing = await guest("POST", `/table/${qr}/orders`, order([{ variantId: water.variantId, qty: 1 }], water.price));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/Choose Size/);
    const stranger = await guest("POST", `/table/${qr}/orders`, order([{ variantId: water.variantId, qty: 1, optionIds: [large, randomUUID()] }], water.price + 200));
    expect(stranger.statusCode).toBe(409);

    const quote = (await guest("POST", `/table/${qr}/quote`, { lines: [{ variantId: water.variantId, qty: 2, optionIds: [large] }] })).json();
    expect(quote.total).toBe((water.price + 200) * 2);
    expect((await guest("POST", `/table/${qr}/orders`, order([{ variantId: water.variantId, qty: 2, optionIds: [large] }], quote.total - 1))).statusCode).toBe(409);

    const body = order([{ variantId: water.variantId, qty: 2, optionIds: [large] }], quote.total, { name: "Sara", note: "No ice" });
    const placed = await guest("POST", `/table/${qr}/orders`, body);
    expect(placed.statusCode).toBe(200);
    // Pressing twice gives one order.
    expect((await guest("POST", `/table/${qr}/orders`, body)).json().token).toBe(placed.json().token);

    const status = (await guest("GET", `/dine-in/orders/${placed.json().token}`)).json();
    expect(status).toMatchObject({ channel: "table", status: "new", total: quote.total });
    expect(status.lines[0]).toEqual({ name: expect.any(String), qty: 2, modifiers: ["Large"] });
  });

  it("shows the order on the till for its table and adds it to the table's bill once", async () => {
    const list = (await till("GET", "/web-orders")).json().orders;
    const w = list.find((o: { channel: string }) => o.channel === "table");
    expect(w).toMatchObject({ tableId, tableName: "12", name: "Sara", note: "No ice", phone: null });
    expect(w.lines[0].modifiers[0]).toMatchObject({ name: "Large", price: 200 });
    expect(w.lines[0].unitPrice).toBe(water.price + 200);

    const tabId = randomUUID();
    const cart = { lines: [{ id: "l1", name: "Water", qty: 2, unitPrice: water.price + 200 }], orderDiscountBp: 0 };
    expect((await till("PUT", `/tabs/${tabId}`, { tableId, name: null, guests: 1, cart, total: 0, version: 0, userId: ctx.data.cashierId })).statusCode).toBe(200);
    expect((await till("POST", `/web-orders/${w.id}/to-tab`, { userId: ctx.data.cashierId, tabId })).json().status).toBe("collected");
    expect((await till("POST", `/web-orders/${w.id}/to-tab`, { userId: ctx.data.cashierId, tabId })).statusCode).toBe(409);
    const { rows } = await ctx.db.query("SELECT tab_id FROM web_orders WHERE id = $1", [w.id]);
    expect(rows[0].tab_id).toBe(tabId);
  });

  it("limits orders waiting at one table", async () => {
    const line = [{ variantId: water.variantId, qty: 1, optionIds: [large] }];
    for (let i = 0; i < 3; i++) expect((await guest("POST", `/table/${qr}/orders`, order(line, water.price + 200), `10.0.1.${i}`)).statusCode).toBe(200);
    const fourth = await guest("POST", `/table/${qr}/orders`, order(line, water.price + 200));
    expect(fourth.statusCode).toBe(429);
  });

  it("stops an old QR code when the table gets a new one", async () => {
    const fresh = (await api("POST", `/dining-tables/${tableId}/new-qr`, {})).json().qrToken;
    expect((await guest("GET", `/table/${qr}`)).statusCode).toBe(404);
    expect((await guest("GET", `/table/${fresh}`)).statusCode).toBe(200);
  });
});

describe("self-order kiosk", () => {
  it("takes an order to pay at the counter, numbered for calling out", async () => {
    const k = await api("POST", "/kiosks", { storeId: ctx.data.storeId, name: "Entrance" });
    expect(k.statusCode).toBe(201);
    kioskToken = k.json().token;
    const menu = (await guest("GET", `/kiosk/${kioskToken}`)).json();
    expect(menu).toMatchObject({ kind: "kiosk", table: null, open: true });

    const v = ctx.data.variants[1]!;
    const placed = (await guest("POST", `/kiosk/${kioskToken}/orders`, order([{ variantId: v.id, qty: 3 }], v.price * 3))).json();
    expect(placed.short).toBeGreaterThan(0);
    const w = (await till("GET", "/web-orders")).json().orders.find((o: { id: string }) => o.id === placed.id);
    expect(w).toMatchObject({ channel: "kiosk", kioskName: "Entrance", status: "new", total: v.price * 3 });
    expect((await api("GET", `/restaurant?storeId=${ctx.data.storeId}`)).json().kiosks[0].lastSeenAt).toBeTruthy();
  });

  it("stops a deleted kiosk or an old kiosk link", async () => {
    const id = (await api("GET", `/restaurant?storeId=${ctx.data.storeId}`)).json().kiosks[0].id;
    const fresh = (await api("POST", `/kiosks/${id}/new-link`, {})).json().token;
    expect((await guest("GET", `/kiosk/${kioskToken}`)).statusCode).toBe(404);
    expect((await api("DELETE", `/kiosks/${id}`)).statusCode).toBe(200);
    expect((await guest("GET", `/kiosk/${fresh}`)).statusCode).toBe(404);
  });
});

describe("a replacement till joining an open shift", () => {
  it("is told the shift's last sale number, so its own sales don't clash", async () => {
    const { makeOrder, openSession, postOrders } = await import("./helpers.js");
    const sessionId = await openSession(ctx, 7);
    const a = makeOrder(ctx, sessionId, [{ variant: 1, qty: 1 }]);
    const b = makeOrder(ctx, sessionId, [{ variant: 1, qty: 2 }]);
    await postOrders(ctx, [a, b]);
    const last = Math.max(...[a, b].map((o) => Number(o.number.split("-").at(-1))));
    const setupNow = (await till("GET", "/device/setup")).json();
    expect(setupNow.openSession).toMatchObject({ id: sessionId, lastOrderSeq: last });
  });
});
