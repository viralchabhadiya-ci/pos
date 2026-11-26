import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError, notFound } from "../../errors.js";
import { screenFeed } from "../../signage/feed.js";
import { assertStore, storeParam } from "../../stores.js";
import { newScreenToken } from "../signage.js";
import { adminAudit, isUniqueViolation } from "./common.js";

/** Biggest picture, before base64; the request limit is 5 MB. */
export const MAX_PICTURE = 3 * 1024 * 1024;
const MAX_SLIDES = 50;
/** A screen that asked for its slides this recently counts as on. */
const ONLINE_SECONDS = 180;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:30");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01");
const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const SlideSchema = z
  .object({
    id: z.string().uuid().optional(),
    kind: z.enum(["image", "prices", "promo", "message", "video"]),
    duration: z.number().int().min(3, "Show each slide for at least 3 seconds").max(300, "Show a slide for 5 minutes at most").default(10),
    mediaId: z.string().uuid().nullish(),
    categoryId: z.string().uuid().nullish(),
    promotionId: z.string().uuid().nullish(),
    title: text(120),
    titleAr: text(120),
    body: text(600),
    bodyAr: text(600),
    videoUrl: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/\S+$/, "The video address must start with https://")
      .nullish()
      .or(z.literal(""))
      .transform((v) => v || null),
    theme: z.enum(["brand", "dark", "light", "offer"]).default("brand"),
    startsOn: Day.nullish(),
    endsOn: Day.nullish(),
    days: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
    startTime: Time.nullish(),
    endTime: Time.nullish(),
    active: z.boolean().default(true),
  })
  .superRefine((s, ctx) => {
    const need = (ok: unknown, message: string) => !ok && ctx.addIssue({ code: "custom", message });
    if (s.kind === "image") need(s.mediaId, "Choose a picture for the picture slide");
    if (s.kind === "promo") need(s.promotionId, "Choose the offer to show");
    if (s.kind === "video") need(s.videoUrl, "Enter the video's https:// address");
    if (s.kind === "message") need(s.title || s.body || s.titleAr || s.bodyAr, "Write a title or a message");
    if (s.startsOn && s.endsOn && s.endsOn < s.startsOn) ctx.addIssue({ code: "custom", message: "The end date is before the start date" });
    if (s.startTime && s.endTime && s.startTime === s.endTime) ctx.addIssue({ code: "custom", message: "The start and end time are the same" });
  });

const PlaylistSchema = z.object({
  name: z.string().trim().min(1, "Give the playlist a name").max(80),
  slides: z.array(SlideSchema).max(MAX_SLIDES, `A playlist holds up to ${MAX_SLIDES} slides`).default([]),
});

const ScreenSchema = z.object({
  name: z.string().trim().min(1, "Give the screen a name").max(80),
  storeId: z.string().uuid(),
  playlistId: z.string().uuid().nullish(),
  orientation: z.enum(["landscape", "portrait"]).default("landscape"),
  lang: z.enum(["en", "ar", "both"]).default("both"),
});

const CodeSchema = z.object({ code: z.string().trim().transform((v) => v.replace(/\D/g, "")).pipe(z.string().length(6, "The code has 6 digits")) });

const MediaSchema = z.object({
  name: z.string().trim().min(1).max(120),
  data: z.string().min(1, "Choose a picture"),
});

/** The picture's real type from its first bytes; the browser's claim is not trusted. */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
}

