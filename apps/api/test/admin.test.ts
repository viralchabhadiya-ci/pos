import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed } from "../src/seed.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };

async function login(email: string, password: string) {
  return ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
}

function api(method: "GET" | "POST" | "PUT", url: string, payload?: object, headers = owner) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
}

beforeAll(async () => {
  ctx = await setup();
  const res = await login(ctx.data.ownerEmail, ctx.data.ownerPassword);
  owner = { authorization: `Bearer ${res.json().token}` };
});
afterAll(async () => teardown(ctx));

describe("back office sign-in", () => {
  it("signs the owner in and out", async () => {
    const res = await login("OWNER@demo.ae", "demo1234");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { role: "owner" }, tenant: { name: "Demo Minimart LLC" } });
    const auth = { authorization: `Bearer ${res.json().token}` };
    const me = await api("GET", "/me", undefined, auth);
    expect(me.json().stores).toHaveLength(1);
    await api("POST", "/logout", {}, auth);
    expect((await api("GET", "/me", undefined, auth)).statusCode).toBe(401);
  });

  it("refuses device tokens and missing tokens", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me" })).statusCode).toBe(401);
    expect((await api("GET", "/me", undefined, ctx.auth)).statusCode).toBe(401);
  });

  it("locks an email after five wrong passwords", async () => {
    const email = "manager@demo.ae";
    for (let i = 0; i < 5; i++) expect((await login(email, "wrong")).statusCode).toBe(401);
    const locked = await login(email, "wrong");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe("too_many_attempts");
  });
});

describe("products", () => {
  it("creates a product and sends price changes to tills", async () => {
    const taxes = (await api("GET", "/taxes")).json().taxes;
    const cats = (await api("GET", "/categories")).json().categories;
    const created = await api("POST", "/products", {
      name: "Rani Float Mango",
      nameAr: "راني فلوت مانجو",
      categoryId: cats[0].id,
      taxId: taxes[0].id,
      price: 300,
      barcode: "6281000099991",
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const before = await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth });
    const since = before.json().serverTime;

    const product = (await api("GET", `/products/${id}`)).json();
    const updated = await api("PUT", `/products/${id}`, { ...product, price: 325 });
    expect(updated.statusCode).toBe(200);

    const delta = await ctx.app.inject({
      method: "GET",
      url: `/sync/catalog?since=${encodeURIComponent(since)}`,
      headers: ctx.auth,
    });
    expect(JSON.stringify(delta.json())).toContain("6281000099991");
    expect(JSON.stringify(delta.json())).toContain("325");

    const { rows } = await ctx.db.query("SELECT data FROM audit_log WHERE action = 'product.update' AND entity_id = $1", [id]);
    expect(rows[0].data).toMatchObject({ priceFrom: 300, priceTo: 325 });
  });

  it("refuses a barcode another product uses", async () => {
    const res = await api("POST", "/products", { name: "Copy", price: 100, barcode: ctx.data.variants[0]!.barcode });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("barcode_taken");
  });

  it("finds products by name or barcode and tracks stock", async () => {
    const byBarcode = (await api("GET", `/products?q=${ctx.data.variants[2]!.barcode}`)).json().products;
    expect(byBarcode).toHaveLength(1);
    const id = byBarcode[0].id;
    const res = await api("POST", `/products/${id}/stock`, { storeId: ctx.data.storeId, qty: 24, reason: "receive" });
    expect(Number(res.json().onHand)).toBe(24);
    expect((await api("GET", "/products?q=coca")).json().products[0].name).toContain("Coca");
  });
});

