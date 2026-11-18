import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let store2: string;
let sessionId: string;

function api(method: "GET" | "POST" | "PUT", url: string, payload?: object, headers = owner) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
}
async function ok<T = any>(method: "GET" | "POST" | "PUT", url: string, payload?: object): Promise<T> {
  const res = await api(method, url, payload);
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json();
}
const v = (i: number) => ctx.data.variants[i]!.id;
async function onHand(variantId: string, storeId = ctx.data.storeId) {
  const { rows } = await ctx.db.query("SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves WHERE variant_id = $1 AND store_id = $2", [
    variantId,
    storeId,
  ]);
  return rows[0].n as number;
}
const cost = async (variantId: string) => (await ctx.db.query("SELECT cost FROM variants WHERE id = $1", [variantId])).rows[0].cost;

beforeAll(async () => {
  ctx = await setup();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword },
  });
  owner = { authorization: `Bearer ${res.json().token}` };
  store2 = randomUUID();
  await ctx.db.query("INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AUH1', 'Abu Dhabi')", [store2, ctx.data.tenantId]);
  sessionId = await openSession(ctx);
});
afterAll(async () => teardown(ctx));

let supplierId: string;

describe("suppliers", () => {
  it("adds, lists, edits and refuses a duplicate name", async () => {
    const created = await ok("POST", "/suppliers", { name: "Al Ain Distributors", phone: "04 123 4567", trn: "100123456700003", leadTimeDays: 2 });
    supplierId = created.id;
    expect((await api("POST", "/suppliers", { name: "al ain distributors" })).statusCode).toBe(409);
    expect((await api("POST", "/suppliers", { name: "Bad TRN", trn: "123" })).statusCode).toBe(400);
    await ok("PUT", `/suppliers/${supplierId}`, { name: "Al Ain Distributors LLC", leadTimeDays: 2, paymentTermsDays: 30 });
    const list = await ok("GET", "/suppliers?q=ain");
    expect(list.suppliers).toHaveLength(1);
    expect(list.suppliers[0]).toMatchObject({ name: "Al Ain Distributors LLC", paymentTermsDays: 30, openOrders: 0 });
  });
});