const tvBase = () => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/tv` : null);

const SCREEN_SELECT = `SELECT sc.id, sc.name, sc.store_id AS "storeId", st.name AS "storeName", sc.playlist_id AS "playlistId", pl.name AS "playlistName",
         sc.orientation, sc.lang, sc.token, sc.last_seen_at AS "lastSeenAt", sc.created_at AS "createdAt",
         (sc.last_seen_at > now() - interval '${ONLINE_SECONDS} seconds') AS online
    FROM signage_screens sc JOIN stores st ON st.id = sc.store_id LEFT JOIN signage_playlists pl ON pl.id = sc.playlist_id`;

/** Back office Screens: TV screens in the stores, their playlists and pictures. */
export async function signageAdminRoutes(app: FastifyInstance) {
  const screenOut = (r: Record<string, unknown>) => {
    const { token, ...rest } = r;
    const base = tvBase();
    return { ...rest, online: !!r.online, link: base ? `${base}#${token}` : null, path: `/tv#${token}` };
  };

  async function loadScreen(tenantId: string, storeIds: string[] | null, id: string) {
    const { rows } = await app.db.query(`${SCREEN_SELECT} WHERE sc.id = $1 AND sc.tenant_id = $2`, [id, tenantId]);
    const s = rows[0];
    if (!s || (storeIds && !storeIds.includes(s.storeId))) throw notFound("Screen");
    return s;
  }

  async function checkPlaylist(tenantId: string, id: string | null | undefined) {
    if (!id) return;
    const { rows } = await app.db.query(`SELECT 1 FROM signage_playlists WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!rows[0]) throw new HttpError(400, "bad_request", "That playlist does not exist");
  }

  app.get("/signage", async (req) => {
    const ctx = await app.authAdmin(req);
    const stores = storeParam(ctx);
    const screens = await app.db.query(`${SCREEN_SELECT} WHERE sc.tenant_id = $1 AND ($2::uuid[] IS NULL OR sc.store_id = ANY($2)) ORDER BY st.name, sc.name`, [
      ctx.tenantId,
      stores,
    ]);
    const playlists = await app.db.query(
      `SELECT p.id, p.name, p.updated_at AS "updatedAt",
              (SELECT COUNT(*)::int FROM signage_slides s WHERE s.playlist_id = p.id) AS slides,
              (SELECT COUNT(*)::int FROM signage_screens sc WHERE sc.playlist_id = p.id) AS screens
         FROM signage_playlists p WHERE p.tenant_id = $1 ORDER BY p.name`,
      [ctx.tenantId],
    );
    const media = await app.db.query(
      `SELECT m.id, m.name, m.content_type AS "contentType", m.size, m.created_at AS "createdAt",
              (SELECT COUNT(*)::int FROM signage_slides s WHERE s.media_id = m.id) AS uses
         FROM signage_media m WHERE m.tenant_id = $1 ORDER BY m.created_at DESC`,
      [ctx.tenantId],
    );
    return { screens: screens.rows.map(screenOut), playlists: playlists.rows, media: media.rows, tvUrl: tvBase(), maxPicture: MAX_PICTURE };
  });

  // Screens: each store's managers look after their own.
  app.post("/signage/screens", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const body = ScreenSchema.extend({ code: z.string().optional() }).parse(req.body);
    assertStore(ctx, body.storeId);
    await checkPlaylist(ctx.tenantId, body.playlistId);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [body.storeId, ctx.tenantId]);
    if (!store.rows[0]) throw new HttpError(400, "bad_request", "That store does not exist");
    const code = body.code ? CodeSchema.parse({ code: body.code }).code : null;
    const id = randomUUID();
    await withTx(app.db, async (tx) => {
      await tx.query(
        `INSERT INTO signage_screens (id, tenant_id, store_id, name, playlist_id, orientation, lang, token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, body.storeId, body.name, body.playlistId ?? null, body.orientation, body.lang, newScreenToken()],
      );
      if (code) await claimCode(tx, code, id);
      await adminAudit(tx, ctx, "signage.screen_create", "signage_screen", id, { name: body.name, connected: !!code });
    });
    reply.status(201);
    return screenOut(await loadScreen(ctx.tenantId, ctx.storeIds, id));
  });

  app.put<{ Params: { id: string } }>("/signage/screens/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    await loadScreen(ctx.tenantId, ctx.storeIds, req.params.id);
    const body = ScreenSchema.parse(req.body);
    assertStore(ctx, body.storeId);
    await checkPlaylist(ctx.tenantId, body.playlistId);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [body.storeId, ctx.tenantId]);
    if (!store.rows[0]) throw new HttpError(400, "bad_request", "That store does not exist");
    await app.db.query(`UPDATE signage_screens SET name = $2, store_id = $3, playlist_id = $4, orientation = $5, lang = $6 WHERE id = $1`, [
      req.params.id,
      body.name,
      body.storeId,
      body.playlistId ?? null,
      body.orientation,
      body.lang,
    ]);
    await adminAudit(app.db, ctx, "signage.screen_update", "signage_screen", req.params.id, body);
    return screenOut(await loadScreen(ctx.tenantId, ctx.storeIds, req.params.id));
  });

  async function claimCode(db: Parameters<typeof adminAudit>[0], code: string, screenId: string) {
    const { rows } = await db.query(`UPDATE signage_pair_codes SET screen_id = $2 WHERE code = $1 AND expires_at > now() AND screen_id IS NULL RETURNING code`, [
      code,
      screenId,
    ]);
    if (!rows[0]) throw new HttpError(400, "bad_code", "That code is not on any TV. Check the code on the screen, or reload the TV page for a new one.");
  }

  app.post<{ Params: { id: string } }>("/signage/screens/:id/connect", async (req) => {
    const ctx = await app.authAdmin(req);
    await loadScreen(ctx.tenantId, ctx.storeIds, req.params.id);
    const { code } = CodeSchema.parse(req.body);
    await claimCode(app.db, code, req.params.id);
    await adminAudit(app.db, ctx, "signage.screen_connect", "signage_screen", req.params.id);
    return { ok: true };
  });

  /** A new private link; a TV on the old one goes back to showing a code. */
  app.post<{ Params: { id: string } }>("/signage/screens/:id/new-link", async (req) => {
    const ctx = await app.authAdmin(req);
    await loadScreen(ctx.tenantId, ctx.storeIds, req.params.id);
    await app.db.query(`UPDATE signage_screens SET token = $2, last_seen_at = NULL WHERE id = $1`, [req.params.id, newScreenToken()]);
    await adminAudit(app.db, ctx, "signage.screen_new_link", "signage_screen", req.params.id);
    return screenOut(await loadScreen(ctx.tenantId, ctx.storeIds, req.params.id));
  });

  app.delete<{ Params: { id: string } }>("/signage/screens/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const s = await loadScreen(ctx.tenantId, ctx.storeIds, req.params.id);
    await app.db.query(`DELETE FROM signage_screens WHERE id = $1`, [req.params.id]);
    await adminAudit(app.db, ctx, "signage.screen_delete", "signage_screen", req.params.id, { name: s.name });
    return { ok: true };
  });

  // Playlists and pictures are the business's, so head office keeps them.
  app.post("/signage/playlists", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const body = PlaylistSchema.parse(req.body);
    const id = randomUUID();
    await savePlaylist(ctx, id, body, true);
    reply.status(201);
    return loadPlaylist(ctx.tenantId, id);
  });

  app.get<{ Params: { id: string } }>("/signage/playlists/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    return loadPlaylist(ctx.tenantId, req.params.id);
  });

  app.put<{ Params: { id: string } }>("/signage/playlists/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    await loadPlaylist(ctx.tenantId, req.params.id);
    await savePlaylist(ctx, req.params.id, PlaylistSchema.parse(req.body), false);
    return loadPlaylist(ctx.tenantId, req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/signage/playlists/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const p = await loadPlaylist(ctx.tenantId, req.params.id);
    await app.db.query(`DELETE FROM signage_playlists WHERE id = $1`, [req.params.id]);
    await adminAudit(app.db, ctx, "signage.playlist_delete", "signage_playlist", req.params.id, { name: p.name });
    return { ok: true };
  });

  /** What a playlist shows right now at a store, for the preview in the back office. */
  app.get<{ Params: { id: string }; Querystring: { storeId?: string } }>("/signage/playlists/:id/preview", async (req) => {
    const ctx = await app.authAdmin(req);
    const p = await loadPlaylist(ctx.tenantId, req.params.id);
    const storeId = req.query.storeId ?? (await app.db.query(`SELECT id FROM stores WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY code LIMIT 1`, [ctx.tenantId, ctx.storeIds])).rows[0]?.id;
    if (!storeId) throw notFound("Store");
    assertStore(ctx, storeId);
    return screenFeed(app.db, { id: "preview", tenant_id: ctx.tenantId, store_id: storeId, name: p.name, playlist_id: p.id, orientation: "landscape", lang: "both" });
  });

  async function loadPlaylist(tenantId: string, id: string) {
    const { rows } = await app.db.query(`SELECT id, name, updated_at AS "updatedAt" FROM signage_playlists WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!rows[0]) throw notFound("Playlist");
    const slides = await app.db.query(
      `SELECT id, kind, duration, media_id AS "mediaId", category_id AS "categoryId", promotion_id AS "promotionId", title, title_ar AS "titleAr",
              body, body_ar AS "bodyAr", video_url AS "videoUrl", theme, starts_on::text AS "startsOn", ends_on::text AS "endsOn", days,
              start_time AS "startTime", end_time AS "endTime", active
         FROM signage_slides WHERE playlist_id = $1 ORDER BY position, id`,
      [id],
    );
    return { ...rows[0], slides: slides.rows };
  }

  async function savePlaylist(ctx: Awaited<ReturnType<typeof app.authAdmin>>, id: string, body: z.infer<typeof PlaylistSchema>, isNew: boolean) {
    // Every picture, category and offer must be this business's own.
    const ids = (k: "mediaId" | "categoryId" | "promotionId") => [...new Set(body.slides.map((s) => s[k]).filter((v): v is string => !!v))];
    const owned = async (table: string, list: string[], what: string) => {
      if (!list.length) return;
      const { rows } = await app.db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND id = ANY($2)`, [ctx.tenantId, list]);
      if (rows[0].n !== list.length) throw new HttpError(400, "bad_request", `A slide uses ${what} that does not exist`);
    };
    await owned("signage_media", ids("mediaId"), "a picture");
    await owned("categories", ids("categoryId"), "a category");
    await owned("promotions", ids("promotionId"), "an offer");
    try {
      await withTx(app.db, async (tx) => {
        if (isNew) await tx.query(`INSERT INTO signage_playlists (id, tenant_id, name) VALUES ($1, $2, $3)`, [id, ctx.tenantId, body.name]);
        else await tx.query(`UPDATE signage_playlists SET name = $2, updated_at = now() WHERE id = $1`, [id, body.name]);
        await tx.query(`DELETE FROM signage_slides WHERE playlist_id = $1`, [id]);
        const seen = new Set<string>();
        for (const [i, s] of body.slides.entries()) {
          // Ids stay the same across saves unless one was sent twice.
          const slideId = s.id && !seen.has(s.id) ? s.id : randomUUID();
          seen.add(slideId);
          const only = <T>(kind: string, v: T) => (s.kind === kind ? v : null);
          await tx.query(
            `INSERT INTO signage_slides (id, playlist_id, position, kind, duration, media_id, category_id, promotion_id, title, title_ar, body, body_ar,
                                         video_url, theme, starts_on, ends_on, days, start_time, end_time, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
            [
              slideId,
              id,
              i,
              s.kind,
              s.duration,
              only("image", s.mediaId ?? null),
              only("prices", s.categoryId ?? null),
              only("promo", s.promotionId ?? null),
              s.kind === "image" || s.kind === "video" ? null : s.title,
              s.kind === "image" || s.kind === "video" ? null : s.titleAr,
              only("message", s.body),
              only("message", s.bodyAr),
              only("video", s.videoUrl),
              s.theme,
              s.startsOn ?? null,
              s.endsOn ?? null,
              s.days?.length ? [...new Set(s.days)].sort() : null,
              s.startTime ?? null,
              s.endTime ?? null,
              s.active,
            ],
          );
        }
        await adminAudit(tx, ctx, isNew ? "signage.playlist_create" : "signage.playlist_update", "signage_playlist", id, {
          name: body.name,
          slides: body.slides.length,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "name_taken", "There is already a playlist with this name");
      throw err;
    }
  }

  app.post("/signage/media", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const body = MediaSchema.parse(req.body);
    const bytes = Buffer.from(body.data.replace(/^data:[^,]*,/, ""), "base64");
    if (bytes.length > MAX_PICTURE) throw new HttpError(413, "too_big", "That picture is over 3 MB. Save it smaller (a 1920 × 1080 JPEG is plenty) and try again.");
    const type = sniffImage(bytes);
    if (!type) throw new HttpError(400, "bad_picture", "Use a PNG, JPEG, WebP or GIF picture");
    const id = randomUUID();
    await app.db.query(`INSERT INTO signage_media (id, tenant_id, name, content_type, bytes, size, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      id,
      ctx.tenantId,
      body.name,
      type,
      bytes,
      bytes.length,
      ctx.support ? null : ctx.userId,
    ]);
    await adminAudit(app.db, ctx, "signage.media_add", "signage_media", id, { name: body.name, size: bytes.length });
    reply.status(201);
    return { id, name: body.name, contentType: type, size: bytes.length, uses: 0 };
  });

  app.get<{ Params: { id: string } }>("/signage/media/:id", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(`SELECT content_type, bytes FROM signage_media WHERE id = $1 AND tenant_id = $2`, [req.params.id, ctx.tenantId]);
    if (!rows[0]) throw notFound("Picture");
    return reply.type(rows[0].content_type).header("cache-control", "private, max-age=86400").send(rows[0].bytes);
  });

  app.delete<{ Params: { id: string } }>("/signage/media/:id", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT m.name, (SELECT COUNT(*)::int FROM signage_slides s WHERE s.media_id = m.id) AS uses FROM signage_media m WHERE m.id = $1 AND m.tenant_id = $2`,
      [req.params.id, ctx.tenantId],
    );
    if (!rows[0]) throw notFound("Picture");
    if (rows[0].uses) throw new HttpError(409, "in_use", "A playlist still shows this picture. Take it out of the playlist first.");
    await app.db.query(`DELETE FROM signage_media WHERE id = $1`, [req.params.id]);
    await adminAudit(app.db, ctx, "signage.media_delete", "signage_media", req.params.id, { name: rows[0].name });
    return { ok: true };
  });
}