describe("staff", () => {
  it("adds a cashier whose PIN works on the till", async () => {
    const res = await api("POST", "/staff", { name: "Fatima", role: "cashier", pin: "4321" });
    expect(res.statusCode).toBe(200);
    const staff = (await api("GET", "/staff")).json().staff;
    expect(staff.find((s: { name: string }) => s.name === "Fatima")).toMatchObject({ role: "cashier", canSignIn: false });
  });

  it("refuses a PIN someone active already uses", async () => {
    const res = await api("POST", "/staff", { name: "Clash", role: "cashier", pin: "1234" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("pin_taken");
  });

  it("lets a manager manage cashiers only", async () => {
    await api("PUT", `/staff/${ctx.data.managerId}`, {
      name: "Rahul (Manager)",
      role: "manager",
      active: true,
      email: "rahul@demo.ae",
      password: "manager123",
    });
    const res = await login("rahul@demo.ae", "manager123");
    expect(res.statusCode).toBe(200);
    const manager = { authorization: `Bearer ${res.json().token}` };
    expect((await api("POST", "/staff", { name: "New boss", role: "manager", pin: "5555" }, manager)).statusCode).toBe(403);
    expect((await api("POST", "/staff", { name: "Yusuf", role: "cashier", pin: "5556" }, manager)).statusCode).toBe(200);
  });

  it("signs a switched-off manager out at once", async () => {
    const res = await login("rahul@demo.ae", "manager123");
    const manager = { authorization: `Bearer ${res.json().token}` };
    await api("PUT", `/staff/${ctx.data.managerId}`, { name: "Rahul (Manager)", role: "manager", active: false, email: "rahul@demo.ae" });
    expect((await api("GET", "/me", undefined, manager)).statusCode).toBe(401);
  });

  it("stops the owner from switching off their own account", async () => {
    const res = await api("PUT", `/staff/${ctx.data.ownerId}`, { name: "Omar", role: "owner", active: false });
    expect(res.statusCode).toBe(400);
  });
});

describe("registers and devices", () => {
  it("creates a register and a pairing code a till can claim", async () => {
    const reg = await api("POST", "/registers", { storeId: ctx.data.storeId, name: "Counter 2", code: "r2" });
    expect(reg.statusCode).toBe(200);
    const pair = await api("POST", `/registers/${reg.json().id}/pairing-code`, {});
    expect(pair.json().code).toMatch(/^\d{6}$/);
    const claim = await ctx.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { code: pair.json().code, deviceId: crypto.randomUUID(), deviceName: "Till 2" },
    });
    expect(claim.json().register.code).toBe("R2");

    const registers = (await api("GET", "/registers")).json().registers;
    const r2 = registers.find((r: { code: string }) => r.code === "R2");
    expect(r2.devices).toHaveLength(1);
  });

  it("refuses a duplicate register code", async () => {
    const res = await api("POST", "/registers", { storeId: ctx.data.storeId, name: "Again", code: "R2" });
    expect(res.statusCode).toBe(409);
  });

  it("revokes a device so its token stops working", async () => {
    const pair = await api("POST", `/registers/${ctx.data.registerId}/pairing-code`, {});
    const deviceId = crypto.randomUUID();
    const claim = await ctx.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { code: pair.json().code, deviceId, deviceName: "Spare" },
    });
    const auth = { authorization: `Bearer ${claim.json().token}` };
    expect((await ctx.app.inject({ method: "GET", url: "/device/setup", headers: auth })).statusCode).toBe(200);
    expect((await api("POST", `/devices/${deviceId}/revoke`, {})).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/device/setup", headers: auth })).statusCode).toBe(401);
  });
});

describe("sales and dashboard", () => {
  let saleId: string;

  beforeAll(async () => {
    const sessionId = await openSession(ctx);
    const sale = makeOrder(ctx, sessionId, [{ variant: 0, qty: 2 }, { variant: 4, qty: 1 }], { pay: "cash", tendered: 1000 });
    const card = makeOrder(ctx, sessionId, [{ variant: 2, qty: 4 }], { pay: "card" });
    saleId = sale.id;
    await postOrders(ctx, [sale, card]);
    const refund = makeOrder(ctx, sessionId, [{ variant: 0, qty: -1 }], { pay: "cash", refundOf: sale.id });
    await postOrders(ctx, [refund]);
  });

  it("lists and searches bills", async () => {
    const all = (await api("GET", "/orders")).json();
    expect(all.count).toBe(3);
    expect(all.orders[0]).toMatchObject({ cashierName: "Aisha (Cashier)", registerName: "Counter 1" });
    const refunds = (await api("GET", "/orders?type=refunds")).json();
    expect(refunds.count).toBe(1);
    const number = all.orders[2].number as string;
    expect((await api("GET", `/orders?q=${number.slice(-4)}`)).json().orders[0].number).toBe(number);
  });

  it("shows a bill with lines, payments and its refunds", async () => {
    const bill = (await api("GET", `/orders/${saleId}`)).json();
    expect(bill.lines).toHaveLength(2);
    expect(bill.payments[0]).toMatchObject({ kind: "cash", tendered: 1000 });
    expect(bill.refunds).toHaveLength(1);
  });

  it("adds up today's dashboard", async () => {
    const d = (await api("GET", "/dashboard")).json();
    // 2 x 1.50 + 6.50 cash, 4 x 2.50 card, minus a 1.50 refund
    expect(d).toMatchObject({ orderCount: 2, refundCount: 1, total: 1800, refunds: 150 });
    expect(d.tax).toBe(Math.round(d.total - d.net));
    expect(d.payments).toEqual([
      { kind: "card", amount: 1000 },
      { kind: "cash", amount: 800 },
    ]);
    expect(d.averageBasket).toBe(975);
    expect(d.trend).toHaveLength(7);
    expect(d.trend[6].total).toBe(1800);
    expect(d.hourly.reduce((n: number, h: { total: number }) => n + h.total, 0)).toBe(1800);
    expect(d.topProducts[0].name).toBe("Coca-Cola 330ml");
  });
});

describe("tenant isolation", () => {
  it("keeps one business out of another's data", async () => {
    const other = await seed(ctx.db);
    const res = await login(other.ownerEmail, other.ownerPassword);
    const them = { authorization: `Bearer ${res.json().token}` };
    expect((await api("GET", "/orders", undefined, them)).json().count).toBe(0);
    expect((await api("GET", `/orders/${(await api("GET", "/orders")).json().orders[0].id}`, undefined, them)).statusCode).toBe(404);
    expect((await api("PUT", `/staff/${ctx.data.cashierId}`, { name: "x", role: "cashier", active: false }, them)).statusCode).toBe(404);
    expect((await api("POST", `/registers/${ctx.data.registerId}/pairing-code`, {}, them)).statusCode).toBe(404);
    const products = (await api("GET", "/products", undefined, them)).json().products;
    expect(products.some((p: { name: string }) => p.name === "Rani Float Mango")).toBe(false);
  });
});