describe("purchase orders", () => {
  let poId: string;
  let lines: any[];

  it("creates a draft with VAT totals and numbers it", async () => {
    const po = await ok("POST", "/purchase-orders", {
      supplierId,
      storeId: ctx.data.storeId,
      expectedOn: "2026-12-01",
      lines: [
        { variantId: v(0), qty: 10, unitCost: 200 },
        { variantId: v(1), qty: 5, unitCost: 1000 },
      ],
    });
    expect(po.number).toMatch(/^PO-\d{5}$/);
    poId = po.id;
    const detail = await ok("GET", `/purchase-orders/${poId}`);
    expect(detail).toMatchObject({ status: "draft", net: 7000, vat: 350, total: 7350, storeName: expect.any(String) });
    lines = detail.lines;
    expect(lines).toHaveLength(2);
  });

  it("refuses the same product twice and fractions of a piece", async () => {
    const twice = await api("POST", "/purchase-orders", {
      supplierId,
      storeId: ctx.data.storeId,
      lines: [{ variantId: v(0), qty: 1 }, { variantId: v(0), qty: 2 }],
    });
    expect(twice.statusCode).toBe(400);
    const half = await api("POST", "/purchase-orders", { supplierId, storeId: ctx.data.storeId, lines: [{ variantId: v(0), qty: 1.5 }] });
    expect(half.statusCode).toBe(400);
    expect(half.json().message).toContain("whole pieces");
  });

  it("receives part, blends the cost, then the rest", async () => {
    await ok("POST", `/purchase-orders/${poId}/order`, {});
    const before = await onHand(v(0));
    await ctx.db.query("UPDATE variants SET cost = 100 WHERE id = $1", [v(0)]);
    // Make sure there is stock at the old cost so averaging is visible.
    await ctx.db.query(
      "INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason) VALUES ($1, $2, $3, $4, 'adjust')",
      [ctx.data.tenantId, ctx.data.storeId, v(0), 10 - before],
    );
    const l0 = lines.find((l) => l.variantId === v(0));
    const part = await ok("POST", `/purchase-orders/${poId}/receive`, { supplierInvoice: "INV-77", lines: [{ lineId: l0.id, qty: 10 }] });
    expect(part).toMatchObject({ status: "partial", number: expect.stringMatching(/^GRN-/) });
    expect(await onHand(v(0))).toBe(20);
    // 10 at 1.00 + 10 at 2.00 → 1.50
    expect(await cost(v(0))).toBe(150);

    expect((await api("POST", `/purchase-orders/${poId}/cancel`, {})).statusCode).toBe(409);
    const l1 = lines.find((l) => l.variantId === v(1));
    const rest = await ok("POST", `/purchase-orders/${poId}/receive`, { lines: [{ lineId: l1.id, qty: 5, unitCost: 900 }] });
    expect(rest.status).toBe("received");
    const detail = await ok("GET", `/purchase-orders/${poId}`);
    expect(detail.receipts).toHaveLength(2);
    expect(detail.lines.find((l: any) => l.variantId === v(1)).unitCost).toBe(900);
    expect((await api("POST", `/purchase-orders/${poId}/receive`, { lines: [{ lineId: l1.id, qty: 1 }] })).statusCode).toBe(409);
    const sup = await ok("GET", `/suppliers/${supplierId}`);
    expect(sup.items.find((i: any) => i.variantId === v(1)).unitCost).toBe(900);
  });

  it("closes a short delivery and cancels an unused order", async () => {
    const po = await ok("POST", "/purchase-orders", { supplierId, storeId: ctx.data.storeId, lines: [{ variantId: v(2), qty: 10 }] });
    const d = await ok("GET", `/purchase-orders/${po.id}`);
    // The unit cost defaults when none is given.
    expect(d.lines[0].unitCost).toBeGreaterThanOrEqual(0);
    await ok("POST", `/purchase-orders/${po.id}/receive`, { lines: [{ lineId: d.lines[0].id, qty: 4, unitCost: 50 }] });
    expect((await ok("POST", `/purchase-orders/${po.id}/close`, {})).status).toBe("closed");

    const other = await ok("POST", "/purchase-orders", { supplierId, storeId: ctx.data.storeId, lines: [{ variantId: v(2), qty: 1 }] });
    await ok("PUT", `/purchase-orders/${other.id}`, { supplierId, storeId: ctx.data.storeId, lines: [{ variantId: v(2), qty: 3, unitCost: 60 }] });
    expect((await ok("GET", `/purchase-orders/${other.id}`)).lines[0].qtyOrdered).toBe(3);
    expect((await ok("POST", `/purchase-orders/${other.id}/cancel`, {})).status).toBe("cancelled");
    const open = await ok("GET", "/purchase-orders?status=open");
    expect(open.orders.every((o: any) => ["draft", "ordered", "partial"].includes(o.status))).toBe(true);
  });
});

describe("receiving without an order and expiry dates", () => {
  it("needs an expiry date for tracked products and estimates what is left of each batch", async () => {
    const item = await ok("GET", `/inventory/items/${v(3)}`);
    await ok("PUT", `/inventory/items/${v(3)}`, {
      reorderLevel: item.reorderLevel,
      reorderQty: null,
      preferredSupplierId: null,
      trackExpiry: true,
    });
    const start = await onHand(v(3));
    if (start !== 0) {
      await ctx.db.query("INSERT INTO stock_moves (tenant_id, store_id, variant_id, qty, reason) VALUES ($1, $2, $3, $4, 'adjust')", [
        ctx.data.tenantId,
        ctx.data.storeId,
        v(3),
        -start,
      ]);
    }
    const missing = await api("POST", "/receipts", { storeId: ctx.data.storeId, lines: [{ variantId: v(3), qty: 5, unitCost: 100 }] });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toContain("expiry");

    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    await ok("POST", "/receipts", { storeId: ctx.data.storeId, lines: [{ variantId: v(3), qty: 6, unitCost: 100, lotCode: "A1", expiresOn: soon }] });
    await new Promise((r) => setTimeout(r, 10));
    await ok("POST", "/receipts", { storeId: ctx.data.storeId, supplierId, lines: [{ variantId: v(3), qty: 4, unitCost: 100, lotCode: "B2", expiresOn: later }] });

    // Sell 3: the oldest batch (A1) is assumed to go first.
    await postOrders(ctx, [makeOrder(ctx, sessionId, [{ variant: 3, qty: 3 }])]);
    const exp = await ok("GET", `/inventory/expiry?storeId=${ctx.data.storeId}&days=30`);
    const a1 = exp.lots.find((l: any) => l.code === "A1");
    expect(a1).toMatchObject({ remaining: 3, daysLeft: 5, expired: false });
    expect(exp.lots.find((l: any) => l.code === "B2")).toBeUndefined();

    // Writing off the rest of A1 clears it from the report.
    await ok("POST", "/inventory/adjustments", {
      storeId: ctx.data.storeId,
      reason: "waste",
      note: "Expired",
      lines: [{ variantId: v(3), qty: 3, lotId: a1.lotId }],
    });
    const after = await ok("GET", `/inventory/expiry?storeId=${ctx.data.storeId}&days=365`);
    expect(after.lots.map((l: any) => l.code)).toEqual(["B2"]);
    expect(after.lots[0].remaining).toBe(4);
    expect(await onHand(v(3))).toBe(4);
  });

  it("refuses a write-off without a reason or with a negative amount", async () => {
    const noNote = await api("POST", "/inventory/adjustments", { storeId: ctx.data.storeId, reason: "waste", lines: [{ variantId: v(0), qty: 1 }] });
    expect(noNote.statusCode).toBe(400);
    const neg = await api("POST", "/inventory/adjustments", { storeId: ctx.data.storeId, reason: "waste", note: "x", lines: [{ variantId: v(0), qty: -1 }] });
    expect(neg.statusCode).toBe(400);
  });
});

