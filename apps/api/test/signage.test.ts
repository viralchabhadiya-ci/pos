import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniffImage } from "../src/routes/admin/signage.js";
import { describeDeal, liveNow } from "../src/signage/feed.js";
import { hashPassword } from "../src/security.js";
import { setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
let store2: string;

const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers = owner) =>
  ctx.app.inject({ method, url: `/admin${url}`, headers, payload: payload as object });
const tv = (method: "GET" | "POST", url: string) => ctx.app.inject({ method, url, payload: method === "POST" ? {} : undefined });

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function categoryId(name: string) {
  return (await ctx.db.query("SELECT id FROM categories WHERE tenant_id = $1 AND name = $2", [ctx.data.tenantId, name])).rows[0].id as string;
}

beforeAll(async () => {
  ctx = await setup();
  const login = (email: string, password: string) => ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  store2 = randomUUID();
  await ctx.db.query("INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AUH1', 'Abu Dhabi')", [store2, ctx.data.tenantId]);
  await ctx.db.query("UPDATE users SET email = 'tv-manager@demo.ae', password_hash = $2 WHERE id = $1", [ctx.data.managerId, hashPassword("manager123")]);
  await ctx.db.query("INSERT INTO user_stores (user_id, store_id, tenant_id) VALUES ($1, $2, $3)", [ctx.data.managerId, ctx.data.storeId, ctx.data.tenantId]);
  manager = { authorization: `Bearer ${(await login("tv-manager@demo.ae", "manager123")).json().token}` };
});
afterAll(async () => teardown(ctx));

