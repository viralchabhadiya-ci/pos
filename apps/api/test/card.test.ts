import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimulatorProvider } from "../src/payments/simulator.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

const DELAY = 60;
let ctx: Ctx;
let owner: { authorization: string };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  ctx = await setup({ paymentProviders: new Map([["simulator", new SimulatorProvider(DELAY)]]) });
  const res = await ctx.app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword },
  });
  owner = { authorization: `Bearer ${res.json().token}` };
});
afterAll(async () => teardown(ctx));

const start = (amount: number, extra: Record<string, unknown> = {}) =>
  ctx.app.inject({
    method: "POST",
    url: "/card/payments",
    headers: ctx.auth,
    payload: { id: randomUUID(), amount, orderId: randomUUID(), userId: ctx.data.cashierId, ...extra },
  });
const status = (id: string) => ctx.app.inject({ method: "GET", url: `/card/payments/${id}`, headers: ctx.auth });
// Polls until the simulated terminal answers, so a slow CI runner does not see "pending".
const settled = async (id: string) => {
  await wait(DELAY + 20);
  for (let i = 0; ; i++) {
    const res = await status(id);
    if (res.json().status !== "pending" || i >= 50) return res;
    await wait(40);
  }
};

describe("card terminal", () => {
  it("refuses an integrated card payment when the till has no terminal", async () => {
    const res = await start(1000);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_terminal");
    expect((await ctx.app.inject({ method: "GET", url: "/card/terminal", headers: ctx.auth })).json().terminal).toBeNull();
  });

  it("lets the back office link a terminal to a till, one per till", async () => {
    const providers = (await ctx.app.inject({ method: "GET", url: "/admin/terminal-providers", headers: owner })).json().providers;
    expect(providers).toEqual([{ id: "simulator", label: "Simulator (testing)" }]);
    const body = { registerId: ctx.data.registerId, name: "Counter 1 terminal", provider: "simulator", terminalRef: "SIM-001" };
    const res = await ctx.app.inject({ method: "POST", url: "/admin/terminals", headers: owner, payload: body });
    expect(res.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: "POST", url: "/admin/terminals", headers: owner, payload: { ...body, terminalRef: "SIM-002" } });
    expect(again.statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "GET", url: "/card/terminal", headers: ctx.auth })).json().terminal).toMatchObject({
      name: "Counter 1 terminal",
    });
  });

  it("waits for the customer, then approves", async () => {
    const res = await start(1000);
    expect(res.json()).toMatchObject({ status: "pending", amount: 1000 });
    const id = res.json().id;
    const done = (await settled(id)).json();
    expect(done).toMatchObject({ status: "approved", cardLast4: expect.stringMatching(/^\d{4}$/), authCode: expect.any(String) });
  });

  it("never charges twice when the same payment is sent again", async () => {
    const id = randomUUID();
    const orderId = randomUUID();
    await start(2000, { id, orderId });
    await wait(DELAY + 20);
    const retry = await start(2000, { id, orderId });
    expect(retry.json()).toMatchObject({ id, status: "approved" });
    const { rows } = await ctx.db.query("SELECT COUNT(*)::int AS n FROM card_transactions WHERE order_id = $1", [orderId]);
    expect(rows[0].n).toBe(1);
  });

  it("starts the terminal once when the same payment arrives twice at the same time", async () => {
    const sim = ctx.app.paymentProviders.get("simulator")!;
    const realStart = sim.start.bind(sim);
    let starts = 0;
    sim.start = async (req) => {
      starts++;
      return realStart(req);
    };
    try {
      const id = randomUUID();
      const orderId = randomUUID();
      const [a, b] = await Promise.all([start(2500, { id, orderId }), start(2500, { id, orderId })]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(starts).toBe(1);
      expect((await settled(id)).json().status).toBe("approved");
    } finally {
      sim.start = realStart;
    }
  });

  it("reports a decline with the bank's reason", async () => {
    const id = (await start(1013)).json().id;
    expect((await settled(id)).json()).toMatchObject({ status: "declined", message: expect.stringContaining("insufficient") });
  });

  it("marks a lost answer unknown and finds the real result on the next check", async () => {
    const lost = (await start(1015)).json();
    expect(lost.status).toBe("unknown");
    expect((await status(lost.id)).json().status).toBe("approved");

    const flaky = (await start(1016)).json();
    expect((await settled(flaky.id)).json().status).toBe("unknown");
    expect((await status(flaky.id)).json().status).toBe("unknown");
    expect((await status(flaky.id)).json().status).toBe("approved");
  });

  it("cancels a payment still waiting, and a late check cannot undo the cancel", async () => {
    const id = (await start(1014)).json().id;
    const cancel = await ctx.app.inject({ method: "POST", url: `/card/payments/${id}/cancel`, headers: ctx.auth });
    expect(cancel.json().status).toBe("cancelled");
    await wait(DELAY * 5);
    expect((await status(id)).json().status).toBe("cancelled");
  });

  it("answers approved when a cancel comes too late", async () => {
    const id = (await start(1100)).json().id;
    await wait(DELAY + 20);
    const cancel = await ctx.app.inject({ method: "POST", url: `/card/payments/${id}/cancel`, headers: ctx.auth });
    expect(cancel.json().status).toBe("approved");
  });

  it("links the card payment to the bill, and flags a bill that does not match it", async () => {
    const sessionId = await openSession(ctx);
    const order = makeOrder(ctx, sessionId, [{ variant: 0, qty: 2 }], { pay: "card" });
    const pay = order.payments[0]!;
    const card = (await start(pay.amount, { orderId: order.id })).json();
    await settled(card.id);
    pay.cardTransactionId = card.id;
    expect((await postOrders(ctx, [order]))[0]!.status).toBe("created");
    const linked = await ctx.db.query("SELECT card_transaction_id FROM payments WHERE id = $1", [pay.id]);
    expect(linked.rows[0].card_transaction_id).toBe(card.id);

    const other = makeOrder(ctx, sessionId, [{ variant: 1, qty: 1 }], { pay: "card" });
    const cheap = (await start(50, { orderId: other.id })).json();
    await settled(cheap.id);
    other.payments[0]!.cardTransactionId = cheap.id;
    expect((await postOrders(ctx, [other]))[0]!.status).toBe("created");
    const flagged = await ctx.db.query("SELECT data FROM audit_log WHERE action = 'order.card_mismatch' AND entity_id = $1", [other.id]);
    expect(flagged.rows[0].data).toMatchObject({ cardAmount: 50, paid: other.payments[0]!.amount });
  });

  it("refunds to the card, never more than was paid", async () => {
    const sale = (await start(3000)).json();
    await settled(sale.id);
    const over = await start(3001, { kind: "refund", refundOf: sale.id });
    expect(over.json().error).toBe("over_refund");
    const part = (await start(1000, { kind: "refund", refundOf: sale.id })).json();
    expect((await settled(part.id)).json()).toMatchObject({ status: "approved", kind: "refund" });
    expect((await start(2001, { kind: "refund", refundOf: sale.id })).json().error).toBe("over_refund");
    expect((await start(1000, { kind: "refund" })).statusCode).toBe(400);
  });

  it("lets only a manager mark a stranded charge as sorted", async () => {
    const sale = (await start(4000)).json();
    await settled(sale.id);
    const resolve = (userId: string) =>
      ctx.app.inject({ method: "POST", url: `/card/payments/${sale.id}/resolve`, headers: ctx.auth, payload: { userId } });
    expect((await resolve(ctx.data.cashierId)).statusCode).toBe(403);
    expect((await resolve(ctx.data.managerId)).statusCode).toBe(200);
    const { rows } = await ctx.db.query("SELECT resolved_by FROM card_transactions WHERE id = $1", [sale.id]);
    expect(rows[0].resolved_by).toBe(ctx.data.managerId);
  });

  it("lists card payments for reconciliation, flagging only charges still unaccounted for", async () => {
    // A stranded charge refunded back to the card in full needs nothing more.
    const stranded = (await start(1200)).json();
    await settled(stranded.id);
    const back = (await start(1200, { kind: "refund", refundOf: stranded.id })).json();
    await settled(back.id);

    const all = (await ctx.app.inject({ method: "GET", url: "/admin/card-transactions", headers: owner })).json();
    expect(all.count).toBeGreaterThan(5);
    await ctx.db.query("UPDATE card_transactions SET created_at = now() - interval '1 hour'");
    const problems = (await ctx.app.inject({ method: "GET", url: "/admin/card-transactions?status=problem", headers: owner })).json();
    const ids = problems.transactions.map((t: { id: string }) => t.id);
    expect(problems.transactions.every((t: { orderNumber: string | null }) => t.orderNumber === null)).toBe(true);
    expect(problems.transactions.some((t: { status: string }) => t.status === "approved")).toBe(true);
    expect(ids).not.toContain(stranded.id);
    expect(ids).not.toContain(back.id);
    const resolved = await ctx.db.query("SELECT id FROM card_transactions WHERE resolved_at IS NOT NULL");
    expect(ids).not.toContain(resolved.rows[0].id);
  });

  it("does not let a customer display take payments", async () => {
    const code = (
      await ctx.app.inject({ method: "POST", url: `/admin/registers/${ctx.data.registerId}/pairing-code`, headers: owner, payload: { role: "display" } })
    ).json().code;
    const claim = await ctx.app.inject({ method: "POST", url: "/pairing/claim", payload: { code, deviceId: randomUUID(), deviceName: "Screen" } });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/card/payments",
      headers: { authorization: `Bearer ${claim.json().token}` },
      payload: { id: randomUUID(), amount: 100, orderId: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });
});