describe("transfers", () => {
  it("moves stock out when sent and in when received, reporting a shortfall", async () => {
    const fromBefore = await onHand(v(0));
    const t = await ok("POST", "/transfers", { fromStoreId: ctx.data.storeId, toStoreId: store2, lines: [{ variantId: v(0), qty: 6 }] });
    expect(t.number).toMatch(/^TR-/);
    expect((await api("POST", `/transfers/${t.id}/receive`, {})).statusCode).toBe(409);
    await ok("POST", `/transfers/${t.id}/send`, {});
    expect(await onHand(v(0))).toBe(fromBefore - 6);
    // Shows as incoming at the receiving store while in transit.
    const stock2 = await ok("GET", `/inventory/stock?storeId=${store2}`);
    expect(stock2.items.find((i: any) => i.variantId === v(0)).incoming).toBe(6);

    const detail = await ok("GET", `/transfers/${t.id}`);
    const res = await ok("POST", `/transfers/${t.id}/receive`, { lines: [{ lineId: detail.lines[0].id, qtyReceived: 5 }] });
    expect(res.differences).toEqual([{ name: expect.any(String), sent: 6, received: 5 }]);
    expect(await onHand(v(0), store2)).toBe(5);
    expect((await api("PUT", `/transfers/${t.id}`, { fromStoreId: ctx.data.storeId, toStoreId: store2, lines: [{ variantId: v(0), qty: 1 }] })).statusCode).toBe(409);
  });

  it("returns stock when a sent transfer is cancelled, and refuses one store to itself", async () => {
    const same = await api("POST", "/transfers", { fromStoreId: store2, toStoreId: store2, lines: [{ variantId: v(0), qty: 1 }] });
    expect(same.statusCode).toBe(400);
    const before = await onHand(v(0), store2);
    const t = await ok("POST", "/transfers", { fromStoreId: store2, toStoreId: ctx.data.storeId, lines: [{ variantId: v(0), qty: 2 }] });
    await ok("POST", `/transfers/${t.id}/send`, {});
    expect(await onHand(v(0), store2)).toBe(before - 2);
    await ok("POST", `/transfers/${t.id}/cancel`, {});
    expect(await onHand(v(0), store2)).toBe(before);
  });
});

describe("stock counts", () => {
  it("corrects to the count without double counting sales made while counting", async () => {
    const c = await ok("POST", "/stock-counts", { storeId: ctx.data.storeId });
    expect(c.lines).toBeGreaterThan(3);
    const sys = await onHand(v(1));
    // Shelf shows 2 fewer than the system; counted, then 1 more sells afterwards.
    await ok("PUT", `/stock-counts/${c.id}/lines`, { lines: [{ variantId: v(1), counted: sys - 2 }] });
    await new Promise((r) => setTimeout(r, 20));
    await postOrders(ctx, [makeOrder(ctx, sessionId, [{ variant: 1, qty: 1 }])]);
    const detail = await ok("GET", `/stock-counts/${c.id}`);
    expect(detail.lines.find((l: any) => l.variantId === v(1)).systemAtCount).toBe(sys);

    const done = await ok("POST", `/stock-counts/${c.id}/complete`, {});
    expect(done).toMatchObject({ status: "completed", counted: 1, changed: 1 });
    expect(await onHand(v(1))).toBe(sys - 2 - 1);
    expect((await api("PUT", `/stock-counts/${c.id}/lines`, { lines: [{ variantId: v(1), counted: 1 }] })).statusCode).toBe(409);
    const moves = await ok("GET", `/inventory/moves?variantId=${v(1)}&reason=count`);
    expect(moves.moves[0]).toMatchObject({ qty: -2, refKind: "count", refNumber: detail.number });
  });

  it("refuses to complete a count with nothing counted, and can set uncounted to zero", async () => {
    const c = await ok("POST", "/stock-counts", { storeId: store2 });
    expect((await api("POST", `/stock-counts/${c.id}/complete`, {})).statusCode).toBe(400);
    await ok("PUT", `/stock-counts/${c.id}/lines`, { lines: [{ variantId: v(2), counted: 1 }] });
    await ok("POST", `/stock-counts/${c.id}/complete`, { zeroUncounted: true });
    expect(await onHand(v(0), store2)).toBe(0);
    expect(await onHand(v(2), store2)).toBe(1);
  });
});

