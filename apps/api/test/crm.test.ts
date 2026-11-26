import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderMessage, runCampaigns, withOptOut } from "../src/crm/campaigns.js";
import { normalizePhone } from "../src/crm/segments.js";
import { MemorySender } from "../src/crm/senders.js";
import { hashPassword } from "../src/security.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
let sessionId: string;
const senders = { email: new MemorySender(), sms: new MemorySender(), whatsapp: new MemorySender() };
const PUBLIC = "https://pos.example.ae";
// Tomorrow 12:00 in Dubai: inside the sending hours, and after anything started "now".
const NOON = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(8, 0, 0, 0);
  return d;
};
const NIGHT = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(19, 30, 0, 0); // 23:30 in Dubai
  return d;
};
const run = (now = NOON()) => runCampaigns(ctx.db, senders, { publicUrl: PUBLIC, now });

const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers = owner) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers, payload: payload as object });

async function customer(body: Record<string, unknown>) {
  const res = await api("POST", "/customers", body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

async function buy(customerId: string, qty: number) {
  const order = makeOrder(ctx, sessionId, [{ variant: 4, qty }]);
  order.customerId = customerId;
  expect((await postOrders(ctx, [order]))[0]!.status).toBe("created");
  return order;
}

beforeAll(async () => {
  ctx = await setup({ senders });
  const login = (email: string, password: string) => ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  await ctx.db.query("UPDATE users SET email = 'crm-manager@demo.ae', password_hash = $2 WHERE id = $1", [ctx.data.managerId, hashPassword("manager123")]);
  manager = { authorization: `Bearer ${(await login("crm-manager@demo.ae", "manager123")).json().token}` };
  sessionId = await openSession(ctx);
  process.env.PUBLIC_URL = PUBLIC;
});
afterAll(async () => {
  delete process.env.PUBLIC_URL;
  await teardown(ctx);
});

describe("CRM helpers", () => {
  it("writes UAE mobiles in international form and refuses landlines", () => {
    expect(normalizePhone("050 123 4567")).toBe("+971501234567");
    expect(normalizePhone("00971 55 765 4321")).toBe("+971557654321");
    expect(normalizePhone("971521112222")).toBe("+971521112222");
    expect(normalizePhone("+971 4 123 4567")).toBeNull();
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("12")).toBeNull();
  });

  it("fills placeholders with the first name and keeps unknown ones visible", () => {
    const text = renderMessage("Hi {name}, {points} points! Code {coupon} at {shop}. {oops}", { name: "Fatima Al Mansoori", points: 120 }, { coupon: "EID20", shop: "Demo" });
    expect(text).toBe("Hi Fatima, 120 points! Code EID20 at Demo. {oops}");
    expect(withOptOut("sms", "Hello", "https://x/u/abc")).toBe("Hello\nStop: https://x/u/abc");
    expect(withOptOut("email", "Hello", "https://x/u/abc")).toBe("Hello");
  });
});

describe("customers", () => {
  it("saves birthday, tags and consent per channel, and refuses a date that does not exist", async () => {
    const id = await customer({ name: "Aisha Khan", phone: "0551110001", email: "aisha@example.ae", birthMonth: 3, birthDay: 14, tags: ["VIP", "dubai"], consent: { email: true, sms: true, whatsapp: false } });
    const got = (await api("GET", `/customers/${id}`)).json();
    expect(got).toMatchObject({ birthMonth: 3, birthDay: 14, tags: ["vip", "dubai"], consent: { email: true, sms: true, whatsapp: false }, consentSource: "back_office" });
    expect(got.consentAt).toBeTruthy();

    const bad = await api("POST", "/customers", { name: "Nope", birthMonth: 2, birthDay: 30 });
    expect(bad.statusCode).toBe(400);
    // A save without consent keeps what was there.
    await api("PUT", `/customers/${id}`, { name: "Aisha Khan", phone: "0551110001", email: "aisha@example.ae" });
    expect((await api("GET", `/customers/${id}`)).json()).toMatchObject({ birthMonth: 3, tags: ["vip", "dubai"], consent: { email: true, sms: true } });
  });

  it("records the yes a cashier asked for at the till", async () => {
    const id = randomUUID();
    const res = await ctx.app.inject({ method: "POST", url: "/customers", headers: ctx.auth, payload: { id, name: "Till Customer", phone: "0559990000", marketingConsent: true } });
    expect(res.statusCode).toBe(200);
    const { rows } = await ctx.db.query("SELECT consent_email, consent_sms, consent_whatsapp, consent_source FROM customers WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ consent_email: false, consent_sms: true, consent_whatsapp: true, consent_source: "till" });
    const plain = randomUUID();
    await ctx.app.inject({ method: "POST", url: "/customers", headers: ctx.auth, payload: { id: plain, name: "No Thanks" } });
    expect((await ctx.db.query("SELECT consent_sms, consent_source FROM customers WHERE id = $1", [plain])).rows[0]).toEqual({ consent_sms: false, consent_source: null });
  });
});

describe("segments and campaigns", () => {
  let big: string;
  let small: string;
  let noConsent: string;
  let landline: string;
  let segmentId: string;
  let campaignId: string;

  beforeAll(async () => {
    big = await customer({ name: "Big Spender", phone: "0501000001", tags: ["vip"], consent: { email: false, sms: true, whatsapp: true } });
    small = await customer({ name: "Small Spender", phone: "0501000002", consent: { email: false, sms: true, whatsapp: false } });
    noConsent = await customer({ name: "Quiet Buyer", phone: "0501000003" });
    landline = await customer({ name: "Office Line", phone: "04 333 4444", consent: { email: false, sms: true, whatsapp: false } });
    await buy(big, 20);
    await buy(small, 1);
    await buy(noConsent, 20);
    await buy(landline, 20);
  });

  it("counts who a segment reaches on each channel before it is saved", async () => {
    const preview = (await api("POST", "/segments/preview", { rules: { minSpent: 5000 } })).json();
    // The landline counts as reachable by SMS here; the send skips it.
    expect(preview).toMatchObject({ total: 3, sms: 2, whatsapp: 1, email: 0 });
    const vip = (await api("POST", "/segments/preview", { rules: { tagsAny: ["VIP"] } })).json();
    expect(vip.total).toBe(2);
    expect((await api("POST", "/segments/preview", { rules: { favouriteColour: "red" } })).statusCode).toBe(400);
    const res = await api("POST", "/segments", { name: "Big baskets", rules: { minSpent: 5000, lastVisitWithinDays: 30 } });
    segmentId = res.json().id;
    expect((await api("POST", "/segments", { name: "big baskets", rules: {} })).statusCode).toBe(409);
    const list = (await api("GET", "/segments")).json();
    expect(list.segments[0]).toMatchObject({ name: "Big baskets", audience: { total: 3 } });
  });

  it("checks the message before saving a campaign", async () => {
    const base = { name: "Weekend offer", channel: "sms", segmentId, message: "Hi {name}, 20% off this weekend with {coupon} at {shop}" };
    expect((await api("POST", "/campaigns", base)).json().message).toMatch(/coupon/);
    expect((await api("POST", "/campaigns", { ...base, couponCode: "NOPE" })).json().message).toMatch(/No active coupon/);
    await api("POST", "/promotions", { name: "Weekend 20", kind: "order_percent_off", percentBp: 2000, code: "WKND20" });
    expect((await api("POST", "/campaigns", { ...base, channel: "email" , couponCode: "wknd20" })).json().message).toMatch(/subject/);
    const res = await api("POST", "/campaigns", { ...base, couponCode: "wknd20" });
    expect(res.statusCode, res.body).toBe(200);
    campaignId = res.json().id;
    const preview = (await api("POST", `/campaigns/${campaignId}/preview`)).json();
    expect(preview.text).toContain("20% off this weekend with WKND20 at");
    expect(preview.text).toContain(`Stop: ${PUBLIC}/u/`);
    expect(preview).toMatchObject({ reach: 2, smsParts: 1 });
  });

  it("sends a test to the owner's number without touching customers", async () => {
    const res = await api("POST", `/campaigns/${campaignId}/test`, { to: "050 777 8888" });
    expect(res.json()).toMatchObject({ ok: true, to: "+971507778888", transport: "memory" });
    expect(senders.sms.sent.at(-1)!.text).toContain("WKND20");
    expect((await ctx.db.query("SELECT COUNT(*)::int AS n FROM campaign_messages")).rows[0].n).toBe(0);
  });

  it("lets only the owner start, and needs the unsubscribe address", async () => {
    expect((await api("POST", `/campaigns/${campaignId}/start`, {}, manager)).statusCode).toBe(403);
    delete process.env.PUBLIC_URL;
    expect((await api("POST", `/campaigns/${campaignId}/start`, {})).json().error).toBe("no_public_url");
    process.env.PUBLIC_URL = PUBLIC;
    expect((await api("POST", `/campaigns/${campaignId}/start`, {})).json().status).toBe("scheduled");
  });

  it("waits for the sending hours, then messages only customers who said yes", async () => {
    senders.sms.sent = [];
    expect(await run(NIGHT())).toBe(0);
    expect((await ctx.db.query("SELECT status FROM campaigns WHERE id = $1", [campaignId])).rows[0].status).toBe("scheduled");

    expect(await run()).toBe(1);
    expect(senders.sms.sent.map((m) => m.to)).toEqual(["+971501000001"]);
    const msg = senders.sms.sent[0]!;
    expect(msg.text).toMatch(/^Hi Big, 20% off this weekend with WKND20 at .+\nStop: https:\/\/pos\.example\.ae\/u\/[\w-]+$/);
    const { rows } = await ctx.db.query("SELECT customer_id, status, error FROM campaign_messages WHERE campaign_id = $1 ORDER BY status", [campaignId]);
    expect(rows).toEqual([
      { customer_id: big, status: "sent", error: null },
      { customer_id: landline, status: "skipped", error: "Not a mobile number" },
    ]);
    expect(rows.some((r) => r.customer_id === small || r.customer_id === noConsent)).toBe(false);
    expect((await api("GET", `/campaigns/${campaignId}`)).json()).toMatchObject({ status: "sent", counts: { sent: 1, skipped: 1, queued: 0 } });
    // Nothing goes twice.
    expect(await run()).toBe(0);
    expect((await api("PUT", `/campaigns/${campaignId}`, { name: "x", channel: "sms", message: "y" })).statusCode).toBe(409);
  });

  it("counts sales by customers in the week after their message", async () => {
    // Earlier bills move back an hour, so only the one bought after the message counts.
    await ctx.db.query("UPDATE orders SET created_at = created_at - interval '1 hour'");
    await ctx.db.query("UPDATE campaign_messages SET sent_at = now() - interval '1 minute' WHERE campaign_id = $1", [campaignId]);
    const order = await buy(big, 2);
    const detail = (await api("GET", `/campaigns/${campaignId}`)).json();
    expect(detail.results).toEqual({ buyers: 1, orders: 1, sales: order.clientTotals.total });
    expect(detail.messages).toHaveLength(2);
  });

  it("retries a failed send, then gives up after three tries", async () => {
    const id = (await api("POST", "/campaigns", { name: "VIP WhatsApp", channel: "whatsapp", segmentId, message: "Hello {name}" })).json().id;
    await api("POST", `/campaigns/${id}/start`, {});
    senders.whatsapp.failFor.add("+971501000001");
    for (let i = 0; i < 3; i++) await run();
    const { rows } = await ctx.db.query("SELECT status, attempts, error FROM campaign_messages WHERE campaign_id = $1", [id]);
    expect(rows).toEqual([{ status: "failed", attempts: 3, error: "provider refused" }]);
    expect((await ctx.db.query("SELECT status FROM campaigns WHERE id = $1", [id])).rows[0].status).toBe("sent");
    senders.whatsapp.failFor.clear();
  });

  it("skips a queued message when the customer takes consent back, and can be paused or cancelled", async () => {
    const id = (await api("POST", "/campaigns", { name: "Later", channel: "sms", segmentId, message: "Later {name}" })).json().id;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await api("POST", `/campaigns/${id}/start`, { at: future })).json().status).toBe("scheduled");
    expect((await api("POST", `/campaigns/${id}/pause`)).json().status).toBe("draft");
    await api("POST", `/campaigns/${id}/start`, {});
    // Queue it at night, so nothing is sent yet.
    await ctx.db.query("UPDATE campaigns SET status = 'sending' WHERE id = $1", [id]);
    await ctx.db.query(
      `INSERT INTO campaign_messages (id, campaign_id, tenant_id, customer_id, channel, to_address, token)
       VALUES (gen_random_uuid(), $1, $2, $3, 'sms', '+971501000001', 'tok_withdrawn_000001')`,
      [id, ctx.data.tenantId, big],
    );
    await api("PUT", `/customers/${big}`, { name: "Big Spender", phone: "0501000001", consent: { email: false, sms: false, whatsapp: true } });
    senders.sms.sent = [];
    await run();
    expect(senders.sms.sent).toHaveLength(0);
    expect((await ctx.db.query("SELECT status, error FROM campaign_messages WHERE campaign_id = $1", [id])).rows[0]).toEqual({
      status: "skipped",
      error: "Customer withdrew consent",
    });
    expect((await api("POST", `/campaigns/${id}/cancel`)).statusCode).toBe(409);
    await api("PUT", `/customers/${big}`, { name: "Big Spender", phone: "0501000001", consent: { email: false, sms: true, whatsapp: true } });
  });

  it("leaves campaigns to head office when a manager runs only some stores", async () => {
    await ctx.db.query("INSERT INTO user_stores (user_id, store_id, tenant_id) VALUES ($1, $2, $3)", [ctx.data.managerId, ctx.data.storeId, ctx.data.tenantId]);
    expect((await api("GET", "/campaigns", undefined, manager)).statusCode).toBe(200);
    expect((await api("POST", "/campaigns", { name: "Mine", channel: "sms", message: "Hi" }, manager)).statusCode).toBe(403);
    expect((await api("POST", "/segments", { name: "Mine", rules: {} }, manager)).statusCode).toBe(403);
    await ctx.db.query("DELETE FROM user_stores WHERE user_id = $1", [ctx.data.managerId]);
  });

  it("keeps a segment that an unfinished campaign uses", async () => {
    const id = (await api("POST", "/campaigns", { name: "Draft", channel: "sms", segmentId, message: "Hi" })).json().id;
    expect((await api("DELETE", `/segments/${segmentId}`)).statusCode).toBe(409);
    expect((await api("POST", `/campaigns/${id}/cancel`)).json().status).toBe("cancelled");
    expect((await api("DELETE", `/segments/${segmentId}`)).statusCode).toBe(200);
  });
});

