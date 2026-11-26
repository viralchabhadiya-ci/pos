import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySender } from "../src/crm/senders.js";
import { hashPassword } from "../src/security.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
const senders = { email: new MemorySender(), sms: new MemorySender(), whatsapp: new MemorySender() };
const SLUG = "demo-minimart";

const api = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers = owner) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers, payload: payload as object });
const shop = (method: "GET" | "POST", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/shop-api/${SLUG}${url}`, payload: payload as object });
const settle = () => new Promise((r) => setTimeout(r, 30));
const settings = (over: Record<string, unknown> = {}) => ({
  slug: SLUG,
  enabled: true,
  pickupStoreIds: [ctx.data.storeId],
  notice: "Collect from the counter.",
  minOrder: 0,
  readyMinutes: 20,
  checkStock: true,
  ...over,
});

async function productIdOf(variant: number) {
  return (await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [ctx.data.variants[variant]!.id])).rows[0].product_id as string;
}
async function stock(variant: number, qty: number) {
  await ctx.db.query("INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason) VALUES ($1, $2, $3, $4, 'receive')", [
    ctx.data.tenantId,
    ctx.data.storeId,
    ctx.data.variants[variant]!.id,
    qty,
  ]);
}
async function place(lines: { variant: number; qty: number }[], over: Record<string, unknown> = {}) {
  const page = (await shop("GET", "")).json();
  const price = (v: number) => page.products.find((p: { variantId: string }) => p.variantId === ctx.data.variants[v]!.id)?.price ?? 0;
  return shop("POST", "/orders", {
    id: randomUUID(),
    storeId: ctx.data.storeId,
    name: "Sara Ahmed",
    phone: "050 999 1234",
    lines: lines.map((l) => ({ variantId: ctx.data.variants[l.variant]!.id, qty: l.qty })),
    expectedTotal: lines.reduce((s, l) => s + price(l.variant) * l.qty, 0),
    ...over,
  });
}

beforeAll(async () => {
  ctx = await setup({ senders });
  const login = (email: string, password: string) => ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  await ctx.db.query("UPDATE users SET email = 'shop-manager@demo.ae', password_hash = $2 WHERE id = $1", [ctx.data.managerId, hashPassword("manager123")]);
  manager = { authorization: `Bearer ${(await login("shop-manager@demo.ae", "manager123")).json().token}` };
});
afterAll(async () => teardown(ctx));

describe("online store settings", () => {
  it("suggests an address, and only the owner can open the shop", async () => {
    const first = (await api("GET", "/online-store")).json();
    expect(first.settings).toMatchObject({ slug: "demo-minimart", enabled: false, isNew: true, pickupStoreIds: [ctx.data.storeId] });
    expect((await shop("GET", "")).statusCode).toBe(404);
    expect((await api("PUT", "/online-store", settings(), manager)).statusCode).toBe(403);
    expect((await api("PUT", "/online-store", settings({ slug: "Not OK!" }))).statusCode).toBe(400);
    expect((await api("PUT", "/online-store", settings({ pickupStoreIds: [] }))).json().message).toMatch(/at least one store/);
    expect((await api("PUT", "/online-store", settings({ pickupStoreIds: [randomUUID()] }))).statusCode).toBe(400);
    expect((await api("PUT", "/online-store", settings())).statusCode).toBe(200);
    expect((await api("GET", "/online-store")).json().settings).toMatchObject({ slug: SLUG, enabled: true, readyMinutes: 20 });
  });

  it("shows only products put online, at the pickup store's prices, with VAT", async () => {
    expect((await shop("GET", "")).json().products).toEqual([]);
    const ids = await Promise.all([0, 1, 2, 11].map(productIdOf));
    expect((await api("POST", "/online-store/products", { productIds: ids, online: true })).json().changed).toBe(4);
    await api("PUT", `/online-store/products/${ids[0]}`, { online: true, description: "Local spring water" });
    // The store leaves one product out of its range, and has its own price for another.
    await ctx.db.query("INSERT INTO store_hidden_products (store_id, product_id, tenant_id) VALUES ($1, $2, $3)", [ctx.data.storeId, ids[2], ctx.data.tenantId]);
    const list = randomUUID();
    await ctx.db.query("INSERT INTO price_lists (id, tenant_id, name, active) VALUES ($1, $2, 'DXB prices', true)", [list, ctx.data.tenantId]);
    await ctx.db.query("INSERT INTO price_list_items (price_list_id, variant_id, tenant_id, price, active) VALUES ($1, $2, $3, 120, true)", [
      list,
      ctx.data.variants[1]!.id,
      ctx.data.tenantId,
    ]);
    await ctx.db.query("UPDATE stores SET price_list_id = $2 WHERE id = $1", [ctx.data.storeId, list]);

    const page = (await shop("GET", "")).json();
    expect(page.shop).toMatchObject({ name: expect.any(String), notice: "Collect from the counter.", readyMinutes: 20 });
    expect(page.stores.map((s: { id: string }) => s.id)).toEqual([ctx.data.storeId]);
    const byName = Object.fromEntries(page.products.map((p: { name: string }) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual([ctx.data.variants[0]!.name, ctx.data.variants[1]!.name, ctx.data.variants[11]!.name].sort());
    expect(byName[ctx.data.variants[0]!.name]).toMatchObject({ price: ctx.data.variants[0]!.price, description: "Local spring water", inStock: false });
    expect(byName[ctx.data.variants[1]!.name].price).toBe(120);
    expect(page.categories.length).toBeGreaterThan(0);
    // Nothing secret leaks to the public page.
    expect(JSON.stringify(page)).not.toMatch(/cost|available/);
  });
});

describe("click-and-collect orders", () => {
  let token: string;
  let orderId: string;

  it("refuses what is out of stock and prices that changed", async () => {
    expect((await place([{ variant: 0, qty: 2 }])).json().error).toBe("out_of_stock");
    await stock(0, 5);
    await stock(1, 10);
    expect((await place([{ variant: 0, qty: 6 }])).json().message).toBe(`Only 5 of ${ctx.data.variants[0]!.name} left`);
    expect((await place([{ variant: 0, qty: 2 }], { expectedTotal: 1 })).json().error).toBe("price_changed");
    expect((await place([{ variant: 0, qty: 1.5 }])).json().message).toMatch(/by the piece/);
    expect((await place([{ variant: 0, qty: 1 }], { phone: "04 123 4567" })).json().error).toBe("bad_phone");
    expect((await place([{ variant: 2, qty: 1 }])).json().error).toBe("unavailable");
  });

  it("prices a basket the way the order will be priced", async () => {
    const q = (await shop("POST", "/quote", { storeId: ctx.data.storeId, lines: [{ variantId: ctx.data.variants[1]!.id, qty: 2 }, { variantId: ctx.data.variants[1]!.id, qty: 1 }] })).json();
    expect(q).toMatchObject({ total: 360, lines: [{ qty: 3, price: 120, total: 360 }] });
    expect(q.taxTotal).toBeGreaterThan(0);
    expect((await shop("POST", "/quote", { storeId: randomUUID(), lines: [{ variantId: ctx.data.variants[1]!.id, qty: 1 }] })).statusCode).toBe(400);
  });

  it("takes an order, adds the customer and tells them", async () => {
    senders.sms.sent = [];
    const id = randomUUID();
    const res = await place([{ variant: 0, qty: 2 }, { variant: 1, qty: 1 }, { variant: 0, qty: 1 }], { id, marketingConsent: true, note: "No plastic bag" });
    expect(res.statusCode, res.body).toBe(200);
    ({ token } = res.json());
    orderId = id;
    // Pressing the button twice gives the same order.
    expect((await place([{ variant: 0, qty: 2 }], { id })).json()).toEqual({ id, token });

    const { rows } = await ctx.db.query("SELECT number, status, total, lines, customer_id, pickup_code FROM web_orders WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({ number: "W-00001", status: "new", total: ctx.data.variants[0]!.price * 3 + 120 });
    expect(rows[0].lines).toHaveLength(2);
    expect(rows[0].pickup_code).toMatch(/^\d{4}$/);
    const cust = await ctx.db.query("SELECT name, phone, consent_sms, consent_source FROM customers WHERE id = $1", [rows[0].customer_id]);
    expect(cust.rows[0]).toEqual({ name: "Sara Ahmed", phone: "0509991234", consent_sms: true, consent_source: "online_store" });

    await settle();
    expect(senders.sms.sent.map((m) => m.to)).toEqual(["+971509991234"]);
    expect(senders.sms.sent[0]!.text).toMatch(/has your order W-00001 .*pay when you collect/);

    // What the order holds is set aside: only 2 waters are left for others.
    expect((await place([{ variant: 0, qty: 3 }], { phone: "0551112222" })).json().message).toBe(`Only 2 of ${ctx.data.variants[0]!.name} left`);
    // The same phone number is linked to the same customer.
    const second = await place([{ variant: 1, qty: 1 }], { name: "Sara A.", email: "sara@example.ae" });
    const c2 = await ctx.db.query("SELECT customer_id FROM web_orders WHERE token = $1", [second.json().token]);
    expect(c2.rows[0].customer_id).toBe(rows[0].customer_id);
  });

  it("shows the customer their order and lets them cancel until the shop starts", async () => {
    const page = (await shop("GET", `/orders/${token}`)).json();
    expect(page).toMatchObject({ number: "W-00001", status: "new", note: "No plastic bag", store: { name: expect.any(String) } });
    expect(page.lines).toEqual([
      { name: ctx.data.variants[0]!.name, qty: 3 },
      { name: ctx.data.variants[1]!.name, qty: 1 },
    ]);
    expect(page).not.toHaveProperty("phone");
    expect((await shop("GET", "/orders/not-a-token")).statusCode).toBe(404);

    const other = (await place([{ variant: 1, qty: 1 }], { phone: "0563334444" })).json();
    expect((await shop("POST", `/orders/${other.token}/cancel`)).json().status).toBe("cancelled");
  });

  it("limits open orders per phone", async () => {
    await place([{ variant: 1, qty: 1 }]);
    expect((await place([{ variant: 1, qty: 1 }])).json().error).toBe("too_many_open");
  });

  it("lets the store accept and get it ready, and tells the customer when it is", async () => {
    const list = (await api("GET", "/web-orders")).json();
    expect(list.counts).toEqual({ new: 3, open: 3 });
    expect(list.orders[0]).toMatchObject({ number: "W-00001", status: "new", storeName: expect.any(String) });
    const acc = await api("POST", `/web-orders/${orderId}/accept`);
    expect(acc.json().status, acc.body).toBe("accepted");
    expect((await shop("POST", `/orders/${token}/cancel`)).statusCode).toBe(409);
    senders.sms.sent = [];
    expect((await api("POST", `/web-orders/${orderId}/ready`)).json().status).toBe("ready");
    await settle();
    expect(senders.sms.sent[0]!.text).toMatch(/W-00001 is ready at .*Pickup code \d{4}/);
    // Asking again changes nothing and sends nothing.
    await api("POST", `/web-orders/${orderId}/ready`);
    await settle();
    expect(senders.sms.sent).toHaveLength(1);
    expect((await api("POST", `/web-orders/${orderId}/accept`)).statusCode).toBe(409);
  });

  it("keeps store managers to their own stores' orders", async () => {
    const other = randomUUID();
    await ctx.db.query("INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AUH1', 'Abu Dhabi')", [other, ctx.data.tenantId]);
    await ctx.db.query("INSERT INTO user_stores (user_id, store_id, tenant_id) VALUES ($1, $2, $3)", [ctx.data.managerId, other, ctx.data.tenantId]);
    expect((await api("GET", "/web-orders", undefined, manager)).json().orders).toEqual([]);
    expect((await api("POST", `/web-orders/${orderId}/cancel`, {}, manager)).statusCode).toBe(404);
    expect((await api("POST", "/online-store/products", { productIds: [await productIdOf(3)], online: true }, manager)).statusCode).toBe(403);
    await ctx.db.query("DELETE FROM user_stores WHERE user_id = $1", [ctx.data.managerId]);
  });

  it("is handed over by the till sale that takes the payment", async () => {
    const tillList = (await ctx.app.inject({ method: "GET", url: "/web-orders", headers: ctx.auth })).json();
    const mine = tillList.orders.find((o: { id: string }) => o.id === orderId);
    expect(mine).toMatchObject({ status: "ready", lines: expect.any(Array), pickupCode: expect.stringMatching(/^\d{4}$/) });

    const session = await openSession(ctx);
    const sale = makeOrder(ctx, session, [{ variant: 0, qty: 3 }, { variant: 1, qty: 1 }]);
    sale.webOrderId = orderId;
    sale.customerId = mine.customerId;
    expect((await postOrders(ctx, [sale]))[0]!.status).toBe("created");
    const { rows } = await ctx.db.query("SELECT status, order_id, collected_at FROM web_orders WHERE id = $1", [orderId]);
    expect(rows[0]).toMatchObject({ status: "collected", order_id: sale.id });
    expect((await ctx.db.query("SELECT web_order_id FROM orders WHERE id = $1", [sale.id])).rows[0].web_order_id).toBe(orderId);
    expect((await api("GET", `/web-orders/${orderId}`)).json()).toMatchObject({ status: "collected", orderNumber: sale.number });

    // A second sale for the same order is kept (the customer paid) but flagged.
    const again = makeOrder(ctx, session, [{ variant: 1, qty: 1 }]);
    again.webOrderId = orderId;
    expect((await postOrders(ctx, [again]))[0]!.status).toBe("created");
    const flagged = await ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'web_order.collected_twice' AND entity_id = $1", [orderId]);
    expect(flagged.rowCount).toBe(1);
  });

  it("lets a cashier cancel from the till, with the reason sent to the customer", async () => {
    const open = (await ctx.app.inject({ method: "GET", url: "/web-orders", headers: ctx.auth })).json().orders;
    const target = open[0];
    senders.email.sent = [];
    senders.sms.sent = [];
    const res = await ctx.app.inject({
      method: "POST",
      url: `/web-orders/${target.id}/cancel`,
      headers: ctx.auth,
      payload: { userId: ctx.data.cashierId, reason: "Out of bread today" },
    });
    expect(res.json().status).toBe("cancelled");
    await settle();
    const sent = [...senders.email.sent, ...senders.sms.sent];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("cancelled: Out of bread today");
  });

  it("closes when the owner switches it off", async () => {
    await api("PUT", "/online-store", settings({ enabled: false }));
    expect((await shop("GET", "")).statusCode).toBe(404);
    expect((await shop("GET", `/orders/${token}`)).json().status).toBe("collected");
  });
});
