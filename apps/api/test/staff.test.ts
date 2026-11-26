import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPairingCode } from "../src/seed.js";
import { setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let phone: { authorization: string };

async function admin(method: "GET" | "POST" | "PUT", url: string, payload?: object) {
  const res = await ctx.app.inject({ method, url: `/admin${url}`, headers: owner, payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const staff = (method: "GET" | "POST" | "PUT", url: string, session: string | null, payload?: object) =>
  ctx.app.inject({ method, url, headers: { ...phone, ...(session ? { "x-staff-session": session } : {}) }, payload });

async function signIn(pin: string) {
  const res = await staff("POST", "/staff/login", null, { pin });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().token as string;
}

beforeAll(async () => {
  ctx = await setup();
  const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${login.json().token}` };
  const code = await createPairingCode(ctx.db, ctx.data.registerId, "staff");
  const claim = await ctx.app.inject({ method: "POST", url: "/pairing/claim", payload: { code, deviceId: randomUUID(), deviceName: "Aisha's phone" } });
  expect(claim.statusCode, claim.body).toBe(200);
  phone = { authorization: `Bearer ${claim.json().token}` };
});
afterAll(async () => teardown(ctx));

describe("staff phone", () => {
  it("is kept away from the till's routes", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/device/setup", headers: phone });
    expect(res.statusCode).toBe(401);
    const till = await ctx.app.inject({ method: "GET", url: "/staff/device", headers: ctx.auth });
    expect(till.statusCode).toBe(401);
    const setup = await ctx.app.inject({ method: "GET", url: "/staff/device", headers: phone });
    expect(setup.json().store.id).toBe(ctx.data.storeId);
  });

  it("signs staff in by PIN and stops guessing after five tries", async () => {
    expect((await staff("GET", "/staff/lookup?q=water", null)).statusCode).toBe(401);
    const token = await signIn("1234");
    expect((await staff("GET", "/staff/lookup?q=water", token)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await staff("POST", "/staff/login", null, { pin: "0000" })).statusCode).toBe(401);
    expect((await staff("POST", "/staff/login", null, { pin: "1234" })).statusCode).toBe(429);
  });
});

describe("price check and the rest", () => {
  let cashier: string;
  let manager: string;
  beforeAll(async () => {
    // A fresh phone, so the lock from the test above does not apply.
    const code = await createPairingCode(ctx.db, ctx.data.registerId, "staff");
    const claim = await ctx.app.inject({ method: "POST", url: "/pairing/claim", payload: { code, deviceId: randomUUID(), deviceName: "Store phone" } });
    phone = { authorization: `Bearer ${claim.json().token}` };
    cashier = await signIn("1234");
    manager = await signIn("9999");
  });

  it("finds a product by barcode with price and stock", async () => {
    const v = ctx.data.variants[0]!;
    await admin("POST", "/inventory/adjustments", { storeId: ctx.data.storeId, reason: "adjust", lines: [{ variantId: v.id, qty: 12 }] }).catch(() => null);
    const res = await staff("GET", `/staff/lookup?q=${v.barcode}`, cashier);
    expect(res.statusCode, res.body).toBe(200);
    const item = res.json().items[0];
    expect(item).toMatchObject({ variantId: v.id, name: v.name, price: v.price });
    expect(typeof item.onHand).toBe("number");
    const byName = await staff("GET", `/staff/lookup?q=${encodeURIComponent(v.name.slice(0, 4))}`, cashier);
    expect(byName.json().items.some((i: { variantId: string }) => i.variantId === v.id)).toBe(true);
  });

  it("reads a scale barcode", async () => {
    const banana = ctx.data.variants.find((v) => v.name.startsWith("Bananas"))!;
    const { rows } = await ctx.db.query("SELECT plu FROM variants WHERE id = $1", [banana.id]);
    const body = `21${rows[0].plu.padStart(5, "0")}01250`;
    let check = 0;
    for (let i = 0; i < 12; i++) check += Number(body[i]) * (i % 2 ? 3 : 1);
    const code = body + String((10 - (check % 10)) % 10);
    const res = await staff("GET", `/staff/lookup?q=${code}`, cashier);
    expect(res.json().items[0].variantId).toBe(banana.id);
    expect(res.json().scale).toEqual({ kind: "weight", value: 1250 });
  });

  it("counts stock on an open count, without showing the expected figure", async () => {
    const count = await admin("POST", "/stock-counts", { storeId: ctx.data.storeId });
    const list = await staff("GET", "/staff/counts", cashier);
    expect(list.json().counts.map((c: { id: string }) => c.id)).toContain(count.id);
    const sheet = (await staff("GET", `/staff/counts/${count.id}`, cashier)).json();
    expect(sheet.lines[0]).not.toHaveProperty("expected");
    const v = ctx.data.variants[1]!;
    const saved = await staff("PUT", `/staff/counts/${count.id}/lines`, cashier, { lines: [{ variantId: v.id, counted: 7 }] });
    expect(saved.statusCode, saved.body).toBe(200);
    const detail = await admin("GET", `/stock-counts/${count.id}`);
    expect(detail.lines.find((l: { variantId: string }) => l.variantId === v.id).counted).toBe(7);
  });

  it("receives a delivery: managers only", async () => {
    const supplier = await admin("POST", "/suppliers", { name: "Phone Supplier" });
    const v = ctx.data.variants[2]!;
    const po = await admin("POST", "/purchase-orders", { supplierId: supplier.id, storeId: ctx.data.storeId, lines: [{ variantId: v.id, qty: 10, unitCost: 150 }] });
    await admin("POST", `/purchase-orders/${po.id}/order`, {});
    const list = (await staff("GET", "/staff/deliveries", cashier)).json();
    expect(list.orders.map((o: { id: string }) => o.id)).toContain(po.id);
    const detail = (await staff("GET", `/staff/deliveries/${po.id}`, cashier)).json();
    const line = detail.lines[0];
    expect(line).toMatchObject({ ordered: 10, received: 0 });
    const body = { lines: [{ lineId: line.id, qty: 4 }] };
    expect((await staff("POST", `/staff/deliveries/${po.id}/receive`, cashier, body)).statusCode).toBe(403);
    const ok = await staff("POST", `/staff/deliveries/${po.id}/receive`, manager, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("partial");
    const after = (await staff("GET", `/staff/deliveries/${po.id}`, manager)).json();
    expect(after.lines[0].received).toBe(4);
  });

  it("asks for labels that the back office prints", async () => {
    const v = ctx.data.variants[3]!;
    expect((await staff("POST", "/staff/labels", cashier, { variantId: v.id, copies: 3, reason: "New price" })).statusCode).toBe(200);
    const queue = await admin("GET", "/label-requests");
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]).toMatchObject({ copies: 3, reason: "New price" });
    expect(queue.products[0].variantId).toBe(v.id);
    await admin("POST", "/label-requests/printed", { ids: [queue.requests[0].id] });
    expect((await admin("GET", "/label-requests")).requests).toHaveLength(0);
  });

  it("signs out", async () => {
    await staff("POST", "/staff/logout", cashier, {});
    expect((await staff("GET", "/staff/counts", cashier)).statusCode).toBe(401);
  });
});