describe("reorder suggestions", () => {
  it("suggests what is at or below the reorder level and makes draft orders per supplier", async () => {
    const level = (await onHand(v(4))) + 5;
    await ok("PUT", `/inventory/items/${v(4)}`, {
      reorderLevel: level,
      reorderQty: level + 20,
      preferredSupplierId: supplierId,
      trackExpiry: false,
      suppliers: [{ supplierId, supplierSku: "AA-44", unitCost: 333 }],
    });
    const sug = await ok("GET", `/inventory/reorder?storeId=${ctx.data.storeId}`);
    const line = sug.lines.find((l: any) => l.variantId === v(4));
    expect(line).toMatchObject({ qty: 25, supplierId, unitCost: 333, auto: false });

    const made = await ok("POST", "/inventory/reorder/purchase-orders", {
      storeId: ctx.data.storeId,
      lines: [{ variantId: v(4), supplierId, qty: line.qty }],
    });
    expect(made.orders).toHaveLength(1);
    const po = await ok("GET", `/purchase-orders/${made.orders[0].id}`);
    expect(po.lines[0]).toMatchObject({ qtyOrdered: 25, unitCost: 333, supplierSku: "AA-44" });

    // A draft is not counted as incoming; once ordered, the suggestion goes away.
    await ok("POST", `/purchase-orders/${po.id}/order`, {});
    const again = await ok("GET", `/inventory/reorder?storeId=${ctx.data.storeId}`);
    expect(again.lines.find((l: any) => l.variantId === v(4))).toBeUndefined();
  });

  it("refuses order-up-to below the reorder level", async () => {
    const res = await api("PUT", `/inventory/items/${v(4)}`, { reorderLevel: 10, reorderQty: 5, preferredSupplierId: null, trackExpiry: false });
    expect(res.statusCode).toBe(400);
  });
});

describe("stock on hand", () => {
  it("lists stock with value at cost, filters and exports CSV", async () => {
    const all = await ok("GET", `/inventory/stock?storeId=${ctx.data.storeId}`);
    expect(all.count).toBeGreaterThan(3);
    const row = all.items.find((i: any) => i.variantId === v(0));
    expect(row.value).toBe(Math.round(Math.max(0, row.onHand) * row.cost));
    const neg = await ok("GET", `/inventory/stock?status=negative`);
    expect(neg.items.every((i: any) => i.onHand < 0)).toBe(true);
    const csv = await api("GET", `/inventory/stock.csv?storeId=${ctx.data.storeId}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("on_hand");
    const item = await ok("GET", `/inventory/items/${v(0)}`);
    expect(item.stores).toHaveLength(2);
    const search = await ok("GET", `/inventory/items?q=${ctx.data.variants[0]!.barcode}&storeId=${ctx.data.storeId}`);
    expect(search.items[0].variantId).toBe(v(0));
  });

  it("keeps each business's inventory to itself", async () => {
    const tenant = randomUUID();
    await ctx.db.query("INSERT INTO tenants (id, name) VALUES ($1, 'Other LLC')", [tenant]);
    const otherStore = randomUUID();
    await ctx.db.query("INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'X1', 'X')", [otherStore, tenant]);
    expect((await api("GET", `/inventory/stock?storeId=${otherStore}`)).statusCode).toBe(400);
    expect((await api("POST", "/transfers", { fromStoreId: ctx.data.storeId, toStoreId: otherStore, lines: [{ variantId: v(0), qty: 1 }] })).statusCode).toBe(400);
    expect((await api("GET", `/purchase-orders/${randomUUID()}`)).statusCode).toBe(404);
  });
});
