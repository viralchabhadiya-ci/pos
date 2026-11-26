import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMailer } from "../src/reports/mailer.js";
import { lastPeriod, periodFor, runDueSchedules } from "../src/reports/scheduled.js";
import { hashPassword } from "../src/security.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
const mailer = new MemoryMailer();

const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);
const FROM = ymd(new Date(Date.now() - 2 * 86_400_000));
const TO = ymd(new Date(Date.now() + 86_400_000));
const RANGE = `from=${FROM}&to=${TO}`;

async function ok(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers = owner) {
  const res = await ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

let sessionId: string;
beforeAll(async () => {
  ctx = await setup({ mailer });
  const login = (email: string, password: string) => ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  await ctx.db.query("UPDATE users SET email = 'rep-manager@demo.ae', password_hash = $2 WHERE id = $1", [ctx.data.managerId, hashPassword("manager123")]);
  manager = { authorization: `Bearer ${(await login("rep-manager@demo.ae", "manager123")).json().token}` };
  sessionId = await openSession(ctx);
});
afterAll(async () => teardown(ctx));

describe("margins", () => {
  it("uses the cost at the time of sale and leaves products without a cost out of the margin", async () => {
    const a = ctx.data.variants[0]!;
    const b = ctx.data.variants[1]!;
    await ctx.db.query("UPDATE variants SET cost = 100 WHERE id = $1", [a.id]);
    await ctx.db.query("UPDATE variants SET cost = NULL WHERE id = $1", [b.id]);
    const order = makeOrder(ctx, sessionId, [
      { variant: 0, qty: 3 },
      { variant: 1, qty: 1 },
    ]);
    expect((await postOrders(ctx, [order]))[0]!.status).toBe("created");
    // A later change to the average cost does not move the margin of what was already sold.
    await ctx.db.query("UPDATE variants SET cost = 999 WHERE id = $1", [a.id]);

    const r = await ok("GET", `/reports/sales?${RANGE}&groupBy=margin`);
    const rowA = r.rows.find((x: { id: string }) => x.id === a.id);
    const lineA = order.lines[0]!;
    const { rows: net } = await ctx.db.query("SELECT net FROM order_lines WHERE id = $1", [lineA.id]);
    expect(rowA.cost).toBe(300);
    expect(rowA.profit).toBe(net[0].net - 300);
    expect(rowA.marginBp).toBe(Math.round(((net[0].net - 300) * 10_000) / net[0].net));
    const rowB = r.rows.find((x: { id: string }) => x.id === b.id);
    expect(rowB.cost).toBeNull();
    expect(rowB.marginBp).toBeNull();

    const cat = await ok("GET", `/reports/sales?${RANGE}&groupBy=margin_category`);
    expect(cat.columns.map((c: { key: string }) => c.key)).toContain("marginBp");

    const csv = await ctx.app.inject({ method: "GET", url: `/admin/reports/sales?${RANGE}&groupBy=margin&format=csv`, headers: owner });
    expect(csv.body.split("\n")[0]).toContain("Margin %");
  });
});

describe("cashier performance", () => {
  it("counts bills, items, voids and shift hours per person", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/till-events",
      headers: ctx.auth,
      payload: { id: randomUUID(), kind: "void", userId: ctx.data.cashierId, sessionId, summary: "Voided Water", amount: 150, at: new Date().toISOString() },
    });
    const r = await ok("GET", `/reports/sales?${RANGE}&groupBy=staff`);
    const me = r.rows.find((x: { id: string }) => x.id === ctx.data.cashierId);
    expect(me.orders).toBe(1);
    expect(me.itemsPerBill).toBe(4);
    expect(me.voids).toBe(1);
    expect(me.avgBill).toBeGreaterThan(0);
    expect(me.hours).toBeGreaterThanOrEqual(0);
  });
});

describe("report periods", () => {
  it("daily is yesterday, weekly runs on Mondays, monthly on the 1st", () => {
    expect(periodFor("daily", "2026-11-26")).toEqual({ from: "2026-11-25", to: "2026-11-25" });
    expect(periodFor("weekly", "2026-11-26")).toBeNull();
    expect(periodFor("weekly", "2026-11-23")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(periodFor("monthly", "2026-11-26")).toBeNull();
    expect(periodFor("monthly", "2026-12-01")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(periodFor("monthly", "2027-01-01")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(lastPeriod("weekly", "2026-11-26")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(lastPeriod("monthly", "2026-11-26")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("scheduled reports", () => {
  let id: string;
  it("only the owner sets them up, and addresses are checked", async () => {
    const body = { name: "Daily margins", report: "margin", frequency: "daily", recipients: ["Acc@Example.com", "acc@example.com"], sendHour: 0 };
    const res = await ctx.app.inject({ method: "POST", url: "/admin/report-schedules", headers: manager, payload: body });
    expect(res.statusCode).toBe(403);
    const bad = await ctx.app.inject({ method: "POST", url: "/admin/report-schedules", headers: owner, payload: { ...body, recipients: ["nope"] } });
    expect(bad.statusCode).toBe(400);
    id = (await ok("POST", "/report-schedules", body)).id;
    const list = await ok("GET", "/report-schedules", undefined, manager);
    expect(list.schedules[0]).toMatchObject({ name: "Daily margins", recipients: ["acc@example.com"], title: "Margins by product" });
    expect(list.reports.length).toBe(9);
  });

  it("sends yesterday's report once, with the CSV attached", async () => {
    // Move the sale to yesterday so the daily report has something in it.
    await ctx.db.query("UPDATE orders SET created_at = created_at - interval '1 day'");
    mailer.sent = [];
    expect(await runDueSchedules(ctx.db, mailer)).toBe(1);
    expect(await runDueSchedules(ctx.db, mailer)).toBe(0);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toEqual(["acc@example.com"]);
    expect(mail.subject).toContain("Daily margins");
    expect(mail.attachments?.[0]?.filename).toMatch(/^sales-by-margin-\d{4}-\d{2}-\d{2}-to-/);
    expect(mail.attachments?.[0]?.content).toContain("Gross profit");
    expect(mail.html).toContain(ctx.data.variants[0]!.name);
    const list = await ok("GET", "/report-schedules");
    expect(list.schedules[0].lastRun.status).toBe("sent");
  });

  it("retries a failed send, and send now reports the error", async () => {
    const vat = (await ok("POST", "/report-schedules", { name: "VAT weekly", report: "vat", frequency: "weekly", recipients: ["tax@example.com"] })).id;
    mailer.failWith = "mail server down";
    const res = await ctx.app.inject({ method: "POST", url: `/admin/report-schedules/${vat}/send`, headers: owner });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("mail server down");
    mailer.failWith = null;
    mailer.sent = [];
    const sent = await ok("POST", `/report-schedules/${vat}/send`);
    expect(sent.period.from <= sent.period.to).toBe(true);
    expect(mailer.sent[0]!.attachments?.[0]?.content).toContain("VAT due");
  });

  it("can be paused, changed and deleted", async () => {
    await ok("PUT", `/report-schedules/${id}`, { name: "Margins", report: "margin_category", frequency: "monthly", recipients: ["a@b.ae"], active: false });
    const list = await ok("GET", "/report-schedules");
    expect(list.schedules.find((s: { id: string }) => s.id === id)).toMatchObject({ active: false, report: "margin_category", frequency: "monthly" });
    await ok("DELETE", `/report-schedules/${id}`);
    const gone = await ctx.app.inject({ method: "DELETE", url: `/admin/report-schedules/${id}`, headers: owner });
    expect(gone.statusCode).toBe(404);
  });
});