describe("signage schedule", () => {
  const now = { date: "2026-12-04", dow: 5, time: "21:30" };
  it("checks dates, days and hours, including past midnight", () => {
    expect(liveNow({}, now)).toBe(true);
    expect(liveNow({ startsOn: "2026-12-05" }, now)).toBe(false);
    expect(liveNow({ endsOn: "2026-12-03" }, now)).toBe(false);
    expect(liveNow({ startsOn: "2026-12-04", endsOn: "2026-12-04" }, now)).toBe(true);
    expect(liveNow({ days: [5, 6] }, now)).toBe(true);
    expect(liveNow({ days: [0] }, now)).toBe(false);
    expect(liveNow({ startTime: "07:00", endTime: "11:00" }, now)).toBe(false);
    expect(liveNow({ startTime: "21:00", endTime: "02:00" }, now)).toBe(true);
    expect(liveNow({ startTime: "21:00", endTime: "02:00" }, { ...now, time: "01:15" })).toBe(true);
    expect(liveNow({ startTime: "21:00", endTime: "02:00" }, { ...now, time: "02:00" })).toBe(false);
  });

  it("describes offers in English and Arabic", () => {
    const d = describeDeal({ kind: "percent_off", percent_bp: 1250, buy_qty: null, get_qty: null, bundle_qty: null, bundle_price: null, amount: null, min_subtotal: 5000, code: "EID" });
    expect(d.en).toEqual(["12.5% off", "When you spend AED 50.00 or more", "Use code EID"]);
    expect(d.ar[0]).toBe("خصم 12.5%");
    expect(describeDeal({ kind: "multi_buy", percent_bp: null, buy_qty: null, get_qty: null, bundle_qty: 3, bundle_price: 1000, amount: null, min_subtotal: null, code: null }).en).toEqual([
      "3 for AED 10.00",
    ]);
  });

  it("knows pictures by their bytes", () => {
    expect(sniffImage(Buffer.from(PNG, "base64"))).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("signage", () => {
  let mediaId: string;
  let playlistId: string;
  let promoId: string;

  it("uploads pictures and refuses other files", async () => {
    const bad = await api("POST", "/signage/media", { name: "x.svg", data: Buffer.from("<svg/>").toString("base64") });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("bad_picture");
    const big = await api("POST", "/signage/media", { name: "big.png", data: Buffer.alloc(3 * 1024 * 1024 + 10, 1).toString("base64") });
    expect(big.statusCode).toBe(413);
    const r = await api("POST", "/signage/media", { name: "Eid banner.png", data: `data:image/png;base64,${PNG}` });
    expect(r.statusCode).toBe(201);
    expect(r.json().contentType).toBe("image/png");
    mediaId = r.json().id;
    const got = await api("GET", `/signage/media/${mediaId}`);
    expect(got.headers["content-type"]).toBe("image/png");
  });

  it("builds a playlist with every kind of slide", async () => {
    const promo = await api("POST", "/promotions", { name: "Water week", kind: "percent_off", percentBp: 2000, target: { categoryIds: [await categoryId("Beverages")] } });
    expect(promo.statusCode).toBeLessThan(300);
    promoId = promo.json().id;
    const missing = await api("POST", "/signage/playlists", { name: "Bad", slides: [{ kind: "image" }] });
    expect(missing.statusCode).toBe(400);
    const r = await api("POST", "/signage/playlists", {
      name: "Main window",
      slides: [
        { kind: "image", mediaId, duration: 8 },
        { kind: "prices", categoryId: await categoryId("Beverages"), duration: 12, theme: "dark" },
        { kind: "promo", promotionId: promoId, theme: "offer" },
        { kind: "message", title: "Open 24 hours", titleAr: "مفتوح 24 ساعة", body: "Free delivery in Al Barsha", theme: "brand" },
        { kind: "video", videoUrl: "https://cdn.example.com/eid.mp4", duration: 20 },
        { kind: "message", title: "Breakfast deals", startTime: "06:00", endTime: "06:01" },
        { kind: "message", title: "Switched off", active: false },
      ],
    });
    expect(r.statusCode).toBe(201);
    playlistId = r.json().id;
    expect(r.json().slides).toHaveLength(7);
    expect(r.json().slides[1]).toMatchObject({ kind: "prices", mediaId: null, theme: "dark" });
    const dup = await api("POST", "/signage/playlists", { name: "Main window" });
    expect(dup.statusCode).toBe(409);
  });

  it("refuses pictures and offers of another business", async () => {
    const other = randomUUID();
    const tenant = randomUUID();
    await ctx.db.query("INSERT INTO tenants (id, name) VALUES ($1, 'Other LLC')", [tenant]);
    await ctx.db.query("INSERT INTO signage_media (id, tenant_id, name, content_type, bytes, size) VALUES ($1, $2, 'theirs', 'image/png', '\\x00', 1)", [other, tenant]);
    const r = await api("PUT", `/signage/playlists/${playlistId}`, { name: "Main window", slides: [{ kind: "image", mediaId: other }] });
    expect(r.statusCode).toBe(400);
  });

  it("connects a TV by code and plays only what is on now", async () => {
    const page = await tv("GET", "/tv");
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Connect this screen");
    const code = (await tv("POST", "/tv/pair")).json();
    expect(code.code).toMatch(/^\d{6}$/);
    expect((await tv("GET", `/tv/pair/${code.claim}`)).json().status).toBe("waiting");

    const wrong = await api("POST", "/signage/screens", { name: "Window", storeId: ctx.data.storeId, playlistId, code: "000000" === code.code ? "111111" : "000000" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("bad_code");
    const s = await api("POST", "/signage/screens", { name: "Window", storeId: ctx.data.storeId, playlistId, code: `${code.code.slice(0, 3)} ${code.code.slice(3)}` });
    expect(s.statusCode).toBe(201);
    expect(s.json()).not.toHaveProperty("token");
    const done = (await tv("GET", `/tv/pair/${code.claim}`)).json();
    expect(done.status).toBe("connected");
    // The code is used up.
    expect((await tv("GET", `/tv/pair/${code.claim}`)).statusCode).toBe(404);

    const feed = await tv("GET", `/tv/s/${done.token}/feed`);
    expect(feed.statusCode).toBe(200);
    const f = feed.json();
    expect(f.screen).toMatchObject({ name: "Window", orientation: "landscape", lang: "both" });
    expect(f.slides.map((x: { kind: string }) => x.kind)).toEqual(["image", "prices", "promo", "message", "video"]);
    const board = f.slides[1];
    expect(board.title).toBe("Beverages");
    expect(board.products.find((p: { name: string }) => p.name === "Al Ain Water 1.5L")).toMatchObject({ price: "1.50", nameAr: "مياه العين 1.5 لتر" });
    expect(f.slides[2]).toMatchObject({ title: "Water week", deal: ["20% off"], dealAr: ["خصم 20%"] });

    const img = await tv("GET", `/tv/s/${done.token}/media/${f.slides[0].mediaId}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["cache-control"]).toContain("immutable");

    const list = (await api("GET", "/signage")).json();
    expect(list.screens[0]).toMatchObject({ name: "Window", online: true, playlistName: "Main window" });
    expect(list.screens[0].path).toBe(`/tv#${done.token}`);
    expect(list.playlists[0]).toMatchObject({ name: "Main window", slides: 7, screens: 1 });
    expect(list.media[0]).toMatchObject({ name: "Eid banner.png", uses: 1 });

    // The same version while nothing changes, so the TV doesn't restart its slides.
    expect((await tv("GET", `/tv/s/${done.token}/feed`)).json().version).toBe(f.version);
  });

  it("leaves out offers that have ended or are for other stores", async () => {
    const screen = (await api("GET", "/signage")).json().screens[0];
    const token = screen.path.slice(4);
    await ctx.db.query("UPDATE promotions SET store_ids = $2 WHERE id = $1", [promoId, [store2]]);
    expect((await tv("GET", `/tv/s/${token}/feed`)).json().slides.map((x: { kind: string }) => x.kind)).not.toContain("promo");
    await ctx.db.query("UPDATE promotions SET store_ids = NULL, ends_at = now() - interval '1 day' WHERE id = $1", [promoId]);
    expect((await tv("GET", `/tv/s/${token}/feed`)).json().slides.map((x: { kind: string }) => x.kind)).not.toContain("promo");
    await ctx.db.query("UPDATE promotions SET ends_at = NULL WHERE id = $1", [promoId]);
  });

  it("gives a new link, and the old one stops", async () => {
    const before = (await api("GET", "/signage")).json().screens[0];
    const r = await api("POST", `/signage/screens/${before.id}/new-link`, {});
    expect(r.json().path).not.toBe(before.path);
    expect((await tv("GET", `/tv/s/${before.path.slice(4)}/feed`)).statusCode).toBe(404);
    expect((await tv("GET", `/tv/s/${r.json().path.slice(4)}/feed`)).statusCode).toBe(200);
    // And a TV can be connected to the existing screen with a fresh code.
    const code = (await tv("POST", "/tv/pair")).json();
    expect((await api("POST", `/signage/screens/${before.id}/connect`, { code: code.code })).statusCode).toBe(200);
    expect((await tv("GET", `/tv/pair/${code.claim}`)).json().token).toBe(r.json().path.slice(4));
  });

  it("keeps pictures that are in use", async () => {
    const r = await api("DELETE", `/signage/media/${mediaId}`);
    expect(r.statusCode).toBe(409);
  });

  it("lets store managers look after their own screens only", async () => {
    const mine = await api("POST", "/signage/screens", { name: "Till queue", storeId: ctx.data.storeId, playlistId, orientation: "portrait", lang: "ar" }, manager);
    expect(mine.statusCode).toBe(201);
    const theirs = await api("POST", "/signage/screens", { name: "AUH", storeId: store2 }, manager);
    expect(theirs.statusCode).toBe(403);
    const other = await api("POST", "/signage/screens", { name: "AUH", storeId: store2 });
    const hidden = await api("PUT", `/signage/screens/${other.json().id}`, { name: "Mine now", storeId: ctx.data.storeId }, manager);
    expect(hidden.statusCode).toBe(404);
    const list = (await api("GET", "/signage", undefined, manager)).json();
    expect(list.screens.map((s: { name: string }) => s.name).sort()).toEqual(["Till queue", "Window"]);
    // Playlists and pictures are head office's.
    expect((await api("PUT", `/signage/playlists/${playlistId}`, { name: "Mine", slides: [] }, manager)).statusCode).toBe(403);
    expect((await api("POST", "/signage/media", { name: "x.png", data: PNG }, manager)).statusCode).toBe(403);
    expect((await api("GET", `/signage/playlists/${playlistId}`, undefined, manager)).statusCode).toBe(200);
  });

  it("shows a deleted screen's TV the code again", async () => {
    const s = (await api("GET", "/signage")).json().screens.find((x: { name: string }) => x.name === "Till queue");
    expect((await api("DELETE", `/signage/screens/${s.id}`)).statusCode).toBe(200);
    expect((await tv("GET", `/tv/s/${s.path.slice(4)}/feed`)).statusCode).toBe(404);
  });

  it("previews a playlist in the back office", async () => {
    const r = await api("GET", `/signage/playlists/${playlistId}/preview`);
    expect(r.statusCode).toBe(200);
    expect(r.json().slides.length).toBeGreaterThan(2);
  });

  it("deletes a playlist and leaves its screens blank", async () => {
    const r = await api("DELETE", `/signage/playlists/${playlistId}`);
    expect(r.statusCode).toBe(200);
    const s = (await api("GET", "/signage")).json().screens.find((x: { name: string }) => x.name === "Window");
    expect(s.playlistId).toBeNull();
    expect((await tv("GET", `/tv/s/${s.path.slice(4)}/feed`)).json().slides).toEqual([]);
    expect((await api("DELETE", `/signage/media/${mediaId}`)).statusCode).toBe(200);
  });
});
