import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/security.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
let session: string;
let tableIds: Record<string, string> = {};
let groupId: string;

const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers = owner) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers, payload: payload as object });
const till = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => ctx.app.inject({ method, url, headers: ctx.auth, payload: payload as object });

const cartWith = (n: number) => ({ lines: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, name: "Burger", qty: 1, unitPrice: 2500 })), orderDiscountBp: 0 });

async function productIdOf(variant: number) {
  return (await ctx.db.query("SELECT product_id FROM variants WHERE id = $1", [ctx.data.variants[variant]!.id])).rows[0].product_id as string;
}

beforeAll(async () => {
  ctx = await setup();
  const login = (email: string, password: string) => ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  await ctx.db.query("UPDATE users SET email = 'floor-manager@demo.ae', password_hash = $2 WHERE id = $1", [ctx.data.managerId, hashPassword("manager123")]);
  await ctx.db.query("INSERT INTO user_stores (user_id, store_id, tenant_id) VALUES ($1, $2, $3)", [ctx.data.managerId, ctx.data.storeId, ctx.data.tenantId]);
  manager = { authorization: `Bearer ${(await login("floor-manager@demo.ae", "manager123")).json().token}` };
  session = await openSession(ctx);
});
afterAll(async () => teardown(ctx));

describe("restaurant set-up", () => {
  it("adds tables one by one and in bulk, without duplicates", async () => {
    const one = await api("POST", "/dining-tables", { storeId: ctx.data.storeId, area: "Terrace", name: "T1", seats: 2 }, manager);
    expect(one.statusCode).toBe(201);
    const dup = await api("POST", "/dining-tables", { storeId: ctx.data.storeId, area: "Terrace", name: "t1" });
    expect(dup.statusCode).toBe(409);
    const bulk = await api("POST", "/dining-tables/bulk", { storeId: ctx.data.storeId, area: "Main", prefix: "", from: 1, to: 6, seats: 4 });
    expect(bulk.json()).toEqual({ added: 6, skipped: 0 });
    const again = await api("POST", "/dining-tables/bulk", { storeId: ctx.data.storeId, area: "Terrace", prefix: "T", from: 1, to: 3 });
    expect(again.json()).toEqual({ added: 2, skipped: 1 });
    const r = (await api("GET", "/restaurant")).json();
    expect(r.tables).toHaveLength(9);
    tableIds = Object.fromEntries(r.tables.map((t: { name: string; id: string }) => [t.name, t.id]));
  });

  it("keeps a manager to their own store's tables", async () => {
    const other = randomUUID();
    await ctx.db.query("INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AUH1', 'Abu Dhabi')", [other, ctx.data.tenantId]);
    expect((await api("POST", "/dining-tables", { storeId: other, name: "1" }, manager)).statusCode).toBe(403);
    expect((await api("GET", `/restaurant?storeId=${other}`, undefined, manager)).statusCode).toBe(403);
  });

  it("makes modifier groups for products, and only head office may", async () => {
    const body = {
      name: "Extras",
      nameAr: "إضافات",
      minChoices: 0,
      maxChoices: 0,
      options: [
        { name: "Extra cheese", price: 300 },
        { name: "No onion", price: 0 },
      ],
      productIds: [await productIdOf(0), await productIdOf(1)],
    };
    expect((await api("POST", "/modifier-groups", body, manager)).statusCode).toBe(403);
    const bad = await api("POST", "/modifier-groups", { ...body, minChoices: 3 });
    expect(bad.statusCode).toBe(400);
    const r = await api("POST", "/modifier-groups", body);
    expect(r.statusCode).toBe(201);
    groupId = r.json().id;
    expect(r.json().options[0].id).toMatch(/[0-9a-f-]{36}/);

    const sync = (await till("GET", "/sync/catalog")).json();
    expect(sync.modifierGroups).toHaveLength(1);
    expect(sync.modifierGroups[0]).toMatchObject({ name: "Extras", maxChoices: 0 });
    expect(sync.products.find((p: { id: string }) => p.id === body.productIds[0]).modifierGroupIds).toEqual([groupId]);
    expect(sync.tables).toHaveLength(9);

    // Taking a product out of the group changes the product, so the till hears of it.
    const since = new Date(Date.now() - 1000).toISOString();
    await api("PUT", `/modifier-groups/${groupId}`, { ...body, options: r.json().options, productIds: [body.productIds[0]] });
    const later = (await till("GET", `/sync/catalog?since=${encodeURIComponent(since)}`)).json();
    expect(later.products.find((p: { id: string }) => p.id === body.productIds[1]).modifierGroupIds).toEqual([]);
  });
});

