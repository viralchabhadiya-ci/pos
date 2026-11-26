import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { priceOrder, type OrderSync } from "@pos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireSoldOut, markedUp, verifySignature } from "../src/delivery/platform.js";
import { createPairingCode } from "../src/seed.js";
import { signPayload } from "../src/webhooks/deliver.js";
import { openSession, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let screen: { authorization: string };
let ch: { id: string; secret: string; webhookUrl: string };
let water: { id: string; price: number; sku: string };
let sessionId: string;

const api = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers: owner, payload: payload as object });
const till = (method: "GET" | "POST", url: string, payload?: unknown) => ctx.app.inject({ method, url, headers: ctx.auth, payload: payload as object });
const kds = (method: "GET" | "POST", url: string, payload?: unknown) => ctx.app.inject({ method, url, headers: screen, payload: payload as object });

/** What the platform sends, signed with the channel's secret unless told otherwise. */
const platform = (body: unknown, opts: { secret?: string; channelId?: string; at?: number } = {}) => {
  const raw = JSON.stringify(body);
  return ctx.app.inject({
    method: "POST",
    url: `/delivery-api/${opts.channelId ?? ch.id}`,
    headers: { "content-type": "application/json", "pos-signature": signPayload(opts.secret ?? ch.secret, raw, opts.at) },
    payload: raw,
  });
};
const newOrder = (id: string, code: string, items: unknown[], total: number, extra = {}) => ({ type: "order.created", order: { id, code, items, total, ...extra } });
const webOrders = async () => (await till("GET", "/web-orders")).json().orders as Record<string, any>[];
const events = async () => (await api("GET", "/delivery")).json().events as { kind: string; outcome: string; direction: string; detail: string }[];

