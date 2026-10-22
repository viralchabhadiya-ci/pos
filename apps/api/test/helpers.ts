import { randomUUID } from "node:crypto";
import { priceOrder, type OrderSync, type TaxRate } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createPairingCode, seed, type SeedResult } from "../src/seed.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pos_test";

export interface Ctx {
  db: Db;
  app: FastifyInstance;
  data: SeedResult;
  token: string;
  auth: { authorization: string };
}

/** Fresh schema, demo data and one paired till for every test file. */
export async function setup(): Promise<Ctx> {
  const db = createPool(TEST_DB);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const data = await seed(db);
  const app = await buildApp(db);
  const code = await createPairingCode(db, data.registerId);
  const res = await app.inject({
    method: "POST",
    url: "/pairing/claim",
    payload: { code, deviceId: randomUUID(), deviceName: "Test till" },
  });
  const token = res.json().token as string;
  return { db, app, data, token, auth: { authorization: `Bearer ${token}` } };
}

export async function teardown(ctx: Ctx) {
  await ctx.app.close();
  await ctx.db.end();
}

export async function openSession(ctx: Ctx, seq = 1, openingCash = 50_000) {
  const id = randomUUID();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/sessions/open",
    headers: ctx.auth,
    payload: {
      id,
      registerId: ctx.data.registerId,
      seq,
      openedBy: ctx.data.cashierId,
      openingCash,
      openedAt: new Date().toISOString(),
    },
  });
  if (res.statusCode !== 200) throw new Error(res.body);
  return id;
}

let counter = 0;

/** Builds an order the way the till does, with totals from the shared engine. */
export function makeOrder(
  ctx: Ctx,
  sessionId: string,
  items: { variant: number; qty: number; discountBp?: number }[],
  opts: { pay?: "cash" | "card"; tendered?: number; refundOf?: string; orderDiscountBp?: number } = {},
): OrderSync {
  const vat: TaxRate = { id: ctx.data.vatId, name: "VAT 5%", rateBp: 500, priceIncluded: true };
  const lines = items.map((it) => {
    const v = ctx.data.variants[it.variant]!;
    return {
      id: randomUUID(),
      variantId: v.id,
      name: v.name,
      qty: it.qty,
      unitPrice: v.price,
      discountBp: it.discountBp ?? 0,
      taxId: ctx.data.vatId,
    };
  });
  const totals = priceOrder(lines, { taxes: { [vat.id]: vat }, orderDiscountBp: opts.orderDiscountBp });
  const kind = opts.pay ?? "card";
  const amount =
    kind === "cash" ? Math.round(totals.total / 25) * 25 : totals.total;
  counter += 1;
  return {
    id: randomUUID(),
    number: `DXB1-R1-0001-${String(counter).padStart(4, "0")}`,
    registerId: ctx.data.registerId,
    sessionId,
    cashierId: ctx.data.cashierId,
    customerId: null,
    refundOfOrderId: opts.refundOf ?? null,
    orderDiscountBp: opts.orderDiscountBp ?? 0,
    createdAt: new Date().toISOString(),
    lines,
    payments: [
      {
        id: randomUUID(),
        methodId: kind === "cash" ? ctx.data.cashMethodId : ctx.data.cardMethodId,
        kind,
        amount,
        tendered: opts.tendered,
      },
    ],
    clientTotals: { subtotalNet: totals.subtotalNet, taxTotal: totals.taxTotal, total: totals.total },
  };
}

export async function postOrders(ctx: Ctx, orders: OrderSync[]) {
  const res = await ctx.app.inject({ method: "POST", url: "/orders/batch", headers: ctx.auth, payload: { orders } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json().results as { id: string; status: string; error?: string; totalsMismatch?: boolean }[];
}