describe("tabs", () => {
  const tab1 = randomUUID();

  it("opens a tab on a table, and stops a second bill on the same table", async () => {
    const r = await till("PUT", `/tabs/${tab1}`, { tableId: tableIds["1"], guests: 3, cart: cartWith(2), total: 5000, version: 0, userId: ctx.data.cashierId });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ tableName: "1", guests: 3, version: 1, status: "open", openedBy: expect.any(String) });
    const other = await till("PUT", `/tabs/${randomUUID()}`, { tableId: tableIds["1"], cart: cartWith(1), total: 2500, version: 0, userId: ctx.data.cashierId });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: "table_busy", tab: { id: tab1 } });
    const list = (await till("GET", "/tabs")).json();
    expect(list.tabs.map((t: { id: string }) => t.id)).toEqual([tab1]);
  });

  it("refuses a save from a till that saw an older version", async () => {
    const ok = await till("PUT", `/tabs/${tab1}`, { tableId: tableIds["1"], guests: 3, cart: cartWith(3), total: 7500, version: 1, userId: ctx.data.cashierId });
    expect(ok.json().version).toBe(2);
    const stale = await till("PUT", `/tabs/${tab1}`, { tableId: tableIds["1"], guests: 3, cart: cartWith(1), total: 2500, version: 1, userId: ctx.data.cashierId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "changed", tab: { version: 2, total: 7500 } });
  });

  it("moves a tab to another table", async () => {
    const r = await till("PUT", `/tabs/${tab1}`, { tableId: tableIds["2"], guests: 3, cart: cartWith(3), total: 7500, version: 2, userId: ctx.data.cashierId });
    expect(r.json()).toMatchObject({ tableName: "2", version: 3 });
    const audit = await ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'tab.move' AND entity_id = $1", [tab1]);
    expect(audit.rowCount).toBe(1);
  });

  it("closes the tab when its sale syncs, with the items' modifiers kept", async () => {
    const order = makeOrder(ctx, session, [{ variant: 0, qty: 1 }]);
    order.lines[0]!.modifiers = [{ name: "Extra cheese", price: 300 }];
    order.tabId = tab1;
    const res = await postOrders(ctx, [order]);
    expect(res[0]!.status).toBe("created");
    const tab = (await till("GET", `/tabs/${tab1}`)).json();
    expect(tab).toMatchObject({ status: "paid", orderId: order.id });
    const line = await ctx.db.query("SELECT modifiers FROM order_lines WHERE order_id = $1", [order.id]);
    expect(line.rows[0].modifiers).toEqual([{ name: "Extra cheese", price: 300 }]);
    const saved = await ctx.db.query("SELECT tab_id FROM orders WHERE id = $1", [order.id]);
    expect(saved.rows[0].tab_id).toBe(tab1);
    // The table is free again; an old till can't reopen the paid bill.
    expect((await till("GET", "/tabs")).json().tabs).toEqual([]);
    const late = await till("PUT", `/tabs/${tab1}`, { tableId: tableIds["2"], cart: cartWith(1), total: 2500, version: 3, userId: ctx.data.cashierId });
    expect(late.json().error).toBe("closed");
    const receipt = await ctx.app.inject({ method: "GET", url: `/r/${order.id}` });
    expect(receipt.body).toContain("+ Extra cheese");
  });

  it("logs a tab paid twice instead of refusing the sale", async () => {
    const order = makeOrder(ctx, session, [{ variant: 1, qty: 1 }]);
    order.tabId = tab1;
    expect((await postOrders(ctx, [order]))[0]!.status).toBe("created");
    const audit = await ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'tab.paid_twice' AND entity_id = $1", [tab1]);
    expect(audit.rowCount).toBe(1);
  });

  it("clears a bill only with a reason when it has items", async () => {
    const id = randomUUID();
    await till("PUT", `/tabs/${id}`, { tableId: tableIds["3"], cart: cartWith(1), total: 2500, version: 0, userId: ctx.data.cashierId });
    const noReason = await till("POST", `/tabs/${id}/close`, { userId: ctx.data.cashierId });
    expect(noReason.statusCode).toBe(400);
    const r = await till("POST", `/tabs/${id}/close`, { userId: ctx.data.managerId, reason: "Guests left before ordering" });
    expect(r.json().status).toBe("cleared");
    const audit = await ctx.db.query("SELECT data FROM audit_log WHERE action = 'tab.clear' AND entity_id = $1", [id]);
    expect(audit.rows[0].data.reason).toBe("Guests left before ordering");
    // An empty one clears without a reason, and closing twice changes nothing.
    const empty = randomUUID();
    await till("PUT", `/tabs/${empty}`, { tableId: tableIds["4"], cart: cartWith(0), total: 0, version: 0, userId: ctx.data.cashierId });
    expect((await till("POST", `/tabs/${empty}/close`, { userId: ctx.data.cashierId })).json().status).toBe("cleared");
    expect((await till("POST", `/tabs/${empty}/close`, { userId: ctx.data.cashierId })).json().status).toBe("cleared");
  });

  it("refuses tables of other stores and unknown staff", async () => {
    const other = randomUUID();
    const store2 = (await ctx.db.query("SELECT id FROM stores WHERE code = 'AUH1'")).rows[0].id;
    await ctx.db.query("INSERT INTO dining_tables (id, tenant_id, store_id, name) VALUES ($1, $2, $3, 'A1')", [other, ctx.data.tenantId, store2]);
    expect((await till("PUT", `/tabs/${randomUUID()}`, { tableId: other, cart: cartWith(1), total: 1, version: 0, userId: ctx.data.cashierId })).statusCode).toBe(400);
    expect((await till("PUT", `/tabs/${randomUUID()}`, { tableId: null, cart: cartWith(1), total: 1, version: 0, userId: randomUUID() })).statusCode).toBe(400);
  });

  it("won't delete a table with an open bill", async () => {
    const id = randomUUID();
    await till("PUT", `/tabs/${id}`, { tableId: tableIds["5"], guests: 2, cart: cartWith(1), total: 2500, version: 0, userId: ctx.data.cashierId });
    expect((await api("DELETE", `/dining-tables/${tableIds["5"]}`)).statusCode).toBe(409);
    expect((await api("DELETE", `/dining-tables/${tableIds["6"]}`)).statusCode).toBe(200);
    const r = (await api("GET", `/restaurant?storeId=${ctx.data.storeId}`)).json();
    expect(r.tables.map((t: { name: string }) => t.name)).not.toContain("6");
    expect(r.openTabs).toHaveLength(1);
    expect(r.openTabs[0]).toMatchObject({ tableName: "5", total: 2500, lines: 1 });
  });
});

