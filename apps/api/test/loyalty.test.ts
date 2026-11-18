import { randomUUID } from "node:crypto";
import { priceOrder, type OrderSync, type TaxRate } from "@pos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let sessionId: string;
let giftMethod: string;
let pointsMethod: string;
let n = 0;

const admin = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers: owner, payload });
const till = (method: "GET" | "POST", url: string, payload?: object) => ctx.app.inject({ method, url, headers: ctx.auth, payload });

const card = async (code: string) =>
  (await ctx.db.query("SELECT id, balance, loaded, status, customer_id FROM gift_cards WHERE code = $1", [code])).rows[0];
const points = async (customerId: string) => (await ctx.db.query("SELECT points FROM customers WHERE id = $1", [customerId])).rows[0].points as number;
const audits = async (action: string) => (await ctx.db.query("SELECT entity_id, data FROM audit_log WHERE action = $1", [action])).rows;

type Line = { variant: number; qty: number } | { giftCard: string; amount: number; discountBp?: number };
type Pay = { kind: "cash" | "card" | "gift_card" | "points"; amount?: number; code?: string; points?: number; id?: string };

/** An order as the till builds it, with any mix of products, gift cards and payments. */
function order(lines: Line[], pays: Pay[], opts: { customerId?: string | null; refundOf?: string } = {}): OrderSync {
  const vat: TaxRate = { id: ctx.data.vatId, name: "VAT 5%", rateBp: 500, priceIncluded: true };
  const built = lines.map((l) => {
    if ("giftCard" in l) {
      return { id: randomUUID(), variantId: null, giftCardCode: l.giftCard, name: "Gift card", qty: 1, unitPrice: l.amount, discountBp: l.discountBp ?? 0, promoDiscount: 0, promotionId: null, taxId: null };
    }
    const v = ctx.data.variants[l.variant]!;
    return { id: randomUUID(), variantId: v.id, name: v.name, qty: l.qty, unitPrice: v.price, discountBp: 0, promoDiscount: 0, promotionId: null, taxId: ctx.data.vatId };
  });
  const totals = priceOrder(built, { taxes: { [vat.id]: vat } });
  let left = totals.total;
  const methodOf = { cash: ctx.data.cashMethodId, card: ctx.data.cardMethodId, gift_card: giftMethod, points: pointsMethod };
  const payments = pays.map((p) => {
    const amount = p.amount ?? left;
    left -= amount;
    return {
      id: p.id ?? randomUUID(),
      methodId: methodOf[p.kind],
      kind: p.kind,
      amount,
      ...(p.code ? { giftCardCode: p.code } : {}),
      ...(p.points ? { points: p.points } : {}),
    };
  });
  n += 1;
  return {
    id: randomUUID(),
    number: `DXB1-R1-0009-${String(n).padStart(4, "0")}`,
    registerId: ctx.data.registerId,
    sessionId,
    cashierId: ctx.data.cashierId,
    customerId: opts.customerId ?? null,
    refundOfOrderId: opts.refundOf ?? null,
    orderDiscountBp: 0,
    createdAt: new Date().toISOString(),
    lines: built,
    promotions: [],
    payments,
    clientTotals: { subtotalNet: totals.subtotalNet, taxTotal: totals.taxTotal, total: totals.total },
  };
}

