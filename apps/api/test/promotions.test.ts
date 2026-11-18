import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let sessionId: string;

function api(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers: owner, payload });
}

const sync = async (since?: string) =>
  (await ctx.app.inject({ method: "GET", url: `/sync/catalog${since ? `?since=${encodeURIComponent(since)}` : ""}`, headers: ctx.auth })).json();

const audits = async (action: string, orderId: string) =>
  (await ctx.db.query("SELECT data FROM audit_log WHERE action = $1 AND entity_id = $2", [action, orderId])).rows;

beforeAll(async () => {
  ctx = await setup();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword },
  });
  owner = { authorization: `Bearer ${res.json().token}` };
  sessionId = await openSession(ctx);
});
afterAll(async () => teardown(ctx));

async function productOf(variantId: string) {
  return (await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [variantId])).rows[0].product_id as string;
}

describe("promotions", () => {
  let bogo: string;

  it("checks each kind has what it needs", async () => {
    const noPct = await api("POST", "/promotions", { name: "Ten off", kind: "percent_off", target: { all: true } });
    expect(noPct.statusCode).toBe(400);
    const noTarget = await api("POST", "/promotions", { name: "Ten off", kind: "percent_off", percentBp: 1000 });
    expect(noTarget.statusCode).toBe(400);
    const halfTime = await api("POST", "/promotions", {
      name: "Happy hour",
      kind: "order_percent_off",
      percentBp: 1000,
      startTime: "17:00",
    });
    expect(halfTime.statusCode).toBe(400);
    const badStore = await api("POST", "/promotions", {
      name: "Elsewhere",
      kind: "order_amount_off",
      amount: 500,
      storeIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(badStore.statusCode).toBe(400);
  });

  it("creates promotions and sends them to tills", async () => {
    const water = ctx.data.variants[0]!;
    const res = await api("POST", "/promotions", {
      name: "Water buy 2 get 1",
      kind: "buy_x_get_y",
      target: { productIds: [await productOf(water.id)] },
      buyQty: 2,
      getQty: 1,
      // Ignored for this kind, and dropped.
      amount: 500,
      days: [4, 4, 1],
    });
    expect(res.statusCode).toBe(200);
    bogo = res.json().id;
    const got = (await api("GET", `/promotions/${bogo}`)).json();
    expect(got).toMatchObject({ kind: "buy_x_get_y", percentBp: 10_000, amount: null, days: [1, 4], active: true, sales: 0 });

    const catalog = await sync();
    const promo = catalog.promotions.find((p: { id: string }) => p.id === bogo);
    expect(promo).toMatchObject({ buyQty: 2, getQty: 1, target: { all: false }, active: true, priority: 100 });
    expect(promo.target.productIds).toHaveLength(1);
  });

  it("keeps coupon codes unique among running promotions", async () => {
    const first = await api("POST", "/promotions", { name: "Ramadan", kind: "order_percent_off", percentBp: 1000, code: "ramadan10" });
    expect(first.statusCode).toBe(200);
    expect((await api("GET", `/promotions/${first.json().id}`)).json().code).toBe("RAMADAN10");
    const dup = await api("POST", "/promotions", { name: "Again", kind: "order_amount_off", amount: 500, code: "RAMADAN10" });
    expect(dup.statusCode).toBe(409);
    // Switched off, the code is free again; switching it back on then clashes.
    expect((await api("PATCH", `/promotions/${first.json().id}`, { active: false })).statusCode).toBe(200);
    const reuse = await api("POST", "/promotions", { name: "Again", kind: "order_amount_off", amount: 500, code: "RAMADAN10" });
    expect(reuse.statusCode).toBe(200);
    expect((await api("PATCH", `/promotions/${first.json().id}`, { active: true })).statusCode).toBe(409);
  });

  it("stores promotion discounts on the sale and counts the use", async () => {
    const water = ctx.data.variants[0]!;
    // 3 waters at 1.50, the third free.
    const order = makeOrder(ctx, sessionId, [{ variant: 0, qty: 3, promoDiscount: water.price, promotionId: bogo }], {
      promotions: [{ promotionId: bogo, name: "Water buy 2 get 1", amount: water.price, code: null }],
    });
    const [r] = await postOrders(ctx, [order]);
    expect(r).toMatchObject({ status: "created", totalsMismatch: false });
    const stored = (await ctx.db.query("SELECT total, discount_total FROM orders WHERE id = $1", [order.id])).rows[0];
    expect(stored).toEqual({ total: water.price * 2, discount_total: water.price });
    const line = (await ctx.db.query("SELECT promo_discount, promotion_id FROM order_lines WHERE order_id = $1", [order.id])).rows[0];
    expect(line).toEqual({ promo_discount: water.price, promotion_id: bogo });
    // Promotions are the owner's own; only hand discounts go to the discount log.
    expect(await audits("order.discount", order.id)).toHaveLength(0);
    expect(await audits("order.promo_mismatch", order.id)).toHaveLength(0);

    const promo = (await api("GET", `/promotions/${bogo}`)).json();
    expect(promo).toMatchObject({ sales: 1, discount: water.price, uses: 1 });
    expect(promo.recent[0]).toMatchObject({ id: order.id, amount: water.price });
    const bill = (await api("GET", `/orders/${order.id}`)).json();
    expect(bill.promotions).toEqual([{ promotionId: bogo, name: "Water buy 2 get 1", code: null, amount: water.price }]);
    expect(bill.lines[0].discount).toBe(water.price);
    const receipt = await ctx.app.inject({ method: "GET", url: `/r/${order.id}` });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.body).toContain("Water buy 2 get 1");
  });

  it("refuses unknown promotions and promotions that add to the price", async () => {
    const unknown = makeOrder(ctx, sessionId, [{ variant: 1, qty: 1, promoDiscount: 10, promotionId: "00000000-0000-4000-8000-000000000000" }]);
    const negative = makeOrder(ctx, sessionId, [{ variant: 1, qty: 1, promoDiscount: -10, promotionId: bogo }]);
    const [a, b] = await postOrders(ctx, [unknown, negative]);
    expect(a).toMatchObject({ status: "rejected", error: "unknown_promotion" });
    expect(b).toMatchObject({ status: "rejected", error: "bad_promotion" });
  });

  it("logs line discounts that do not match the promotions listed", async () => {
    const order = makeOrder(ctx, sessionId, [{ variant: 0, qty: 3, promoDiscount: 150, promotionId: bogo }], {
      promotions: [{ promotionId: bogo, amount: 100, code: null }],
    });
    expect((await postOrders(ctx, [order]))[0]!.status).toBe("created");
    expect(await audits("order.promo_mismatch", order.id)).toEqual([{ data: { lines: 150, promotions: 100 } }]);
  });

  it("stops sending a coupon as running once it reaches its use limit", async () => {
    const created = await api("POST", "/promotions", { name: "Launch", kind: "order_amount_off", amount: 200, code: "LAUNCH", maxUses: 1 });
    const id = created.json().id;
    const before = await sync();
    expect(before.promotions.find((p: { id: string }) => p.id === id).active).toBe(true);
    const order = makeOrder(ctx, sessionId, [{ variant: 4, qty: 1, promoDiscount: 200, promotionId: null }], {
      promotions: [{ promotionId: id, amount: 200, code: "launch" }],
    });
    expect((await postOrders(ctx, [order]))[0]!.status).toBe("created");
    const after = await sync(before.serverTime);
    expect(after.promotions.find((p: { id: string }) => p.id === id).active).toBe(false);
    const row = (await ctx.db.query("SELECT code FROM order_promotions WHERE order_id = $1", [order.id])).rows[0];
    expect(row.code).toBe("LAUNCH");
  });

  it("refunds promotion items at what was paid, and logs a refund that hands back more", async () => {
    const water = ctx.data.variants[0]!;
    const sale = makeOrder(ctx, sessionId, [{ variant: 0, qty: 3, promoDiscount: water.price, promotionId: bogo }], {
      promotions: [{ promotionId: bogo, amount: water.price, code: null }],
    });
    await postOrders(ctx, [sale]);
    // One of three back: a third of the promotion comes with it.
    const fair = makeOrder(ctx, sessionId, [{ variant: 0, qty: -1, promoDiscount: -50, promotionId: bogo }], { refundOf: sale.id });
    expect((await postOrders(ctx, [fair]))[0]!.status).toBe("created");
    expect(await audits("refund.promo_short", fair.id)).toHaveLength(0);
    expect((await ctx.db.query("SELECT COUNT(*)::int AS n FROM order_promotions WHERE order_id = $1", [fair.id])).rows[0].n).toBe(0);

    const greedy = makeOrder(ctx, sessionId, [{ variant: 0, qty: -2 }], { refundOf: sale.id });
    expect((await postOrders(ctx, [greedy]))[0]!.status).toBe("created");
    const [log] = await audits("refund.promo_short", greedy.id);
    expect(log!.data.lines[0]).toMatchObject({ expected: 100, given: 0 });
  });
});

describe("price lists", () => {
  let listId: string;

  it("creates a list with prices and assigns it to a store and a customer", async () => {
    const created = await api("POST", "/price-lists", { name: "Wholesale" });
    expect(created.statusCode).toBe(200);
    listId = created.json().id;
    expect((await api("POST", "/price-lists", { name: "Wholesale" })).statusCode).toBe(409);

    const [a, b] = ctx.data.variants;
    const items = await api("PUT", `/price-lists/${listId}/items`, {
      items: [
        { variantId: a!.id, price: 120 },
        { variantId: b!.id, price: 80 },
      ],
    });
    expect(items.statusCode).toBe(200);
    expect((await api("PUT", `/price-lists/${listId}/items`, { items: [{ variantId: "00000000-0000-4000-8000-000000000000", price: 1 }] })).statusCode).toBe(400);
    const got = (await api("GET", `/price-lists/${listId}`)).json();
    expect(got.items.map((i: { price: number; basePrice: number }) => [i.price, i.basePrice]).sort()).toEqual([
      [120, a!.price],
      [80, b!.price],
    ].sort());

    const customer = await api("POST", "/customers", { name: "Corner Cafe", phone: "0501112222", priceListId: listId });
    expect(customer.statusCode).toBe(200);
    const store = (await api("GET", "/stores")).json().stores[0];
    const { id: storeId, code: _code, ...rest } = store;
    expect((await api("PUT", `/stores/${storeId}`, { ...rest, priceListId: listId })).statusCode).toBe(200);

    const list = (await api("GET", "/price-lists")).json().priceLists.find((l: { id: string }) => l.id === listId);
    expect(list).toMatchObject({ itemCount: 2, customerCount: 1, stores: [{ id: storeId }] });

    const found = await ctx.app.inject({ method: "GET", url: "/customers?q=Corner", headers: ctx.auth });
    expect(found.json().customers[0].priceListId).toBe(listId);
  });

  it("sends lists and their prices to tills, and removals with the next sync", async () => {
    const full = await sync();
    expect(full.priceLists).toEqual([{ id: listId, name: "Wholesale", active: true }]);
    expect(full.priceListItems).toHaveLength(2);
    expect(full.store.priceListId).toBe(listId);
    const [a] = ctx.data.variants;
    expect(full.priceListItems.find((i: { variantId: string }) => i.variantId === a!.id)).toMatchObject({
      id: `${listId}:${a!.id}`,
      priceListId: listId,
      price: 120,
      active: true,
    });

    expect((await api("DELETE", `/price-lists/${listId}/items/${a!.id}`)).statusCode).toBe(200);
    const next = await sync(full.serverTime);
    expect(next.priceListItems).toEqual([expect.objectContaining({ variantId: a!.id, active: false })]);
    expect((await api("GET", `/price-lists/${listId}`)).json().items).toHaveLength(1);
  });
});
