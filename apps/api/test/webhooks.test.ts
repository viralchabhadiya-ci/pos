import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkWebhookUrl, deliverDue, isPrivateAddress, MAX_ATTEMPTS, postWebhook, signPayload } from "../src/webhooks/deliver.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

const OPTS = { allowPrivate: true, allowHttp: true };

let ctx: Ctx;
let owner: { authorization: string };
let server: http.Server;
let url: string;
let received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let answer = 200;

function admin(method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: object) {
  return ctx.app.inject({ method, url: `/admin${path}`, headers: owner, payload });
}

async function addEndpoint(events: string[], path = "/hook") {
  const res = await admin("POST", "/webhooks", { url: `${url}${path}`, events, description: "Test receiver" });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; secret: string };
}

beforeAll(async () => {
  ctx = await setup({ webhookOptions: OPTS });
  const res = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${res.json().token}` };
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = answer;
      res.end(answer < 300 ? "ok" : "nope");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await teardown(ctx);
});
beforeEach(async () => {
  received = [];
  answer = 200;
  await ctx.db.query("DELETE FROM webhook_endpoints");
});

describe("webhook endpoints", () => {
  it("refuses addresses that are not public https", () => {
    expect(checkWebhookUrl("http://example.com/x")).toMatch(/https/);
    expect(checkWebhookUrl("https://localhost/x")).toMatch(/private or local/);
    expect(checkWebhookUrl("https://127.0.0.1/x")).toMatch(/private or local/);
    expect(checkWebhookUrl("https://169.254.169.254/latest")).toMatch(/private or local/);
    expect(checkWebhookUrl("https://[::1]/x")).toMatch(/private or local/);
    expect(checkWebhookUrl("https://user:pw@example.com/x")).toMatch(/credentials/);
    expect(checkWebhookUrl("not a url")).toMatch(/full web address/);
    expect(checkWebhookUrl("https://hooks.example.com/pos")).toBeNull();
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("does not call a name that resolves to a private address", async () => {
    const r = await postWebhook(`http://localhost:${new URL(url).port}/x`, "{}", {}, { allowHttp: true, allowPrivate: false });
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/private/);
    expect(received).toHaveLength(0);
  });

  it("only lets the owner add one, and checks the events", async () => {
    expect((await admin("POST", "/webhooks", { url: `${url}/x`, events: ["order.eaten"] })).statusCode).toBe(400);
    expect((await admin("POST", "/webhooks", { url: `${url}/x`, events: [] })).statusCode).toBe(400);
    const ep = await addEndpoint(["order.created", "*"]);
    expect(ep.secret).toMatch(/^whsec_/);
    const got = await admin("GET", `/webhooks/${ep.id}`);
    expect(got.json()).toMatchObject({ events: ["*"], active: true });
    expect(JSON.stringify(got.json())).not.toContain(ep.secret);
    expect((await admin("GET", `/webhooks/${ep.id}/secret`)).json().secret).toBe(ep.secret);
    const rotated = (await admin("POST", `/webhooks/${ep.id}/secret`, {})).json().secret;
    expect(rotated).not.toBe(ep.secret);
  });
});

