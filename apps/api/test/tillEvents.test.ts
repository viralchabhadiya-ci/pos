import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMailer } from "../src/reports/mailer.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
const mailer = new MemoryMailer();
let session: string;

const till = (method: "GET" | "POST", url: string, payload?: object) => ctx.app.inject({ method, url, headers: ctx.auth, payload });

beforeAll(async () => {
  process.env.PUBLIC_URL = "https://pos.example/";
  ctx = await setup({ mailer });
  session = await openSession(ctx);
});
afterAll(async () => {
  delete process.env.PUBLIC_URL;
  await teardown(ctx);
});

describe("till events", () => {
  it("writes a voided sale to the audit log once, with who approved it", async () => {
    const id = randomUUID();
    const event = {
      id,
      kind: "void",
      sessionId: session,
      userId: ctx.data.cashierId,
      approvedBy: ctx.data.managerId,
      summary: "Voided a sale of 3 items",
      amount: 4_250,
      details: { lines: 3 },
      at: new Date(Date.now() - 60_000).toISOString(),
    };
    expect((await till("POST", "/till-events", event)).statusCode).toBe(200);
    // The till sends it again after a dropped connection.
    expect((await till("POST", "/till-events", event)).statusCode).toBe(200);
    const { rows } = await ctx.db.query("SELECT * FROM audit_log WHERE entity = 'till_event' AND entity_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "till.void", user_id: ctx.data.cashierId });
    expect(rows[0].data).toMatchObject({ amount: 4_250, approvedBy: ctx.data.managerId, approvedByName: "Rahul (Manager)", details: { lines: 3 } });
    expect(new Date(rows[0].at).getTime()).toBe(Date.parse(event.at));
  });

  it("keeps an event from a staff member who is no longer known, and never dates one in the future", async () => {
    const id = randomUUID();
    const res = await till("POST", "/till-events", {
      id,
      kind: "no_sale",
      userId: randomUUID(),
      summary: "Opened the cash drawer with no sale",
      at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await ctx.db.query("SELECT user_id, at, action FROM audit_log WHERE entity_id = $1", [id]);
    expect(rows[0]).toMatchObject({ user_id: null, action: "till.no_sale" });
    expect(new Date(rows[0].at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("shows till events in the back office audit log", async () => {
    const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
    const res = await ctx.app.inject({ method: "GET", url: "/admin/audit?entity=till_event", headers: { authorization: `Bearer ${login.json().token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const entries = body.entries ?? body.rows ?? body.items ?? body;
    expect(JSON.stringify(entries)).toContain("till.void");
  });

  it("refuses an unknown kind", async () => {
    const res = await till("POST", "/till-events", { id: randomUUID(), kind: "steal", userId: ctx.data.cashierId, summary: "x", at: new Date().toISOString() });
    expect(res.statusCode).toBe(400);
  });
});

describe("emailing a receipt", () => {
  it("sends the link to the digital receipt, at most 3 times a bill", async () => {
    const order = makeOrder(ctx, session, [{ variant: 0, qty: 2 }]);
    await postOrders(ctx, [order]);
    const res = await till("POST", `/receipts/${order.id}/email`, { to: "Customer@Example.com", userId: ctx.data.cashierId });
    expect(res.statusCode).toBe(200);
    const mail = mailer.sent.at(-1)!;
    expect(mail.to).toEqual(["customer@example.com"]);
    expect(mail.subject).toMatch(/Your receipt from /);
    expect(mail.html).toContain(`https://pos.example/r/${order.id}`);
    expect(mail.text).toContain(order.number);
    const audit = await ctx.db.query("SELECT data FROM audit_log WHERE action = 'receipt.email' AND entity_id = $1", [order.id]);
    expect(audit.rows[0].data).toEqual({ domain: "example.com" });

    await till("POST", `/receipts/${order.id}/email`, { to: "a@example.com" });
    await till("POST", `/receipts/${order.id}/email`, { to: "b@example.com" });
    const fourth = await till("POST", `/receipts/${order.id}/email`, { to: "c@example.com" });
    expect(fourth.statusCode).toBe(429);
  });

  it("works before the bill has synced, and refuses a bad address", async () => {
    const early = await till("POST", `/receipts/${randomUUID()}/email`, { to: "x@example.com" });
    expect(early.statusCode).toBe(200);
    expect(mailer.sent.at(-1)!.text).toMatch(/^Your receipt/);
    const bad = await till("POST", `/receipts/${randomUUID()}/email`, { to: "not-an-email" });
    expect(bad.statusCode).toBe(400);
  });
});
