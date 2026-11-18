import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMailer } from "../src/reports/mailer.js";
import { MAX_ATTEMPTS, runDueReports } from "../src/reports/deliver.js";
import { change, money } from "../src/reports/render.js";
import { hashPassword } from "../src/security.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
const mailer = new MemoryMailer();

async function login(email: string, password: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${res.json().token}` };
}

const admin = (method: "GET" | "POST" | "PUT", url: string, payload?: object, headers = owner) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
const till = (method: "GET" | "POST", url: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: ctx.auth, payload });

function ask(extra: Record<string, unknown> = {}) {
  return till("POST", "/approvals", {
    id: randomUUID(),
    kind: "refund",
    amount: 45_000,
    summary: "Refund AED 450.00 on bill DXB1-R1-0001-0042",
    reason: "Customer returned a damaged item",
    requestedBy: ctx.data.cashierId,
    ...extra,
  });
}

/** The business's yesterday, the day the daily summary covers. */
async function yesterday() {
  const { rows } = await ctx.db.query("SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date - 1, 'YYYY-MM-DD') AS d");
  return rows[0].d as string;
}

beforeAll(async () => {
  ctx = await setup({ mailer });
  owner = await login(ctx.data.ownerEmail, ctx.data.ownerPassword);
  await ctx.db.query("UPDATE users SET email = 'rahul@demo.ae', password_hash = $2 WHERE id = $1", [
    ctx.data.managerId,
    hashPassword("manager123"),
  ]);
  manager = await login("rahul@demo.ae", "manager123");
});
afterAll(async () => teardown(ctx));

describe("remote approvals", () => {
  it("lets the till ask and the owner approve, once", async () => {
    const res = await ask();
    expect(res.statusCode).toBe(200);
    const id = res.json().id;
    expect(res.json()).toMatchObject({ status: "pending", kind: "refund", amount: 45_000 });

    // Asking again with the same id is the same request.
    const again = await till("POST", "/approvals", {
      id,
      kind: "refund",
      amount: 45_000,
      summary: "Refund AED 450.00 on bill DXB1-R1-0001-0042",
    });
    expect(again.json().id).toBe(id);
    const pending = (await admin("GET", "/approvals")).json().approvals;
    expect(pending.filter((a: { id: string }) => a.id === id)).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestedBy: "Aisha (Cashier)", registerName: expect.any(String) });

    const ok = await admin("POST", `/approvals/${id}/decide`, { decision: "approve", note: "OK, receipt checked" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "approved", decidedBy: "Omar (Owner)", note: "OK, receipt checked" });

    const seen = (await till("GET", `/approvals/${id}`)).json();
    expect(seen).toMatchObject({ status: "approved", decidedBy: "Omar (Owner)", note: "OK, receipt checked" });

    const twice = await admin("POST", `/approvals/${id}/decide`, { decision: "deny" }, manager);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().message).toMatch(/already approved/);

    const audit = await ctx.db.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at", [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["approval.request", "approval.approved"]);
  });

  it("lets a manager deny, and the till cancel", async () => {
    const a = (await ask({ kind: "discount", summary: "30% off the whole bill" })).json();
    const denied = await admin("POST", `/approvals/${a.id}/decide`, { decision: "deny", note: "Too much" }, manager);
    expect(denied.json()).toMatchObject({ status: "denied", decidedBy: "Rahul (Manager)" });

    const b = (await ask()).json();
    expect((await till("POST", `/approvals/${b.id}/cancel`)).json().status).toBe("cancelled");
    const late = await admin("POST", `/approvals/${b.id}/decide`, { decision: "approve" });
    expect(late.statusCode).toBe(409);
    expect(late.json().message).toMatch(/cancelled/);
  });

  it("expires a request nobody answered in time", async () => {
    const a = (await ask()).json();
    await ctx.db.query("UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [a.id]);
    const res = await admin("POST", `/approvals/${a.id}/decide`, { decision: "approve" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/ran out of time/);
    expect((await till("GET", `/approvals/${a.id}`)).json().status).toBe("expired");
    const decided = (await admin("GET", "/approvals?status=decided")).json().approvals;
    expect(decided.map((r: { status: string }) => r.status)).toEqual(expect.arrayContaining(["approved", "denied", "cancelled", "expired"]));
  });

  it("checks input and who is asking", async () => {
    expect((await ask({ kind: "steal" })).statusCode).toBe(400);
    expect((await ask({ requestedBy: randomUUID() })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/approvals", payload: {} })).statusCode).toBe(401);
    // A back office token is not a till token, and the other way round.
    expect((await ctx.app.inject({ method: "GET", url: `/approvals/${randomUUID()}`, headers: owner })).statusCode).toBe(401);
    expect((await till("GET", `/approvals/${randomUUID()}`)).statusCode).toBe(404);
    expect((await admin("POST", `/approvals/${randomUUID()}/decide`, { decision: "approve" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/approvals", headers: ctx.auth })).statusCode).toBe(401);
  });
});

describe("live sales and alerts", () => {
  it("shows today's sales, open shifts and what waits for the owner", async () => {
    const before = (await admin("GET", "/live")).json();
    const session = await openSession(ctx, 1);
    await postOrders(ctx, [makeOrder(ctx, session, [{ variant: 0, qty: 2 }]), makeOrder(ctx, session, [{ variant: 4, qty: 1 }], { pay: "cash" })]);
    await ask();
    const live = (await admin("GET", "/live")).json();
    expect(live.today.orderCount).toBe(before.today.orderCount + 2);
    expect(live.today.total).toBe(before.today.total + 300 + 650);
    expect(live.stores).toHaveLength(1);
    expect(live.openShifts).toHaveLength(1);
    expect(live.openShifts[0]).toMatchObject({ cashier: "Aisha (Cashier)", orderCount: 2, total: 950 });
    expect(live.pendingApprovals).toBe(1);
    expect(live.latestOrders[0]).toMatchObject({ cashier: "Aisha (Cashier)", storeName: "Demo Minimart Al Barsha" });

    const other = await admin("GET", `/live?storeId=${randomUUID()}`);
    expect(other.json().today).toEqual({ total: 0, orderCount: 0 });
  });

  it("lists what needs attention, most urgent first", async () => {
    // A till with an open shift that went quiet, a low product and a short drawer.
    await ctx.db.query("UPDATE devices SET last_seen_at = now() - interval '1 hour'");
    await ctx.db.query("UPDATE variants SET reorder_level = 1000 WHERE id = $1", [ctx.data.variants[1]!.id]);
    const closed = randomUUID();
    await ctx.db.query(
      `INSERT INTO sessions (id, register_id, seq, state, opened_by, opened_at, opening_cash, closed_by, closed_at,
                             closing_cash_counted, expected_cash)
       VALUES ($1, $2, 99, 'closed', $3, now() - interval '9 hours', 50000, $3, now() - interval '1 hour', 47500, 50000)`,
      [closed, ctx.data.registerId, ctx.data.cashierId],
    );
    const res = (await admin("GET", "/alerts")).json();
    const kinds = res.alerts.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(["approvals_pending", "cash_variance", "till_offline", "low_stock"]);
    const cash = res.alerts.find((a: { kind: string }) => a.kind === "cash_variance");
    expect(cash.items[0]).toMatchObject({ label: expect.stringContaining("short by AED 25.00"), amount: -2500 });
    // The badge counts urgent and medium things, not low stock.
    expect(res.count).toBe(1 + 1 + 1);
  });
});

describe("daily summary email", () => {
  it("sends to owners by default, and to managers and extra people who opt in", async () => {
    let s = (await admin("GET", "/report-settings")).json();
    expect(s.settings).toEqual({ dailyEnabled: true, sendHour: 8, extraEmails: [] });
    expect(s.recipients).toEqual([ctx.data.ownerEmail]);
    expect(s.me).toEqual({ email: ctx.data.ownerEmail, daily: true });
    expect(s.canEdit).toBe(true);
    expect(s.transport).toBe("memory");

    expect((await admin("GET", "/report-settings", undefined, manager)).json().me.daily).toBe(false);
    expect((await admin("PUT", "/report-settings/me", { daily: true }, manager)).json().recipients).toContain("rahul@demo.ae");

    const forbidden = await admin("PUT", "/report-settings", { dailyEnabled: true, sendHour: 7, extraEmails: [] }, manager);
    expect(forbidden.statusCode).toBe(403);
    expect((await admin("PUT", "/report-settings", { dailyEnabled: true, sendHour: 7, extraEmails: ["nope"] })).statusCode).toBe(400);
    const saved = await admin("PUT", "/report-settings", {
      dailyEnabled: true,
      sendHour: 7,
      extraEmails: ["Accounts@Demo.ae", "accounts@demo.ae"],
    });
    expect(saved.json().settings).toEqual({ dailyEnabled: true, sendHour: 7, extraEmails: ["accounts@demo.ae"] });
    s = (await admin("GET", "/report-settings")).json();
    expect(s.recipients).toEqual(["accounts@demo.ae", ctx.data.ownerEmail, "rahul@demo.ae"].sort());
  });

  it("sums yesterday by each store's own day and compares with last week", async () => {
    const day = await yesterday();
    const session = await openSession(ctx, 2);
    // 23:30 Dubai yesterday is still yesterday there, though it is 19:30 UTC.
    const late = makeOrder(ctx, session, [{ variant: 6, qty: 2 }]);
    late.createdAt = new Date(`${day}T19:30:00Z`).toISOString();
    const early = makeOrder(ctx, session, [{ variant: 2, qty: 4 }], { pay: "cash" });
    early.createdAt = new Date(`${day}T05:15:00Z`).toISOString();
    const lastWeek = makeOrder(ctx, session, [{ variant: 6, qty: 1 }]);
    lastWeek.createdAt = new Date(Date.parse(`${day}T08:00:00Z`) - 7 * 86_400_000).toISOString();
    await postOrders(ctx, [late, early, lastWeek]);

    const res = await admin("GET", `/reports/daily-summary?date=${day}`);
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.date).toBe(day);
    expect(s.totals).toMatchObject({ total: 2900 + 1000, orderCount: 2, averageBasket: 1950 });
    expect(s.previous.total).toBe(1450);
    expect(s.topProducts[0]).toMatchObject({ name: "Puck Cream Cheese 240g", qty: 2, total: 2900 });
    expect(s.busiestHour).toMatchObject({ hour: 23, orderCount: 1 });
    expect(s.payments.map((p: { kind: string }) => p.kind).sort()).toEqual(["card", "cash"]);
    // Default date is yesterday.
    expect((await admin("GET", "/reports/daily-summary")).json().date).toBe(day);
  });

  it("previews the email as HTML that cannot run scripts", async () => {
    await ctx.db.query("UPDATE tenants SET name = 'Demo <script>alert(1)</script> LLC'");
    const res = await admin("GET", `/reports/daily-summary?date=${await yesterday()}&format=html`);
    await ctx.db.query("UPDATE tenants SET name = 'Demo Minimart LLC'");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("&lt;script&gt;");
    expect(res.body).toContain("39.00");
  });

  it("emails a day's summary on request", async () => {
    mailer.sent = [];
    const res = await admin("POST", "/reports/daily-summary/send", { to: "me" }, manager);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "sent", to: ["rahul@demo.ae"] });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toMatch(/^Demo Minimart LLC: AED 39\.00 sales on /);
    expect(mailer.sent[0]!.text).toContain("Net sales: AED 39.00 (+169% vs last week)");
    expect((await admin("POST", "/reports/daily-summary/send", { to: "recipients" }, manager)).statusCode).toBe(403);

    mailer.failWith = "SMTP said no";
    const failed = await admin("POST", "/reports/daily-summary/send", { to: "recipients" });
    mailer.failWith = null;
    expect(failed.statusCode).toBe(502);
    expect(failed.json().message).toContain("SMTP said no");
  });

  it("sends yesterday's summary once a day at the chosen hour, with retries", async () => {
    await ctx.db.query("DELETE FROM report_deliveries");
    mailer.sent = [];
    // A business that signed up today is not sent anything yet.
    await admin("PUT", "/report-settings", { dailyEnabled: true, sendHour: 0, extraEmails: [] });
    expect(await runDueReports(ctx.db, mailer)).toBe(0);
    expect((await ctx.db.query("SELECT 1 FROM report_deliveries")).rowCount).toBe(0);

    await ctx.db.query("UPDATE tenants SET created_at = now() - interval '30 days'");
    // Too early in the day: nothing is queued.
    await admin("PUT", "/report-settings", { dailyEnabled: true, sendHour: 23, extraEmails: [] });
    const { rows: hour } = await ctx.db.query("SELECT EXTRACT(HOUR FROM now() AT TIME ZONE 'Asia/Dubai')::int AS h");
    if (hour[0].h < 23) expect(await runDueReports(ctx.db, mailer)).toBe(0);
    await ctx.db.query("DELETE FROM report_deliveries");

    await admin("PUT", "/report-settings", { dailyEnabled: true, sendHour: 0, extraEmails: [] });
    mailer.failWith = "Connection refused";
    expect(await runDueReports(ctx.db, mailer)).toBe(0);
    let d = (await ctx.db.query("SELECT * FROM report_deliveries")).rows;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "Connection refused" });
    // The alert only shows once it has given up.
    expect((await admin("GET", "/alerts")).json().alerts.map((a: { kind: string }) => a.kind)).not.toContain("report_failed");

    mailer.failWith = null;
    await ctx.db.query("UPDATE report_deliveries SET next_attempt_at = now()");
    expect(await runDueReports(ctx.db, mailer)).toBe(1);
    expect(await runDueReports(ctx.db, mailer)).toBe(0);
    d = (await ctx.db.query("SELECT * FROM report_deliveries")).rows;
    expect(d[0]).toMatchObject({ status: "sent", attempts: 2, transport: "memory", last_error: null });
    expect(d[0].recipients).toEqual([ctx.data.ownerEmail, "rahul@demo.ae"].sort());
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toEqual(d[0].recipients);

    // Giving up after the last try shows up in the owner's alerts.
    await ctx.db.query("UPDATE report_deliveries SET status = 'pending', attempts = $1, next_attempt_at = now()", [MAX_ATTEMPTS - 1]);
    mailer.failWith = "Mailbox full";
    await runDueReports(ctx.db, mailer);
    mailer.failWith = null;
    expect((await ctx.db.query("SELECT status FROM report_deliveries")).rows[0].status).toBe("failed");
    const alerts = (await admin("GET", "/alerts")).json().alerts;
    expect(alerts.find((a: { kind: string }) => a.kind === "report_failed").items[0].detail).toBe("Mailbox full");
    const history = (await admin("GET", "/report-settings")).json().deliveries;
    expect(history[0]).toMatchObject({ kind: "daily", status: "failed", error: "Mailbox full" });
  });

  it("skips a day when nobody is set to get it, and sends nothing when turned off", async () => {
    await ctx.db.query("DELETE FROM report_deliveries");
    await admin("PUT", "/report-settings/me", { daily: false });
    await admin("PUT", "/report-settings/me", { daily: false }, manager);
    expect(await runDueReports(ctx.db, mailer)).toBe(0);
    expect((await ctx.db.query("SELECT status FROM report_deliveries")).rows[0].status).toBe("skipped");

    await ctx.db.query("DELETE FROM report_deliveries");
    await admin("PUT", "/report-settings/me", { daily: true });
    await admin("PUT", "/report-settings", { dailyEnabled: false, sendHour: 0, extraEmails: [] });
    expect(await runDueReports(ctx.db, mailer)).toBe(0);
    expect((await ctx.db.query("SELECT 1 FROM report_deliveries")).rowCount).toBe(0);
  });
});

describe("email formatting", () => {
  it("formats money and changes", () => {
    expect(money(123456)).toBe("1,234.56");
    expect(money(-2500)).toBe("-25.00");
    expect(money(5)).toBe("0.05");
    expect(change(150, 100)).toBe("+50%");
    expect(change(50, 100)).toBe("-50%");
    expect(change(100, 0)).toBeNull();
  });
});