beforeAll(async () => {
  ctx = await setup();
  const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${login.json().token}` };
  await ctx.db.query("UPDATE products SET online = true WHERE tenant_id = $1", [ctx.data.tenantId]);
  const v = ctx.data.variants[0]!;
  const sku = (await ctx.db.query("UPDATE variants SET sku = COALESCE(sku, 'WATER-500') WHERE id = $1 RETURNING sku", [v.id])).rows[0].sku;
  water = { id: v.id, price: v.price, sku };
  const code = await createPairingCode(ctx.db, ctx.data.registerId, "kitchen");
  const res = await ctx.app.inject({ method: "POST", url: "/pairing/claim", payload: { code, deviceId: randomUUID(), deviceName: "Kitchen" } });
  screen = { authorization: `Bearer ${res.json().token}` };
  sessionId = await openSession(ctx, 1);
});
afterAll(async () => teardown(ctx));

describe("connecting a platform", () => {
  it("gives the channel its own address and secret, and a way to be paid", async () => {
    const res = await api("POST", "/delivery-channels", {
      storeId: ctx.data.storeId,
      provider: "talabat",
      name: "Talabat",
      externalStoreId: "TB-778",
      commissionBp: 2000,
      markupBp: 1000,
    });
    expect(res.statusCode).toBe(201);
    ch = res.json();
    expect(ch.webhookUrl).toMatch(new RegExp(`/delivery-api/${ch.id}$`));
    expect(ch.secret).toMatch(/^whsec_/);
    const again = await api("POST", "/delivery-channels", { storeId: ctx.data.storeId, provider: "talabat", name: "Again", externalStoreId: "TB-778" });
    expect(again.statusCode).toBe(409);
    const methods = await ctx.db.query("SELECT name FROM payment_methods WHERE tenant_id = $1 AND kind = 'delivery'", [ctx.data.tenantId]);
    expect(methods.rows).toEqual([{ name: "Delivery platform" }]);
    expect((await api("POST", "/delivery-channels", { storeId: ctx.data.storeId, provider: "careem", name: "C", externalStoreId: "x", callbackUrl: "http://10.0.0.1/x" })).statusCode).toBe(400);
  });

  it("sends the online menu with the platform's prices, rounded up to 50 fils", async () => {
    expect(markedUp(1000, 1000)).toBe(1100);
    expect(markedUp(1050, 1000)).toBe(1200);
    expect(markedUp(1050, 0)).toBe(1050);
    const menu = (await api("GET", `/delivery-channels/${ch.id}/menu`)).json();
    const item = menu.items.find((i: { posId: string }) => i.posId === water.id);
    expect(item).toMatchObject({ available: true, price: markedUp(water.price, 1000) });
    const sent = (await api("POST", `/delivery-channels/${ch.id}/menu`, {})).json();
    expect(sent).toMatchObject({ outcome: "simulated" });
    expect(sent.items).toBe(menu.items.length);
    expect((await events())[0]).toMatchObject({ direction: "out", kind: "menu.updated", outcome: "simulated" });
  });
});

describe("orders from the platform", () => {
  it("refuses calls that are not signed with the channel's secret, or are old", async () => {
    const body = newOrder("tb-1", "1234", [{ posId: water.id, name: "Water", qty: 1, price: water.price }], water.price);
    expect((await platform(body, { secret: "whsec_wrong" })).statusCode).toBe(401);
    expect((await platform(body, { at: Math.floor(Date.now() / 1000) - 600 })).statusCode).toBe(401);
    expect((await platform(body, { channelId: randomUUID() })).statusCode).toBe(404);
    expect((await platform({ type: "order.created", order: { id: "x" } })).statusCode).toBe(400);
    expect(verifySignature("s", signPayload("s", "{}"), "{}")).toBe(true);
    expect(verifySignature("s", signPayload("s", "{}"), "{ }")).toBe(false);
    expect((await events()).filter((e) => e.outcome === "refused")).toHaveLength(3);
  });

  it("puts a new order on the tills once, at the price the customer paid", async () => {
    const paid = water.price + 100;
    const body = newOrder(
      "tb-1",
      "1234",
      [
        { posId: water.id, name: "Water", qty: 2, price: water.price, modifiers: [{ name: "Cold", price: 100 }], note: "No straw" },
        { sku: "NOT-OURS", name: "Mystery box", qty: 1, price: 500 },
      ],
      paid * 2 + 500,
      { customerName: "Aisha", note: "Ring the bell" },
    );
    const res = await platform(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, duplicate: false, accepted: false });
    const again = await platform(body);
    expect(again.json()).toMatchObject({ orderId: res.json().orderId, duplicate: true });

    const w = (await webOrders()).find((o) => o.id === res.json().orderId)!;
    expect(w).toMatchObject({ channel: "delivery", status: "new", platformName: "Talabat", provider: "talabat", externalCode: "1234", name: "Aisha", total: paid * 2 + 500 });
    expect(w.lines[0]).toMatchObject({ variantId: water.id, qty: 2, unitPrice: paid, modifiers: [{ name: "Cold", price: 100 }], note: "No straw" });
    expect(w.lines[1]).toMatchObject({ variantId: null, name: "Mystery box" });
    expect(Date.parse(w.acceptBy) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await events()).find((e) => e.kind === "order.created")!.detail).toContain("not on the menu here: Mystery box");
  });

  it("accepts an order from the till: the platform is told and the kitchen gets a ticket", async () => {
    const w = (await webOrders()).find((o) => o.externalCode === "1234")!;
    const res = await till("POST", `/delivery-orders/${w.id}/accept`, { userId: ctx.data.cashierId, prepMinutes: 25 });
    expect(res.json()).toMatchObject({ status: "accepted", platform: "simulated" });
    expect((await till("POST", `/delivery-orders/${w.id}/accept`, { userId: ctx.data.cashierId })).json()).toMatchObject({ status: "accepted", platform: null });
    const out = (await events()).find((e) => e.kind === "order.accepted")!;
    expect(out.detail).toBe("orderId: tb-1, prepMinutes: 25");
    const tickets = (await kds("GET", "/kitchen/tickets")).json().tickets;
    const t = tickets.find((x: { label: string }) => x.label === "Talabat 1234");
    expect(t.lines[0]).toMatchObject({ name: expect.any(String), qty: 2, modifiers: ["Cold"], note: "No straw" });
    expect((await till("POST", `/delivery-orders/${w.id}/reject`, { userId: ctx.data.cashierId, reason: "Busy" })).statusCode).toBe(409);

    // Ready on the kitchen screen tells the platform to send the rider.
    expect((await kds("POST", `/kitchen/tickets/${t.id}/status`, { status: "ready" })).statusCode).toBe(200);
    expect((await webOrders()).find((o) => o.id === w.id)!.status).toBe("ready");
    expect((await events())[0]).toMatchObject({ kind: "order.ready", outcome: "simulated" });
  });

  it("shows the rider, and rings up the sale as paid by the platform when the rider collects", async () => {
    await platform({ type: "order.rider", orderId: "tb-1", riderName: "Imran", arrivesAt: new Date(Date.now() + 300_000).toISOString() });
    const w = (await webOrders()).find((o) => o.externalCode === "1234")!;
    expect(w.riderName).toBe("Imran");

    const deliveryMethod = (await ctx.db.query("SELECT id FROM payment_methods WHERE tenant_id = $1 AND kind = 'delivery'", [ctx.data.tenantId])).rows[0].id;
    const vat = { id: ctx.data.vatId, name: "VAT 5%", rateBp: 500, priceIncluded: true };
    const lines = [{ id: randomUUID(), variantId: water.id, name: "Water", qty: 2, unitPrice: water.price + 100, taxId: ctx.data.vatId, modifiers: [{ name: "Cold", price: 100 }] }];
    const totals = priceOrder(lines, { taxes: { [vat.id]: vat } });
    const sale = (webOrderId: string | null, n: string): OrderSync => ({
      id: randomUUID(),
      number: `DXB1-R1-0001-90${n}`,
      registerId: ctx.data.registerId,
      sessionId,
      cashierId: ctx.data.cashierId,
      customerId: null,
      refundOfOrderId: null,
      webOrderId,
      orderDiscountBp: 0,
      createdAt: new Date().toISOString(),
      lines: lines.map((l) => ({ ...l, id: randomUUID(), discountBp: 0, promoDiscount: 0, promotionId: null })),
      promotions: [],
      payments: [{ id: randomUUID(), methodId: deliveryMethod, kind: "delivery", amount: totals.total, reference: "Talabat 1234" }],
      clientTotals: { subtotalNet: totals.subtotalNet, taxTotal: totals.taxTotal, total: totals.total },
    });
    const res = await till("POST", "/orders/batch", { orders: [sale(null, "01"), sale(w.id, "02")] });
    const [noLink, linked] = res.json().results;
    expect(noLink).toMatchObject({ status: "rejected" });
    expect(linked).toMatchObject({ status: "created" });
    expect((await webOrders()).some((o) => o.id === w.id)).toBe(false);
  });

  it("turns an order down, and takes cancellations from the platform", async () => {
    const a = (await platform(newOrder("tb-2", "2001", [{ posId: water.id, name: "Water", qty: 1, price: water.price }], water.price))).json().orderId;
    const b = (await platform(newOrder("tb-3", "2002", [{ posId: water.id, name: "Water", qty: 1, price: water.price }], water.price))).json().orderId;
    expect((await till("POST", `/delivery-orders/${a}/reject`, { userId: ctx.data.cashierId, reason: "Closing soon" })).json()).toMatchObject({ status: "cancelled" });
    expect((await events())[0]).toMatchObject({ kind: "order.rejected", detail: "orderId: tb-2, reason: Closing soon" });

    // The generic till buttons go through the platform too.
    expect((await till("POST", `/web-orders/${b}/accept`, { userId: ctx.data.cashierId })).json()).toMatchObject({ status: "accepted", platform: "simulated" });
    expect((await platform({ type: "order.cancelled", orderId: "tb-3", reason: "Customer cancelled" })).json()).toMatchObject({ changed: true });
    const t = (await kds("GET", "/kitchen/tickets")).json().tickets.find((x: { label: string }) => x.label === "Talabat 2002");
    expect(t.cancelledAt).toBeTruthy();
    const { rows } = await ctx.db.query("SELECT status, cancel_reason FROM web_orders WHERE id = $1", [b]);
    expect(rows[0]).toEqual({ status: "cancelled", cancel_reason: "Cancelled by Talabat: Customer cancelled" });
  });

  it("accepts on its own when the channel says so, unless an item is unknown", async () => {
    await api("PUT", `/delivery-channels/${ch.id}`, { storeId: ctx.data.storeId, provider: "talabat", name: "Talabat", externalStoreId: "TB-778", autoAccept: true, commissionBp: 2000, markupBp: 1000 });
    const ok = (await platform(newOrder("tb-4", "3001", [{ sku: water.sku, name: "Water", qty: 1, price: water.price }], water.price))).json();
    expect(ok).toMatchObject({ accepted: true });
    const unknown = (await platform(newOrder("tb-5", "3002", [{ name: "Something else", qty: 1, price: 900 }], 900))).json();
    expect(unknown.accepted).toBe(false);
    const list = await webOrders();
    expect(list.find((o) => o.externalCode === "3001")!.status).toBe("accepted");
    expect(list.find((o) => o.externalCode === "3002")!.status).toBe("new");
  });
});

describe("busy and sold out", () => {
  it("pauses the store's platforms and marks items sold out from the till", async () => {
    const busy = (await till("POST", "/delivery/busy", { userId: ctx.data.cashierId, minutes: 30 })).json();
    expect(busy).toMatchObject({ channels: 1, failed: 0 });
    let status = (await till("GET", "/delivery")).json();
    expect(Date.parse(status.channels[0].pausedUntil) - Date.now()).toBeGreaterThan(29 * 60_000);
    await till("POST", "/delivery/busy", { userId: ctx.data.cashierId, minutes: null });
    expect((await till("GET", "/delivery")).json().channels[0].pausedUntil).toBeNull();
    expect((await events()).slice(0, 2).map((e) => e.detail)).toEqual(["Taking orders", expect.stringMatching(/^Busy until \d\d:\d\d$/)]);

    await till("POST", "/delivery/sold-out", { userId: ctx.data.cashierId, variantIds: [water.id], soldOut: true, minutes: 60 });
    status = (await till("GET", "/delivery")).json();
    expect(status.soldOut).toEqual([{ variantId: water.id, name: expect.any(String), until: expect.any(String) }]);
    const menu = (await api("GET", `/delivery-channels/${ch.id}/menu`)).json();
    expect(menu.items.find((i: { posId: string }) => i.posId === water.id).available).toBe(false);
    expect((await events())[0]).toMatchObject({ kind: "items.availability", detail: "1 item sold out" });

    // Back on by itself when the time is up.
    await ctx.db.query("UPDATE delivery_sold_out SET until = now() - interval '1 minute'");
    expect(await expireSoldOut(ctx.db)).toBe(1);
    expect((await till("GET", "/delivery")).json().soldOut).toEqual([]);
    expect((await events())[0]).toMatchObject({ kind: "items.availability", detail: "1 item back on" });
  });

  it("keeps store managers off the platform contracts", async () => {
    const { isHqOnly } = await import("../src/stores.js");
    expect(isHqOnly("POST", "/admin/delivery-channels")).toBe(true);
    expect(isHqOnly("POST", "/admin/delivery/sold-out")).toBe(false);
  });
});

describe("talking to a real endpoint", () => {
  it("signs what it sends, and records a failure", async () => {
    const got: { body: string; sig: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push({ body, sig: String(req.headers["pos-signature"]) });
        res.statusCode = got.length === 1 ? 200 : 500;
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    process.env.WEBHOOK_ALLOW_HTTP = "1";
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const put = await api("PUT", `/delivery-channels/${ch.id}`, { storeId: ctx.data.storeId, provider: "talabat", name: "Talabat", externalStoreId: "TB-778", callbackUrl: url });
      expect(put.statusCode).toBe(200);
      const id = (await platform(newOrder("tb-6", "4001", [{ posId: water.id, name: "Water", qty: 1, price: water.price }], water.price))).json().orderId;
      expect((await till("POST", `/delivery-orders/${id}/accept`, { userId: ctx.data.cashierId })).json().platform).toBe("sent");
      expect(verifySignature(ch.secret, got[0]!.sig, got[0]!.body)).toBe(true);
      expect(JSON.parse(got[0]!.body)).toMatchObject({ type: "order.accepted", provider: "talabat", storeId: "TB-778", data: { orderId: "tb-6", prepMinutes: 20 } });
      expect((await till("POST", `/delivery-orders/${id}/ready`, { userId: ctx.data.cashierId })).json().platform).toBe("failed");
      expect((await events())[0]).toMatchObject({ kind: "order.ready", outcome: "failed", detail: "HTTP 500 ok" });
    } finally {
      delete process.env.WEBHOOK_ALLOW_PRIVATE;
      delete process.env.WEBHOOK_ALLOW_HTTP;
      server.close();
    }
  });
});

describe("payout report", () => {
  it("adds up sales, the platform's commission and the payout", async () => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
    const r = (await api("GET", `/delivery/report?from=${day}&to=${day}`)).json();
    const sales = (water.price + 100) * 2 + 500;
    expect(r.rows[0]).toMatchObject({ name: "Talabat", delivered: 1, cancelled: 2, sales, commission: Math.round(sales * 0.2), payout: sales - Math.round(sales * 0.2) });
    const test = (await api("POST", `/delivery-channels/${ch.id}/test-order`, {})).json();
    expect(test.code).toMatch(/^TEST-\d{4}$/);
    const csv = await api("GET", `/delivery/report?from=${day}&to=${day}&format=csv`);
    expect(csv.body).toContain("Talabat");
  });
});