describe("deliveries", () => {
  let session: string;
  beforeAll(async () => {
    session = await openSession(ctx);
  });

  it("sends a signed order.created when a till's sale arrives", async () => {
    const ep = await addEndpoint(["order.created"]);
    const order = makeOrder(ctx, session, [{ variant: 0, qty: 1 }]);
    await postOrders(ctx, [order]);
    expect(await deliverDue(ctx.db, OPTS)).toBe(1);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    const event = JSON.parse(body);
    expect(event).toMatchObject({ type: "order.created", data: { id: order.id, number: order.number, type: "sale" } });
    expect(event.data.lines).toHaveLength(1);
    expect(headers["pos-event-type"]).toBe("order.created");
    expect(headers["pos-event-id"]).toBe(event.id);
    const [t, v1] = String(headers["pos-signature"]).split(",").map((p) => p.split("=")[1]!);
    expect(createHmac("sha256", ep.secret).update(`${t}.${body}`).digest("hex")).toBe(v1);
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(30);
    // A till resending the same order (offline retry) does not send it twice.
    await postOrders(ctx, [order]);
    expect(await deliverDue(ctx.db, OPTS)).toBe(0);
    const log = await admin("GET", `/webhooks/${ep.id}/deliveries`);
    expect(log.json().deliveries[0]).toMatchObject({ type: "order.created", status: "succeeded", attempts: 1, responseStatus: 200 });
  });

  it("sends only the events an endpoint asked for", async () => {
    await addEndpoint(["customer.created"]);
    await postOrders(ctx, [makeOrder(ctx, session, [{ variant: 0, qty: 1 }])]);
    await ctx.app.inject({ method: "POST", url: "/customers", headers: ctx.auth, payload: { id: randomUUID(), name: "Till customer" } });
    await deliverDue(ctx.db, OPTS);
    expect(received.map((r) => JSON.parse(r.body).type)).toEqual(["customer.created"]);
    expect(JSON.parse(received[0]!.body).data).toMatchObject({ name: "Till customer", points: 0 });
  });

  it("sends product changes from the back office, and refunds", async () => {
    await addEndpoint(["product.updated", "order.refunded"]);
    const v = ctx.data.variants[1]!;
    const { rows } = await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [v.id]);
    const product = (await admin("GET", `/products/${rows[0].product_id}`)).json();
    await admin("PUT", `/products/${product.id}`, { ...product, price: product.price + 100 });
    const sale = makeOrder(ctx, session, [{ variant: 1, qty: 1 }]);
    await postOrders(ctx, [sale]);
    await postOrders(ctx, [makeOrder(ctx, session, [{ variant: 1, qty: -1 }], { refundOf: sale.id })]);
    await deliverDue(ctx.db, OPTS);
    const events = received.map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.type)).toEqual(["product.updated", "order.refunded"]);
    expect(events[0].data).toMatchObject({ id: product.id, price: product.price + 100 });
    expect(events[1].data).toMatchObject({ type: "refund", refundOfOrderId: sale.id });
  });

  it("sends stock.low once when a sale takes stock down to the reorder level", async () => {
    await addEndpoint(["stock.low"]);
    const v = ctx.data.variants[2]!;
    const onHand = await ctx.db.query("SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves WHERE variant_id = $1 AND store_id = $2", [v.id, ctx.data.storeId]);
    await ctx.db.query("UPDATE variants SET reorder_level = $2 WHERE id = $1", [v.id, onHand.rows[0].n - 2]);
    await postOrders(ctx, [makeOrder(ctx, session, [{ variant: 2, qty: 1 }])]);
    await postOrders(ctx, [makeOrder(ctx, session, [{ variant: 2, qty: 1 }])]);
    await postOrders(ctx, [makeOrder(ctx, session, [{ variant: 2, qty: 1 }])]);
    await deliverDue(ctx.db, OPTS);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body).data).toMatchObject({ variantId: v.id, storeId: ctx.data.storeId, onHand: onHand.rows[0].n - 2 });
  });

  it("sends session.closed with the cash count", async () => {
    await addEndpoint(["session.closed"]);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${session}/close`,
      headers: ctx.auth,
      payload: { closedBy: ctx.data.cashierId, closedAt: new Date().toISOString(), closingCashCounted: 49_500 },
    });
    expect(res.statusCode).toBe(200);
    await deliverDue(ctx.db, OPTS);
    expect(JSON.parse(received[0]!.body).data).toMatchObject({ sessionId: session, openingCash: 50_000, closingCashCounted: 49_500, difference: -500 });
  });

  it("tries again with growing waits, then gives up", async () => {
    const ep = await addEndpoint(["customer.created"]);
    answer = 500;
    await admin("POST", "/customers", { name: "Retry me" });
    await deliverDue(ctx.db, OPTS);
    const d = (await ctx.db.query("SELECT * FROM webhook_deliveries WHERE endpoint_id = $1", [ep.id])).rows[0];
    expect(d).toMatchObject({ status: "pending", attempts: 1, response_status: 500 });
    const wait = (d.next_attempt_at.getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(50);
    expect(wait).toBeLessThan(70);
    // Not due yet.
    expect(await deliverDue(ctx.db, OPTS)).toBe(0);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await ctx.db.query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1", [d.id]);
      await deliverDue(ctx.db, OPTS);
    }
    const last = (await ctx.db.query("SELECT * FROM webhook_deliveries WHERE id = $1", [d.id])).rows[0];
    expect(last).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, next_attempt_at: null });
    expect(received).toHaveLength(MAX_ATTEMPTS);
    const detail = (await admin("GET", `/webhook-deliveries/${d.id}`)).json();
    expect(detail.attemptLog).toHaveLength(MAX_ATTEMPTS);
    expect(detail.attemptLog[0]).toMatchObject({ responseStatus: 500, responseBody: "nope" });
    expect(detail.body).toMatchObject({ type: "customer.created", data: { name: "Retry me" } });
    // The owner fixes the receiver and sends it again by hand.
    answer = 204;
    const again = await admin("POST", `/webhook-deliveries/${d.id}/retry`, {});
    expect(again.json()).toMatchObject({ status: "succeeded", responseStatus: 204 });
  });

  it("turns off an endpoint that keeps failing for days", async () => {
    const ep = await addEndpoint(["customer.created"]);
    answer = 503;
    await ctx.db.query("UPDATE webhook_endpoints SET failing_since = now() - interval '73 hours' WHERE id = $1", [ep.id]);
    await admin("POST", "/customers", { name: "Nobody home" });
    await deliverDue(ctx.db, OPTS);
    const w = (await admin("GET", `/webhooks/${ep.id}`)).json();
    expect(w.active).toBe(false);
    expect(w.disabledReason).toMatch(/failing/);
    // Nothing more is queued for it while it is off.
    await admin("POST", "/customers", { name: "Still nobody" });
    expect((await ctx.db.query("SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1", [ep.id])).rows[0].n).toBe(1);
    // Turning it back on clears the reason.
    const put = await admin("PUT", `/webhooks/${ep.id}`, { url: `${url}/hook`, events: ["customer.created"], active: true });
    expect(put.statusCode).toBe(200);
    expect((await admin("GET", `/webhooks/${ep.id}`)).json()).toMatchObject({ active: true, disabledReason: null, failingSince: null });
  });

  it("sends a test event on request and shows the answer", async () => {
    const ep = await addEndpoint(["order.created"]);
    const res = await admin("POST", `/webhooks/${ep.id}/test`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "succeeded", type: "ping", responseStatus: 200 });
    expect(JSON.parse(received[0]!.body).type).toBe("ping");
  });

  it("does not follow redirects", async () => {
    const r = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/");
      res.end();
    });
    await new Promise<void>((ok) => r.listen(0, "127.0.0.1", ok));
    const res = await postWebhook(`http://127.0.0.1:${(r.address() as AddressInfo).port}/`, "{}", {}, OPTS);
    r.close();
    expect(res.status).toBe(302);
  });

  it("signs with a timestamp a receiver can check", () => {
    expect(signPayload("whsec_x", "{}", 1700000000)).toBe(`t=1700000000,v1=${createHmac("sha256", "whsec_x").update("1700000000.{}").digest("hex")}`);
  });
});
