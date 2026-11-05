import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));

describe("pairing and auth", () => {
  it("rejects requests without a device token", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/sync/catalog" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a used or wrong pairing code", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { code: "000000", deviceId: randomUUID(), deviceName: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_code");
  });

  it("returns store and register setup to a paired device", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/device/setup", headers: ctx.auth });
    expect(res.json()).toMatchObject({
      store: { code: "DXB1", trn: "100000000000003", cashRoundingStep: 25 },
      register: { code: "R1" },
      lastSessionSeq: 0,
      openSession: null,
    });
  });
});

describe("catalog sync", () => {
  it("sends a full snapshot, then only changes", async () => {
    const full = await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth });
    const body = full.json();
    expect(body.full).toBe(true);
    expect(body.variants).toHaveLength(ctx.data.variants.length);
    expect(body.taxes.find((t: { kind: string }) => t.kind === "standard")).toMatchObject({ rateBp: 500, priceIncluded: true });
    expect(body.store).toMatchObject({ code: "DXB1", trn: "100000000000003" });
    expect(body.users[0]).toHaveProperty("pinHash");

    await ctx.db.query("UPDATE variants SET price = 175, updated_at = now() WHERE id = $1", [ctx.data.variants[1]!.id]);
    const delta = await ctx.app.inject({
      method: "GET",
      url: `/sync/catalog?since=${encodeURIComponent(body.serverTime)}`,
      headers: ctx.auth,
    });
    expect(delta.json().variants).toEqual([expect.objectContaining({ id: ctx.data.variants[1]!.id, price: 175 })]);
    await ctx.db.query("UPDATE variants SET price = 100 WHERE id = $1", [ctx.data.variants[1]!.id]);
  });
});

describe("shift, sales, refund, close", () => {
  let sessionId: string;
  let saleId: string;

  it("opens one session per register, idempotently", async () => {
    sessionId = await openSession(ctx, 1, 50_000);
    const again = await ctx.app.inject({
      method: "POST",
      url: "/sessions/open",
      headers: ctx.auth,
      payload: {
        id: randomUUID(),
        registerId: ctx.data.registerId,
        seq: 2,
        openedBy: ctx.data.cashierId,
        openingCash: 0,
        openedAt: new Date().toISOString(),
      },
    });
    expect(again.statusCode).toBe(409);
  });

  it("stores orders once, even when the batch is retried", async () => {
    const cash = makeOrder(ctx, sessionId, [{ variant: 0, qty: 2 }, { variant: 11, qty: 0.75 }], {
      pay: "cash",
      tendered: 2000,
    });
    const card = makeOrder(ctx, sessionId, [{ variant: 6, qty: 1, discountBp: 1000 }]);
    saleId = card.id;
    expect(await postOrders(ctx, [cash, card])).toEqual([
      { id: cash.id, status: "created", totalsMismatch: false },
      { id: card.id, status: "created", totalsMismatch: false },
    ]);
    expect((await postOrders(ctx, [cash, card])).map((r) => r.status)).toEqual(["duplicate", "duplicate"]);

    const { rows } = await ctx.db.query("SELECT total, tax_total, cash_rounding FROM orders WHERE id = $1", [cash.id]);
    // 2 x 1.50 + 0.75 kg x 7.95 = 3.00 + 5.96 = 8.96, cash rounds to 9.00.
    // VAT per line: 3.00 -> 0.14, 5.96 -> 0.28.
    expect(rows[0]).toEqual({ total: 896, tax_total: 42, cash_rounding: 4 });
  });

  it("deducts stock through the ledger", async () => {
    const { rows } = await ctx.db.query("SELECT SUM(qty) AS qty FROM stock_moves WHERE variant_id = $1", [
      ctx.data.variants[11]!.id,
    ]);
    expect(rows[0].qty).toBe(-0.75);
  });

  it("flags but keeps orders whose till totals differ", async () => {
    const order = makeOrder(ctx, sessionId, [{ variant: 2, qty: 1 }]);
    order.clientTotals.total += 1;
    const [result] = await postOrders(ctx, [order]);
    expect(result).toMatchObject({ status: "created", totalsMismatch: true });
  });

  it("rejects unpaid orders and bad references without blocking the batch", async () => {
    const unpaid = makeOrder(ctx, sessionId, [{ variant: 3, qty: 1 }]);
    unpaid.payments[0]!.amount -= 10;
    const badSession = makeOrder(ctx, randomUUID(), [{ variant: 3, qty: 1 }]);
    const fine = makeOrder(ctx, sessionId, [{ variant: 3, qty: 1 }]);
    const results = await postOrders(ctx, [unpaid, badSession, fine]);
    expect(results.map((r) => r.error ?? r.status)).toEqual(["unpaid", "unknown_session", "created"]);
  });

  it("refunds against the original sale and blocks over-refunds", async () => {
    const refund = makeOrder(ctx, sessionId, [{ variant: 6, qty: -1, discountBp: 1000 }], { refundOf: saleId });
    refund.payments[0]!.amount = refund.clientTotals.total;
    expect((await postOrders(ctx, [refund]))[0]).toMatchObject({ status: "created" });

    const again = makeOrder(ctx, sessionId, [{ variant: 6, qty: -1 }], { refundOf: saleId });
    expect((await postOrders(ctx, [again]))[0]).toMatchObject({ status: "rejected", error: "over_refund" });
  });

  it("closes the shift with expected cash and difference", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/cash-moves",
      headers: ctx.auth,
      payload: {
        id: randomUUID(),
        sessionId,
        kind: "out",
        amount: 10_000,
        reason: "Bank drop",
        userId: ctx.data.managerId,
        at: new Date().toISOString(),
      },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/close`,
      headers: ctx.auth,
      payload: { closedBy: ctx.data.managerId, closingCashCounted: 40_850, closedAt: new Date().toISOString() },
    });
    const s = res.json();
    // 500.00 float + 9.00 cash sale - 100.00 bank drop = 409.00 expected
    expect(s).toMatchObject({ state: "closed", expectedCash: 40_900, closingCashCounted: 40_850, difference: -50 });
    expect(s.orderCount).toBe(5);
    expect(s.refundCount).toBe(1);
  });

  it("reports the day's sales and VAT", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
    const res = await ctx.app.inject({ method: "GET", url: `/reports/daily?date=${today}`, headers: ctx.auth });
    const r = res.json();
    expect(r.order_count).toBe(5);
    expect(r.vat).toEqual([expect.objectContaining({ rateBp: 500 })]);
    expect(r.net + r.tax).toBe(r.total);
  });
});
