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
    // The last 9 characters (shift and bill number) are unique within one register.
    expect((await api("GET", `/orders?q=${number.slice(-9)}`)).json().orders.map((o: { number: string }) => o.number)).toEqual([number]);
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

describe("barcodes, VAT kinds and CSV", () => {
  it("rings up extra barcodes and refuses one already in use", async () => {
    const res = await api("POST", "/products", { name: "Pepsi 330ml", price: 250, barcode: "6290000000011", extraBarcodes: ["6290000000012"] });
    expect(res.statusCode).toBe(200);
    expect((await api("GET", "/products?q=6290000000012")).json().products[0].name).toBe("Pepsi 330ml");
    const clash = await api("POST", "/products", { name: "Clash", price: 100, extraBarcodes: ["6290000000011"] });
    expect(clash.statusCode).toBe(409);
    const sync = await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth });
    expect(JSON.stringify(sync.json().variants)).toContain("6290000000012");
  });

  it("has standard, zero-rated and exempt VAT", async () => {
    const kinds = (await api("GET", "/taxes")).json().taxes.map((t: { kind: string }) => t.kind).sort();
    expect(kinds).toEqual(["exempt", "standard", "zero"]);
    expect((await api("POST", "/taxes", { name: "Bad", rateBp: 500, kind: "zero" })).statusCode).toBe(400);
  });

  it("checks a CSV first, then imports it all or nothing", async () => {
    const bad = "name,price,vat\nGood,1.00,Exempt\nBroken,abc,\n";
    const check = (await api("POST", "/products/import", { csv: bad, dryRun: false })).json();
    expect(check.saved).toBe(false);
    expect(check.errors).toEqual([expect.objectContaining({ row: 3 })]);
    expect((await api("GET", "/products?q=Good")).json().products).toHaveLength(0);

    const csv = "name,category,barcode,price,vat\nDates 500g,Dry Food,6290000000099,12.50,Zero-rated 0%\nPepsi 330ml,,6290000000011,2.75,\n";
    const dry = (await api("POST", "/products/import", { csv })).json();
    expect(dry).toMatchObject({ create: 1, update: 1, newCategories: ["Dry Food"], saved: false });
    const done = (await api("POST", "/products/import", { csv, dryRun: false })).json();
    expect(done.saved).toBe(true);
    expect((await api("GET", "/products?q=6290000000011")).json().products[0].price).toBe(275);
    const exported = await api("GET", "/products/export.csv");
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.body).toContain("Dates 500g,,Dry Food,6290000000099");
  });
});

describe("reports, customers, audit and settings", () => {
  it("groups sales by product, cashier, payment and day, and exports CSV", async () => {
    const today = (await api("GET", "/dashboard")).json().date;
    const q = `from=${today}&to=${today}`;
    const byProduct = (await api("GET", `/reports/sales?${q}&groupBy=product`)).json();
    expect(byProduct.rows[0]).toMatchObject({ name: "Coca-Cola 330ml" });
    const byCashier = (await api("GET", `/reports/sales?${q}&groupBy=cashier`)).json().rows;
    expect(byCashier).toEqual([expect.objectContaining({ name: "Aisha (Cashier)", orders: 2, refunds: 1, total: 1800 })]);
    const byPayment = (await api("GET", `/reports/sales?${q}&groupBy=payment`)).json().rows;
    expect(byPayment.reduce((n: number, r: { total: number }) => n + r.total, 0)).toBe(1800);
    const byDay = (await api("GET", `/reports/sales?${q}&groupBy=day`)).json().rows;
    expect(byDay).toEqual([expect.objectContaining({ name: today, total: 1800 })]);
    const csv = await api("GET", `/reports/sales?${q}&groupBy=category&format=csv`);
    expect(csv.headers["content-disposition"]).toContain("sales-by-category");
    expect(csv.body.split("\r\n")[0]).toContain("Category,Qty sold");
    expect((await api("GET", `/reports/sales?from=${today}&to=2020-01-01`)).statusCode).toBe(400);
  });

  it("splits VAT into the return's boxes, net of credit notes", async () => {
    const today = (await api("GET", "/dashboard")).json().date;
    const vat = (await api("GET", `/reports/vat?from=${today}&to=${today}`)).json();
    const d = (await api("GET", "/dashboard")).json();
    expect(vat.boxes.standardRated).toEqual({ amount: d.net, vat: d.tax });
    expect(vat.rows[0]).toMatchObject({ kind: "standard", rateBp: 500 });
    expect(vat.rows[0].refundNet).toBeGreaterThan(0);
  });

  it("adds customers, refuses a duplicate phone and shows their bills", async () => {
    const res = await api("POST", "/customers", { name: "Mariam", phone: "0501234567", trn: "100200300400500" });
    expect(res.statusCode).toBe(200);
    expect((await api("POST", "/customers", { name: "Copy", phone: "0501234567" })).statusCode).toBe(409);
    expect((await api("POST", "/customers", { name: "Bad TRN", trn: "123" })).statusCode).toBe(400);
    const found = (await api("GET", "/customers?q=4567")).json();
    expect(found.customers[0]).toMatchObject({ name: "Mariam", orders: 0, spent: 0 });
    expect((await api("GET", `/customers/${res.json().id}`)).json().orders).toEqual([]);
  });

  it("lists the audit log with who did what", async () => {
    const log = (await api("GET", "/audit?entity=customer")).json();
    expect(log.entries[0]).toMatchObject({ action: "customer.create", userName: "Omar (Owner)" });
    expect((await api("GET", "/audit?q=priceTo")).json().count).toBeGreaterThan(0);
  });

  it("lets the owner edit receipt details that reach the till", async () => {
    const store = (await api("GET", "/stores")).json().stores[0];
    const since = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth })).json().serverTime;
    const res = await api("PUT", `/stores/${store.id}`, { ...store, phone: "04 123 4567", receiptFooter: "See you soon" });
    expect(res.statusCode).toBe(200);
    expect((await api("PUT", `/stores/${store.id}`, { ...store, timezone: "Mars/Base" })).statusCode).toBe(400);
    const delta = await ctx.app.inject({ method: "GET", url: `/sync/catalog?since=${encodeURIComponent(since)}`, headers: ctx.auth });
    expect(delta.json().store).toMatchObject({ phone: "04 123 4567", receiptFooter: "See you soon" });
  });

  it("flags products at or below their reorder level", async () => {
    const p = (await api("GET", "/products?q=Croissant")).json().products[0];
    await api("PUT", `/products/${p.id}`, { ...p, reorderLevel: 5 });
    const d = (await api("GET", "/dashboard")).json();
    expect(d.lowStock.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Croissant", reorderLevel: 5 })]));
    expect((await api("GET", "/products?status=low")).json().products.map((x: { name: string }) => x.name)).toContain("Croissant");
  });
});