describe("kitchen tickets", () => {
  it("saves a ticket once, however often the till sends it", async () => {
    const t = {
      id: randomUUID(),
      tabId: null,
      label: "Table 5",
      guests: 2,
      lines: [{ lineId: "l1", name: "Burger", qty: 2, modifiers: ["Extra cheese", "No onion"], note: "Well done" }],
      userId: ctx.data.cashierId,
      createdAt: new Date().toISOString(),
    };
    expect((await till("POST", "/kitchen-tickets", t)).statusCode).toBe(201);
    expect((await till("POST", "/kitchen-tickets", t)).json().status).toBe("duplicate");
    const { rows } = await ctx.db.query("SELECT label, lines, status FROM kitchen_tickets WHERE id = $1", [t.id]);
    expect(rows[0]).toMatchObject({ label: "Table 5", status: "new" });
    expect(rows[0].lines[0].modifiers).toEqual(["Extra cheese", "No onion"]);
    // An unknown tab doesn't lose the ticket.
    expect((await till("POST", "/kitchen-tickets", { ...t, id: randomUUID(), tabId: randomUUID() })).statusCode).toBe(201);
  });

  it("deletes a modifier group and takes it off its products", async () => {
    expect((await api("DELETE", `/modifier-groups/${groupId}`)).statusCode).toBe(200);
    const { rows } = await ctx.db.query("SELECT COUNT(*)::int AS n FROM products WHERE $1::uuid = ANY(modifier_group_ids)", [groupId]);
    expect(rows[0].n).toBe(0);
  });
});