async function newCustomer(name: string) {
  const id = randomUUID();
  const res = await till("POST", "/customers", { id, name });
  expect(res.statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  ctx = await setup();
  const res = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${res.json().token}` };
  sessionId = await openSession(ctx);
  giftMethod = ctx.data.giftCardMethodId;
  pointsMethod = ctx.data.pointsMethodId;
});
afterAll(async () => teardown(ctx));

describe("gift cards", () => {
  it("sends the new payment methods and the points programme to tills", async () => {
    const res = (await till("GET", "/sync/catalog")).json();
    expect(res.paymentMethods.map((m: { kind: string }) => m.kind).sort()).toEqual(["card", "card_manual", "cash", "gift_card", "points"]);
    expect(res.loyalty).toEqual([{ id: ctx.data.tenantId, enabled: true, pointsPerAed: 1, pointValueFils: 1, minRedeemPoints: 100 }]);
    // Only sent again when it changes.
    const again = (await till("GET", `/sync/catalog?since=${encodeURIComponent(res.serverTime)}`)).json();
    expect(again.loyalty).toEqual([]);
  });

  it("sells a new gift card: no VAT, no stock, the card is loaded when the sale syncs", async () => {
    const o = order([{ variant: 0, qty: 1 }, { giftCard: "gift-0001", amount: 5000 }], [{ kind: "cash" }]);
    // The number is taken in upper case, however it was typed.
    const [r] = await postOrders(ctx, [o]);
    expect(r).toMatchObject({ status: "created", totalsMismatch: false });
    expect(await card("GIFT-0001")).toMatchObject({ balance: 5000, loaded: 5000, status: "active" });
    const moves = await ctx.db.query("SELECT COUNT(*)::int AS n FROM stock_moves WHERE ref_id = $1", [o.id]);
    expect(moves.rows[0].n).toBe(1);
    const line = await ctx.db.query("SELECT tax, gross, variant_id FROM order_lines WHERE order_id = $1 AND gift_card_code IS NOT NULL", [o.id]);
    expect(line.rows[0]).toEqual({ tax: 0, gross: 5000, variant_id: null });
    // Selling the same number again tops it up.
    await postOrders(ctx, [order([{ giftCard: "GIFT-0001", amount: 2000 }], [{ kind: "card" }])]);
    expect(await card("GIFT-0001")).toMatchObject({ balance: 7000, loaded: 7000 });
  });

  it("refuses gift card lines with a discount, VAT, or on a refund", async () => {
    const discounted = order([{ giftCard: "GIFT-0002", amount: 5000, discountBp: 1000 }], [{ kind: "cash" }]);
    expect((await postOrders(ctx, [discounted]))[0]).toMatchObject({ status: "rejected", error: "bad_gift_card_line" });
    const taxed = order([{ giftCard: "GIFT-0002", amount: 5000 }], [{ kind: "cash" }]);
    taxed.lines[0]!.taxId = ctx.data.vatId;
    expect((await postOrders(ctx, [taxed]))[0]).toMatchObject({ status: "rejected", error: "bad_gift_card_line" });
    const both = order([{ giftCard: "GIFT-0002", amount: 5000 }], [{ kind: "cash" }]);
    both.lines[0]!.variantId = ctx.data.variants[0]!.id;
    expect((await postOrders(ctx, [both]))[0]).toMatchObject({ status: "rejected", error: "bad_line" });
  });

  it("holds a spend at the till, gives it back, and never twice", async () => {
    expect((await till("GET", "/gift-cards/gift-0001")).json()).toMatchObject({ code: "GIFT-0001", balance: 7000, status: "active" });
    expect((await till("GET", "/gift-cards/NOPE-0000")).statusCode).toBe(404);
    const paymentId = randomUUID();
    const hold = await till("POST", "/gift-cards/redeem", { paymentId, code: "gift-0001", amount: 2500, userId: ctx.data.cashierId });
    expect(hold.json()).toMatchObject({ amount: 2500, balance: 4500 });
    // A retry of the same payment answers the same and takes nothing more.
    const retry = await till("POST", "/gift-cards/redeem", { paymentId, code: "GIFT-0001", amount: 2500, userId: ctx.data.cashierId });
    expect(retry.json()).toMatchObject({ balance: 4500 });
    expect((await till("POST", "/gift-cards/redeem", { paymentId, code: "GIFT-0001", amount: 100, userId: ctx.data.cashierId })).statusCode).toBe(409);
    const tooMuch = await till("POST", "/gift-cards/redeem", { paymentId: randomUUID(), code: "GIFT-0001", amount: 4501, userId: ctx.data.cashierId });
    expect(tooMuch.json()).toMatchObject({ error: "gift_card_balance" });
    const back = await till("POST", `/gift-cards/redeem/${paymentId}/void`, { userId: ctx.data.cashierId });
    expect(back.json()).toMatchObject({ voided: true, balance: 7000 });
    expect((await till("POST", `/gift-cards/redeem/${paymentId}/void`, { userId: ctx.data.cashierId })).json()).toMatchObject({ voided: true });
    expect((await card("GIFT-0001")).balance).toBe(7000);
    // Nothing was taken for an unknown payment: nothing to give back.
    expect((await till("POST", `/gift-cards/redeem/${randomUUID()}/void`, { userId: ctx.data.cashierId })).json()).toMatchObject({ voided: false });
  });

  it("ties a held spend to the sale, after which it cannot be given back", async () => {
    const paymentId = randomUUID();
    await till("POST", "/gift-cards/redeem", { paymentId, code: "GIFT-0001", amount: 1000, userId: ctx.data.cashierId });
    const o = order([{ variant: 4, qty: 2 }], [{ kind: "gift_card", amount: 1000, code: "GIFT-0001", id: paymentId }, { kind: "cash" }]);
    expect((await postOrders(ctx, [o]))[0]).toMatchObject({ status: "created" });
    expect((await card("GIFT-0001")).balance).toBe(6000);
    const move = await ctx.db.query("SELECT order_id FROM gift_card_moves WHERE payment_id = $1 AND kind = 'redeem'", [paymentId]);
    expect(move.rows[0].order_id).toBe(o.id);
    expect((await till("POST", `/gift-cards/redeem/${paymentId}/void`, { userId: ctx.data.cashierId })).statusCode).toBe(409);
    const pay = await ctx.db.query("SELECT gift_card_id FROM payments WHERE id = $1", [paymentId]);
    expect(pay.rows[0].gift_card_id).toBe((await card("GIFT-0001")).id);
  });

  it("charges a spend that was never held when the sale syncs, and tells the owner", async () => {
    const o = order([{ variant: 2, qty: 2 }], [{ kind: "gift_card", code: "GIFT-0001" }]);
    expect((await postOrders(ctx, [o]))[0]).toMatchObject({ status: "created" });
    expect((await card("GIFT-0001")).balance).toBe(6000 - 500);
    expect((await audits("order.gift_card_late")).some((a) => a.entity_id === o.id)).toBe(true);
  });

  it("refunds onto a gift card as store credit, making a new card for the customer", async () => {
    const customerId = await newCustomer("Store credit customer");
    const sale = order([{ variant: 6, qty: 1 }], [{ kind: "cash", amount: 1450 }], { customerId });
    await postOrders(ctx, [sale]);
    const refund = makeOrder(ctx, sessionId, [{ variant: 6, qty: -1 }], { refundOf: sale.id });
    refund.payments = [{ id: randomUUID(), methodId: giftMethod, kind: "gift_card", amount: -1450, giftCardCode: "CREDIT-0001" }];
    expect((await postOrders(ctx, [refund]))[0]).toMatchObject({ status: "created" });
    expect(await card("CREDIT-0001")).toMatchObject({ balance: 1450, customer_id: customerId });
  });
});

describe("points", () => {
  let fatima: string;

  it("earns 1 point per AED on a customer's sale, not on gift cards or what points paid", async () => {
    fatima = await newCustomer("Fatima");
    const o = order([{ variant: 6, qty: 2 }, { giftCard: "GIFT-0003", amount: 10000 }], [{ kind: "card" }], { customerId: fatima });
    await postOrders(ctx, [o]);
    // 2 x 14.50 = 29.00 of goods earns 29 points; the AED 100 gift card earns nothing.
    expect(await points(fatima)).toBe(29);
    const row = await ctx.db.query("SELECT points_earned FROM orders WHERE id = $1", [o.id]);
    expect(row.rows[0].points_earned).toBe(29);
    // No customer, no points.
    const walkIn = order([{ variant: 6, qty: 1 }], [{ kind: "card" }]);
    await postOrders(ctx, [walkIn]);
    expect((await ctx.db.query("SELECT points_earned FROM orders WHERE id = $1", [walkIn.id])).rows[0].points_earned).toBe(0);
  });

  it("spends points as a payment: VAT stays on the full price", async () => {
    const adj = await admin("POST", `/customers/${fatima}/points`, { points: 471, note: "Welcome bonus" });
    expect(adj.json()).toMatchObject({ points: 500 });
    expect((await till("GET", `/customers/${fatima}`)).json()).toMatchObject({ points: 500 });
    // 14.50 bill: 400 points pay AED 4.00, the card pays 10.50.
    const o = order([{ variant: 6, qty: 1 }], [{ kind: "points", amount: 400, points: 400 }, { kind: "card" }], { customerId: fatima });
    expect((await postOrders(ctx, [o]))[0]).toMatchObject({ status: "created" });
    const saved = await ctx.db.query("SELECT tax_total, total, points_earned FROM orders WHERE id = $1", [o.id]);
    expect(saved.rows[0]).toMatchObject({ total: 1450, tax_total: 69, points_earned: 10 });
    expect(await points(fatima)).toBe(500 - 400 + 10);
    const pay = await ctx.db.query("SELECT points FROM payments WHERE order_id = $1 AND kind = 'points'", [o.id]);
    expect(pay.rows[0].points).toBe(400);
  });

  it("needs a customer to pay with points", async () => {
    const o = order([{ variant: 0, qty: 1 }], [{ kind: "points", amount: 150, points: 150 }]);
    expect((await postOrders(ctx, [o]))[0]).toMatchObject({ status: "rejected", error: "points_without_customer" });
  });

  it("takes back what a refund returns, and gives points back when the refund goes to points", async () => {
    const sale = order([{ variant: 6, qty: 4 }], [{ kind: "points", amount: 1800, points: 1800 }, { kind: "card" }], { customerId: fatima });
    await ctx.db.query("UPDATE customers SET points = points + 2000 WHERE id = $1", [fatima]);
    const before = await points(fatima);
    await postOrders(ctx, [sale]);
    // 58.00 of goods less 18.00 paid in points: 40 points earned.
    expect(await points(fatima)).toBe(before - 1800 + 40);
    // Half the goods come back: half of what was earned is taken back. The points paid come back
    // as points and the rest as cash.
    const refund = makeOrder(ctx, sessionId, [{ variant: 6, qty: -2 }], { refundOf: sale.id });
    refund.payments = [
      { id: randomUUID(), methodId: pointsMethod, kind: "points", amount: -1800, points: 1800 },
      { id: randomUUID(), methodId: ctx.data.cashMethodId, kind: "cash", amount: -1100 },
    ];
    expect((await postOrders(ctx, [refund]))[0]).toMatchObject({ status: "created" });
    // The refund belongs to the sale's customer even though the till did not say so.
    const r = await ctx.db.query("SELECT customer_id FROM orders WHERE id = $1", [refund.id]);
    expect(r.rows[0].customer_id).toBe(fatima);
    expect(await points(fatima)).toBe(before - 1800 + 40 - 20 + 1800);
    const kinds = await ctx.db.query("SELECT kind, points FROM loyalty_moves WHERE order_id = $1 ORDER BY kind", [refund.id]);
    expect(kinds.rows).toEqual([
      { kind: "refund_earn", points: -20 },
      { kind: "refund_redeem", points: 1800 },
    ]);
    expect((await audits("refund.points_over")).length).toBe(0);
    // The other half, all in points: more than the sale took in points, so the owner is told.
    const rest = makeOrder(ctx, sessionId, [{ variant: 6, qty: -2 }], { refundOf: sale.id });
    rest.payments = [{ id: randomUUID(), methodId: pointsMethod, kind: "points", amount: -2900, points: 2900 }];
    await postOrders(ctx, [rest]);
    expect(await points(fatima)).toBe(before - 1800 + 40 - 40 + 1800 + 2900);
    expect((await audits("refund.points_over")).map((a) => a.entity_id)).toEqual([rest.id]);
  });

  it("earns nothing while the programme is off", async () => {
    const off = await admin("PUT", "/loyalty", { enabled: false, pointsPerAed: 1, pointValueFils: 1, minRedeemPoints: 100 });
    expect(off.statusCode).toBe(200);
    const before = await points(fatima);
    await postOrders(ctx, [order([{ variant: 6, qty: 1 }], [{ kind: "card" }], { customerId: fatima })]);
    expect(await points(fatima)).toBe(before);
    await admin("PUT", "/loyalty", { enabled: true, pointsPerAed: 2, pointValueFils: 1, minRedeemPoints: 100 });
    await postOrders(ctx, [order([{ variant: 6, qty: 1 }], [{ kind: "card" }], { customerId: fatima })]);
    expect(await points(fatima)).toBe(before + 29);
  });
});

describe("back office", () => {
  it("shows the programme and what is outstanding", async () => {
    const res = (await admin("GET", "/loyalty")).json();
    expect(res.settings).toMatchObject({ enabled: true, pointsPerAed: 2 });
    expect(res.stats.giftCardsLive).toBeGreaterThanOrEqual(3);
    expect(res.stats.pointsOutstanding).toBeGreaterThan(0);
  });

  it("issues a card with a random number, adjusts it but never below zero", async () => {
    const res = await admin("POST", "/gift-cards", { amount: 2500, note: "Raffle prize" });
    expect(res.statusCode).toBe(200);
    const { id, code } = res.json();
    expect(code).toMatch(/^[1-9]\d{15}$/);
    expect((await admin("POST", "/gift-cards", { code, amount: 100 })).statusCode).toBe(409);
    expect((await admin("POST", `/gift-cards/${id}/adjust`, { amount: -2501, note: "Too much" })).statusCode).toBe(409);
    expect((await admin("POST", `/gift-cards/${id}/adjust`, { amount: -500 })).statusCode).toBe(400);
    expect((await admin("POST", `/gift-cards/${id}/adjust`, { amount: -500, note: "Typed wrong" })).json()).toMatchObject({ balance: 2000 });
    const detail = (await admin("GET", `/gift-cards/${id}`)).json();
    expect(detail.moves.map((m: { kind: string }) => m.kind)).toEqual(["adjust", "issue"]);
    const list = (await admin("GET", `/gift-cards?q=${code.slice(-6)}`)).json();
    expect(list.giftCards.map((g: { id: string }) => g.id)).toEqual([id]);
  });

  it("switches a card off so tills cannot spend it", async () => {
    const { id } = (await admin("GET", "/gift-cards?q=GIFT-0001")).json().giftCards[0];
    expect((await admin("PATCH", `/gift-cards/${id}`, { status: "disabled" })).statusCode).toBe(200);
    const spend = await till("POST", "/gift-cards/redeem", { paymentId: randomUUID(), code: "GIFT-0001", amount: 100, userId: ctx.data.cashierId });
    expect(spend.json()).toMatchObject({ error: "gift_card_disabled" });
    await admin("PATCH", `/gift-cards/${id}`, { status: "active" });
  });

  it("gives back a spend a till never finished, but only after a while", async () => {
    const paymentId = randomUUID();
    await till("POST", "/gift-cards/redeem", { paymentId, code: "GIFT-0003", amount: 3000, userId: ctx.data.cashierId });
    const c = await card("GIFT-0003");
    expect(c.balance).toBe(7000);
    const detail = (await admin("GET", `/gift-cards/${c.id}`)).json();
    const hold = detail.moves.find((m: { kind: string }) => m.kind === "redeem");
    expect(hold).toMatchObject({ unclaimed: true, releasable: false });
    expect((await admin("POST", `/gift-cards/${c.id}/release/${hold.id}`)).json()).toMatchObject({ error: "too_soon" });
    await ctx.db.query("UPDATE gift_card_moves SET at = now() - interval '1 hour' WHERE id = $1", [hold.id]);
    expect((await admin("POST", `/gift-cards/${c.id}/release/${hold.id}`)).json()).toMatchObject({ released: true, balance: 10000 });
    // The till's own give-back afterwards changes nothing.
    await till("POST", `/gift-cards/redeem/${paymentId}/void`, { userId: ctx.data.cashierId });
    expect((await card("GIFT-0003")).balance).toBe(10000);
  });

  it("books gift cards sold as money owed in the accounting journal, not as sales", async () => {
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const from = ymd(new Date(Date.now() - 86_400_000));
    const to = ymd(new Date(Date.now() + 86_400_000));
    const res = (await admin("GET", `/accounting/journals?from=${from}&to=${to}`)).json();
    const lines = res.journals.flatMap((j: { lines: { key: string; amount: number; description: string }[] }) => j.lines);
    const sold = lines.filter((l: { description: string }) => l.description === "Gift cards sold");
    // GIFT-0001 (50 + 20) and GIFT-0003 (100) were sold at the till.
    expect(sold.reduce((n: number, l: { amount: number }) => n + l.amount, 0)).toBe(-17_000);
    expect(lines.some((l: { key: string }) => l.key === "salesNoVat")).toBe(false);
    for (const j of res.journals) expect(j.lines.reduce((n: number, l: { amount: number }) => n + l.amount, 0)).toBe(0);
    expect(res.journals.flatMap((j: { warnings: string[] }) => j.warnings)).toEqual([]);
  });

  it("shows a customer's points moves and cards", async () => {
    const { customers } = (await admin("GET", "/customers?q=Store credit")).json();
    const res = (await admin("GET", `/customers/${customers[0].id}/loyalty`)).json();
    expect(res.giftCards.map((g: { code: string }) => g.code)).toEqual(["CREDIT-0001"]);
    expect((await admin("POST", `/customers/${customers[0].id}/points`, { points: -1, note: "x" })).statusCode).toBe(409);
  });
});
