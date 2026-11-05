import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPairingCode } from "../src/seed.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));

const state = { kind: "cart", storeName: "Demo", lines: [{ name: "Water", qty: 2, uom: "unit", gross: 300 }], subtotalNet: 286, taxTotal: 14, discountTotal: 0, total: 300 };

describe("customer display", () => {
  it("passes the till's cart to a display paired to the same register", async () => {
    const code = await createPairingCode(ctx.db, ctx.data.registerId, "display");
    const claim = await ctx.app.inject({ method: "POST", url: "/pairing/claim", payload: { code, deviceId: randomUUID(), deviceName: "Screen" } });
    expect(claim.json().device).toEqual({ role: "display" });
    const display = { authorization: `Bearer ${claim.json().token}` };

    const waiting = ctx.app.inject({ method: "GET", url: "/display/state?after=0&wait=5000", headers: display });
    await new Promise((r) => setTimeout(r, 50));
    const put = await ctx.app.inject({ method: "PUT", url: "/display/state", headers: ctx.auth, payload: { state } });
    expect(put.json().version).toBe(1);
    expect((await waiting).json()).toEqual({ version: 1, state });

    const denied = await ctx.app.inject({ method: "PUT", url: "/display/state", headers: display, payload: { state } });
    expect(denied.statusCode).toBe(403);
  });

  it("tells a till that it is a till", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/device/setup", headers: ctx.auth });
    expect(res.json().device).toEqual({ role: "till" });
  });
});

describe("digital receipt", () => {
  it("shows a synced sale as a tax invoice and refunds as credit notes", async () => {
    const sessionId = await openSession(ctx);
    const sale = makeOrder(ctx, sessionId, [{ variant: 0, qty: 2 }], { pay: "cash", tendered: 500 });
    sale.lines[0]!.note = "Cold <please>";
    await postOrders(ctx, [sale]);
    const res = await ctx.app.inject({ method: "GET", url: `/r/${sale.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(sale.number);
    expect(res.body).toContain("Tax Invoice");
    expect(res.body).toContain("TRN 100000000000003");
    expect(res.body).toContain("Cold &lt;please&gt;");

    const refund = makeOrder(ctx, sessionId, [{ variant: 0, qty: -1 }], { pay: "cash", refundOf: sale.id });
    await postOrders(ctx, [refund]);
    const credit = await ctx.app.inject({ method: "GET", url: `/r/${refund.id}` });
    expect(credit.body).toContain("Tax Credit Note");
    expect(credit.body).toContain(sale.number);
  });

  it("says not found yet for unknown or malformed ids", async () => {
    expect((await ctx.app.inject({ method: "GET", url: `/r/${randomUUID()}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/r/not-a-uuid" })).statusCode).toBe(404);
  });
});