describe("birthday offers", () => {
  it("sends once on the day, from 10 in the morning, and once a year", async () => {
    const today = NOON();
    const dubai = new Date(today.getTime() + 4 * 3600_000);
    const id = await customer({ name: "Birthday Girl", phone: "0502000001", birthMonth: dubai.getUTCMonth() + 1, birthDay: dubai.getUTCDate(), consent: { email: false, sms: true, whatsapp: false } });
    await customer({ name: "Not Today", phone: "0502000002", birthMonth: ((dubai.getUTCMonth() + 1) % 12) + 1, birthDay: 1, consent: { email: false, sms: true, whatsapp: false } });
    const camp = (await api("POST", "/campaigns", { name: "Birthday", kind: "birthday", channel: "sms", message: "Happy birthday {name}!" })).json().id;
    expect((await api("POST", `/campaigns/${camp}/start`, {})).json().status).toBe("active");
    senders.sms.sent = [];
    const early = new Date(today);
    early.setUTCHours(5, 30); // 09:30 in Dubai
    await run(early);
    expect(senders.sms.sent).toHaveLength(0);
    await run();
    await run();
    expect(senders.sms.sent.map((m) => m.text.split("\n")[0])).toEqual(["Happy birthday Birthday!"]);
    const { rows } = await ctx.db.query("SELECT customer_id, period FROM campaign_messages WHERE campaign_id = $1", [camp]);
    expect(rows).toEqual([{ customer_id: id, period: String(dubai.getUTCFullYear()) }]);
    expect((await ctx.db.query("SELECT status FROM campaigns WHERE id = $1", [camp])).rows[0].status).toBe("active");
  });

  it("wishes a 29 February birthday on the 28th when the year has no 29th", async () => {
    const id = await customer({ name: "Leap Day", phone: "0502000003", birthMonth: 2, birthDay: 29, consent: { email: false, sms: true, whatsapp: false } });
    senders.sms.sent = [];
    await run(new Date("2027-02-28T08:00:00Z"));
    expect(senders.sms.sent.map((m) => m.to)).toContain("+971502000003");
    const { rows } = await ctx.db.query("SELECT period FROM campaign_messages WHERE customer_id = $1", [id]);
    expect(rows).toEqual([{ period: "2027" }]);
  });
});

