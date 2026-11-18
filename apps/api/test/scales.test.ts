import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };

const admin = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers: owner, payload });

beforeAll(async () => {
  ctx = await setup();
  const res = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: ctx.data.ownerEmail, password: ctx.data.ownerPassword } });
  owner = { authorization: `Bearer ${res.json().token}` };
});
afterAll(async () => teardown(ctx));

describe("scale barcodes", () => {
  it("starts with the usual rules and sends them to tills", async () => {
    const res = await admin("GET", "/scales");
    expect(res.json()).toEqual({
      rules: [
        { prefix: "21", kind: "weight", pluLength: 5 },
        { prefix: "22", kind: "price", pluLength: 5 },
      ],
      productsWithCode: 2,
    });
    const sync = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth })).json();
    expect(sync.scale).toEqual([{ id: expect.any(String), rules: res.json().rules }]);
    const tomatoes = sync.variants.find((v: { barcode: string }) => v.barcode === "2100002000000");
    expect(tomatoes.plu).toBe("2");
  });

  it("saves rules and refuses bad ones", async () => {
    const bad = await admin("PUT", "/scales", { rules: [{ prefix: "31", kind: "weight", pluLength: 5 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/Rule 1: .*starting with 2/);
    const twice = await admin("PUT", "/scales", {
      rules: [
        { prefix: "21", kind: "weight", pluLength: 5 },
        { prefix: "21", kind: "price", pluLength: 5 },
      ],
    });
    expect(twice.json().message).toMatch(/same prefix/);
    const before = (await ctx.app.inject({ method: "GET", url: "/sync/catalog", headers: ctx.auth })).json().serverTime;
    const ok = await admin("PUT", "/scales", { rules: [{ prefix: "20", kind: "price", pluLength: 4 }] });
    expect(ok.statusCode).toBe(200);
    const since = (await ctx.app.inject({ method: "GET", url: `/sync/catalog?since=${encodeURIComponent(before)}`, headers: ctx.auth })).json();
    expect(since.scale[0].rules).toEqual([{ prefix: "20", kind: "price", pluLength: 4 }]);
  });
});

describe("scale item codes on products", () => {
  it("keeps one code per product, without leading zeros", async () => {
    const list = (await admin("GET", "/products?q=Croissant")).json().products;
    const croissant = list[0];
    const body = { ...croissant, plu: "0042", extraBarcodes: croissant.extraBarcodes ?? [] };
    delete body.id;
    const saved = await admin("PUT", `/products/${croissant.id}`, body);
    expect(saved.statusCode).toBe(200);
    expect((await admin("GET", "/products?q=Croissant")).json().products[0].plu).toBe("42");

    const bananas = (await admin("GET", "/products?q=Bananas")).json().products[0];
    const clash = await admin("PUT", `/products/${bananas.id}`, { ...bananas, plu: "42", id: undefined });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("plu_taken");

    const letters = await admin("PUT", `/products/${bananas.id}`, { ...bananas, plu: "A1", id: undefined });
    expect(letters.statusCode).toBe(400);
  });

  it("exports and imports the code as scale_code", async () => {
    const csv = (await admin("GET", "/products/export.csv")).body;
    expect(csv.split("\n")[0]).toContain("scale_code");
    expect(csv).toMatch(/Croissant.*,42,/);
    const imported = await admin("POST", "/products/import", { csv: "name,barcode,price,scale_code\nCroissant,6291003000069,4.50,77\n", dryRun: false });
    expect(imported.statusCode).toBe(200);
    expect((await admin("GET", "/products?q=Croissant")).json().products[0].plu).toBe("77");
  });
});
