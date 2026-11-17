import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlatformAdmin } from "../src/routes/platform.js";
import { setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let admin: { authorization: string };
let support: { authorization: string };
let signedUp: { tenantId: string; token: string; registerId: string };

const signupBody = (extra: Record<string, unknown> = {}) => ({
  businessName: "Layla Fashion Trading",
  businessType: "fashion",
  ownerName: "Layla",
  email: `layla+${randomUUID().slice(0, 6)}@example.ae`,
  password: "a-strong-pass",
  pin: "4321",
  phone: "+971 50 123 4567",
  emirate: "sharjah",
  trn: "100123456700003",
  samples: true,
  ...extra,
});

const bo = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setup();
  await ensurePlatformAdmin(ctx.db, "admin@platform.test", "Noor (Admin)", "admin-password-1");
  const login = async (email: string, password: string) => {
    const res = await ctx.app.inject({ method: "POST", url: "/platform/login", payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${res.json().token}` };
  };
  admin = await login("admin@platform.test", "admin-password-1");
  const created = await ctx.app.inject({
    method: "POST",
    url: "/platform/users",
    headers: admin,
    payload: { email: "sam@platform.test", name: "Sam (Support)", role: "support", password: "support-password-1" },
  });
  expect(created.statusCode).toBe(200);
  support = await login("sam@platform.test", "support-password-1");
});
afterAll(async () => teardown(ctx));

describe("sign-up", () => {
  it("lists business types and emirates for the form", async () => {
    const res = (await ctx.app.inject({ method: "GET", url: "/signup/options" })).json();
    expect(res.trialDays).toBe(14);
    expect(res.businessTypes.map((b: { id: string }) => b.id)).toContain("pharmacy");
    expect(res.emirates).toHaveLength(7);
  });

  it("creates a working business on a trial and signs the owner in", async () => {
    const body = signupBody();
    const res = await ctx.app.inject({ method: "POST", url: "/signup", payload: body });
    expect(res.statusCode).toBe(200);
    signedUp = res.json();
    expect(signedUp.token).toBeTruthy();

    const me = (await ctx.app.inject({ method: "GET", url: "/admin/me", headers: bo(signedUp.token) })).json();
    expect(me.tenant.name).toBe("Layla Fashion Trading");
    expect(me.user.role).toBe("owner");
    expect(me.stores).toEqual([expect.objectContaining({ code: "SHJ1", name: "Layla Fashion Trading" })]);
    expect(me.account).toMatchObject({ status: "trial", planId: "growth", stores: 1, registers: 1 });
    expect(Date.parse(me.account.trialEndsAt)).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const cats = (await ctx.app.inject({ method: "GET", url: "/admin/categories", headers: bo(signedUp.token) })).json();
    expect(JSON.stringify(cats)).toContain("Footwear");
    const { rows } = await ctx.db.query("SELECT COUNT(*)::int AS n FROM products WHERE tenant_id = $1", [signedUp.tenantId]);
    expect(rows[0].n).toBe(6);

    // The owner can sign in again with the password, and the email cannot be used twice.
    const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: body.email, password: body.password } });
    expect(login.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: "POST", url: "/signup", payload: { ...signupBody(), email: body.email.toUpperCase() } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("email_taken");
  });

  it("checks the form and can start without sample products", async () => {
    const bad = await ctx.app.inject({ method: "POST", url: "/signup", payload: signupBody({ pin: "12", trn: "123" }) });
    expect(bad.statusCode).toBe(400);
    const empty = await ctx.app.inject({ method: "POST", url: "/signup", payload: signupBody({ samples: false, trn: "", phone: "" }) });
    expect(empty.statusCode).toBe(200);
    const { rows } = await ctx.db.query("SELECT COUNT(*)::int AS n FROM products WHERE tenant_id = $1", [empty.json().tenantId]);
    expect(rows[0].n).toBe(0);
  });

  it("slows down many sign-ups from one address", async () => {
    await ctx.db.query("INSERT INTO signup_attempts (ip) SELECT '127.0.0.1' FROM generate_series(1, 5)");
    const res = await ctx.app.inject({ method: "POST", url: "/signup", payload: signupBody() });
    expect(res.statusCode).toBe(429);
    await ctx.db.query("DELETE FROM signup_attempts");
  });
});

describe("plan limits", () => {
  it("stops a new register or store beyond the plan", async () => {
    await ctx.db.query("UPDATE tenants SET plan_id = 'starter' WHERE id = $1", [signedUp.tenantId]);
    const me = (await ctx.app.inject({ method: "GET", url: "/admin/me", headers: bo(signedUp.token) })).json();
    const storeId = me.stores[0].id;
    const add = (code: string) =>
      ctx.app.inject({ method: "POST", url: "/admin/registers", headers: bo(signedUp.token), payload: { storeId, name: code, code } });
    expect((await add("R2")).statusCode).toBe(200);
    const third = await add("R3");
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({ error: "plan_limit", message: expect.stringContaining("Starter") });

    const store = await ctx.app.inject({
      method: "POST",
      url: "/admin/stores",
      headers: bo(signedUp.token),
      payload: { code: "SHJ2", name: "Second shop", timezone: "Asia/Dubai", cashRoundingStep: 25 },
    });
    expect(store.statusCode).toBe(409);
    await ctx.db.query("UPDATE tenants SET plan_id = 'pro' WHERE id = $1", [signedUp.tenantId]);
    const ok = await ctx.app.inject({
      method: "POST",
      url: "/admin/stores",
      headers: bo(signedUp.token),
      payload: { code: "shj2", name: "Second shop", timezone: "Asia/Dubai", cashRoundingStep: 25 },
    });
    expect(ok.statusCode).toBe(200);
    const regs = (await ctx.app.inject({ method: "GET", url: "/admin/registers", headers: bo(signedUp.token) })).json();
    expect(regs.registers.some((r: { storeName: string }) => r.storeName === "Second shop")).toBe(true);
  });
});

describe("platform console", () => {
  it("keeps platform staff and business users apart", async () => {
    const asOwner = await ctx.app.inject({ method: "GET", url: "/platform/tenants", headers: bo(signedUp.token) });
    expect(asOwner.statusCode).toBe(401);
    const asPlatform = await ctx.app.inject({ method: "GET", url: "/admin/me", headers: admin });
    expect(asPlatform.statusCode).toBe(401);
    const wrong = await ctx.app.inject({ method: "POST", url: "/platform/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
    expect(wrong.statusCode).toBe(401);
  });

  it("lists and finds businesses with their usage", async () => {
    const all = (await ctx.app.inject({ method: "GET", url: "/platform/tenants", headers: support })).json();
    expect(all.count).toBeGreaterThanOrEqual(3);
    const found = (await ctx.app.inject({ method: "GET", url: "/platform/tenants?q=layla&status=trial", headers: support })).json();
    expect(found.count).toBe(2);
    expect(found.tenants.find((t: { id: string }) => t.id === signedUp.tenantId)).toMatchObject({ planId: "pro", stores: 2, registers: 3 });

    const detail = (await ctx.app.inject({ method: "GET", url: `/platform/tenants/${signedUp.tenantId}`, headers: support })).json();
    expect(detail.tenant.businessType).toBe("fashion");
    expect(detail.users[0]).toMatchObject({ role: "owner", name: "Layla" });
    expect(detail.audit.some((a: { action: string }) => a.action === "tenant.signup")).toBe(true);

    const overview = (await ctx.app.inject({ method: "GET", url: "/platform/overview", headers: support })).json();
    expect(overview.tenants.byStatus.trial).toBeGreaterThanOrEqual(2);
    expect(overview.checks.find((c: { id: string }) => c.id === "database").ok).toBe(true);
    expect(overview.server.migrations).toContain("005_platform.sql");
  });

  it("lets support keep notes and extend a trial, but only admins change plan or status", async () => {
    const url = `/platform/tenants/${signedUp.tenantId}`;
    const ends = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect((await ctx.app.inject({ method: "PUT", url, headers: support, payload: { notes: "Asked for a demo", trialEndsAt: ends } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "PUT", url, headers: support, payload: { status: "active" } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "PUT", url, headers: admin, payload: { status: "active", planId: "growth" } })).statusCode).toBe(200);
    const detail = (await ctx.app.inject({ method: "GET", url, headers: admin })).json();
    expect(detail.tenant).toMatchObject({ status: "active", planId: "growth", notes: "Asked for a demo" });
    expect(detail.audit[0]).toMatchObject({ action: "tenant.update", by: "Noor (Admin)", data: { status: { from: "trial", to: "active" } } });
  });

  it("pauses an account: back office and new devices stop, tills keep their sales", async () => {
    const url = `/platform/tenants/${ctx.data.tenantId}`;
    expect((await ctx.app.inject({ method: "PUT", url, headers: admin, payload: { status: "suspended" } })).statusCode).toBe(200);
    const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe("account_suspended");

    const code = await ctx.db.query(
      "INSERT INTO pairing_codes (code, register_id, role, expires_at) VALUES ('424242', $1, 'till', now() + interval '5 minutes') RETURNING code",
      [ctx.data.registerId],
    );
    const pair = await ctx.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { code: code.rows[0].code, deviceId: randomUUID(), deviceName: "New till" },
    });
    expect(pair.statusCode).toBe(403);
    // The till already paired keeps working, so no sale is lost.
    expect((await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth })).statusCode).toBe(200);

    // Support can still sign in to help, and the business sees it in its audit log.
    const short = await ctx.app.inject({ method: "POST", url: `${url}/support-session`, headers: support, payload: { reason: "x" } });
    expect(short.statusCode).toBe(400);
    const s = await ctx.app.inject({ method: "POST", url: `${url}/support-session`, headers: support, payload: { reason: "Owner asked for help with VAT report" } });
    expect(s.statusCode).toBe(200);
    const me = (await ctx.app.inject({ method: "GET", url: "/admin/me", headers: bo(s.json().token) })).json();
    expect(me.support).toMatchObject({ by: "Sam (Support)", reason: "Owner asked for help with VAT report" });
    expect(me.user.name).toBe("Sam (Support) (support)");
    expect(Date.parse(me.support.endsAt) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    await ctx.app.inject({
      method: "POST",
      url: "/admin/customers",
      headers: bo(s.json().token),
      payload: { name: "Added by support" },
    });
    const audit = (await ctx.app.inject({ method: "GET", url: "/admin/audit?limit=5", headers: bo(s.json().token) })).json();
    expect(audit.entries.find((e: { action: string }) => e.action === "customer.create").data.support).toBe("Sam (Support)");
    expect(audit.entries.some((e: { action: string }) => e.action === "support.sign_in")).toBe(true);

    await ctx.app.inject({ method: "PUT", url, headers: admin, payload: { status: "active" } });
    const back = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
    expect(back.statusCode).toBe(200);
  });

  it("lets only admins edit plans and platform staff, and not lock themselves out", async () => {
    const plan = { name: "Starter", priceMonthly: 12900, maxStores: 1, maxRegisters: 2, active: true };
    expect((await ctx.app.inject({ method: "PUT", url: "/platform/plans/starter", headers: support, payload: plan })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "PUT", url: "/platform/plans/starter", headers: admin, payload: plan })).statusCode).toBe(200);
    const plans = (await ctx.app.inject({ method: "GET", url: "/platform/plans", headers: support })).json().plans;
    expect(plans.find((p: { id: string }) => p.id === "starter").priceMonthly).toBe(12900);

    const me = (await ctx.app.inject({ method: "GET", url: "/platform/me", headers: admin })).json().user;
    const self = await ctx.app.inject({ method: "PUT", url: `/platform/users/${me.id}`, headers: admin, payload: { active: false } });
    expect(self.statusCode).toBe(409);

    const users = (await ctx.app.inject({ method: "GET", url: "/platform/users", headers: admin })).json().users;
    const sam = users.find((u: { email: string }) => u.email === "sam@platform.test");
    await ctx.app.inject({ method: "PUT", url: `/platform/users/${sam.id}`, headers: admin, payload: { active: false } });
    expect((await ctx.app.inject({ method: "GET", url: "/platform/me", headers: support })).statusCode).toBe(401);
  });
});