describe("unsubscribe", () => {
  it("asks first, then stops only that channel when the button is pressed", async () => {
    const { rows } = await ctx.db.query(
      "SELECT m.token, m.customer_id FROM campaign_messages m WHERE m.channel = 'sms' AND m.status = 'sent' ORDER BY m.sent_at LIMIT 1",
    );
    const { token, customer_id } = rows[0];
    const page = await ctx.app.inject({ method: "GET", url: `/u/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Stop text messages from");
    expect(page.body).toContain("إلغاء الاشتراك");
    expect((await ctx.db.query("SELECT consent_sms FROM customers WHERE id = $1", [customer_id])).rows[0].consent_sms).toBe(true);

    const done = await ctx.app.inject({ method: "POST", url: `/u/${token}` });
    expect(done.body).toContain("No more text messages");
    const after = await ctx.db.query("SELECT consent_sms, consent_whatsapp, consent_source FROM customers WHERE id = $1", [customer_id]);
    expect(after.rows[0]).toMatchObject({ consent_sms: false, consent_source: "unsubscribe_link" });
    const audit = await ctx.db.query("SELECT data FROM audit_log WHERE action = 'customer.unsubscribe' AND entity_id = $1", [customer_id]);
    expect(audit.rows[0].data).toEqual({ channel: "sms" });

    expect((await ctx.app.inject({ method: "GET", url: "/u/not-a-real-token-at-all" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/u/x" })).statusCode).toBe(404);
  });

  it("puts the unsubscribe link in an email's footer and header", async () => {
    await customer({ name: "Mail Me", email: "mail.me@example.ae", consent: { email: true, sms: false, whatsapp: false } });
    const id = (await api("POST", "/campaigns", { name: "Newsletter", channel: "email", subject: "News from {shop}", message: "Dear {name}, new stock is in." })).json().id;
    await api("POST", `/campaigns/${id}/start`, {});
    senders.email.sent = [];
    await run();
    const mail = senders.email.sent.find((m) => m.to === "mail.me@example.ae")!;
    expect(mail.text).toBe("Dear Mail, new stock is in.");
    expect(mail.subject).toMatch(/^News from /);
    expect(mail.unsubscribeUrl).toMatch(/^https:\/\/pos\.example\.ae\/u\//);
    // With no segment, a campaign goes to every customer who said yes to that channel.
    expect(senders.email.sent.map((m) => m.to).sort()).toEqual(["aisha@example.ae", "mail.me@example.ae"]);
  });
});
