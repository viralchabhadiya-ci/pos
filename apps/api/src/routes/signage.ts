import { randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { screenFeed, type ScreenRow } from "../signage/feed.js";
import { playerPage } from "../signage/player.js";

/** Codes one network can ask for in an hour, so the code space can't be swept. */
const MAX_CODES_PER_IP_HOUR = 30;
const CODE_MINUTES = 15;
const Token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);
const Id = z.string().uuid();

export const newScreenToken = () => randomBytes(24).toString("base64url");

/**
 * TV signage, without sign-in: the player page, connecting a TV by code, and each screen's
 * slides and pictures by its private link.
 */
export async function signageRoutes(app: FastifyInstance) {
  app.get("/tv", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("x-robots-tag", "noindex").send(playerPage()),
  );

  app.post("/tv/pair", async (req) => {
    const { rows } = await app.db.query(`SELECT COUNT(*)::int AS n FROM signage_pair_codes WHERE ip = $1 AND created_at > now() - interval '1 hour'`, [req.ip]);
    if (rows[0].n >= MAX_CODES_PER_IP_HOUR) throw new HttpError(429, "too_many_codes", "Too many codes from this network. Wait an hour and try again.");
    await app.db.query(`DELETE FROM signage_pair_codes WHERE expires_at < now() - interval '1 day'`);
    const claim = randomBytes(24).toString("base64url");
    for (let i = 0; i < 5; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const r = await app.db.query(
        `INSERT INTO signage_pair_codes (code, claim, ip, expires_at) VALUES ($1, $2, $3, now() + interval '${CODE_MINUTES} minutes')
         ON CONFLICT (code) DO UPDATE SET claim = EXCLUDED.claim, ip = EXCLUDED.ip, screen_id = NULL, created_at = now(), expires_at = EXCLUDED.expires_at
           WHERE signage_pair_codes.expires_at < now()
         RETURNING code`,
        [code, claim, req.ip],
      );
      if (r.rows[0]) return { code, claim, expiresIn: CODE_MINUTES * 60 };
    }
    throw new HttpError(503, "busy", "Could not make a code. Try again.");
  });

  app.get<{ Params: { claim: string } }>("/tv/pair/:claim", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const claim = Token.safeParse(req.params.claim);
    if (!claim.success) throw new HttpError(404, "not_found", "Code not found");
    const { rows } = await app.db.query(
      `SELECT p.code, p.expires_at < now() AS expired, s.token FROM signage_pair_codes p LEFT JOIN signage_screens s ON s.id = p.screen_id WHERE p.claim = $1`,
      [claim.data],
    );
    const p = rows[0];
    if (!p) throw new HttpError(404, "not_found", "Code not found");
    if (p.token) {
      await app.db.query(`DELETE FROM signage_pair_codes WHERE claim = $1`, [claim.data]);
      return { status: "connected", token: p.token };
    }
    return { status: p.expired ? "expired" : "waiting" };
  });

  async function screenBy(token: string) {
    const t = Token.safeParse(token);
    const { rows } = t.success
      ? await app.db.query<ScreenRow>(
          `UPDATE signage_screens sc SET last_seen_at = now() FROM tenants t
            WHERE sc.token = $1 AND t.id = sc.tenant_id AND t.status NOT IN ('suspended', 'cancelled')
            RETURNING sc.id, sc.tenant_id, sc.store_id, sc.name, sc.playlist_id, sc.orientation, sc.lang`,
          [t.data],
        )
      : { rows: [] };
    // The TV goes back to showing a code, so staff can connect it again.
    if (!rows[0]) throw new HttpError(404, "not_found", "This screen is not connected");
    return rows[0];
  }

  app.get<{ Params: { token: string } }>("/tv/s/:token/feed", async (req, reply) => {
    const screen = await screenBy(req.params.token);
    reply.header("cache-control", "no-store");
    return screenFeed(app.db, screen);
  });

  app.get<{ Params: { token: string; id: string } }>("/tv/s/:token/media/:id", async (req, reply) => {
    const t = Token.safeParse(req.params.token);
    const id = Id.safeParse(req.params.id);
    const { rows } =
      t.success && id.success
        ? await app.db.query(
            `SELECT m.content_type, m.bytes FROM signage_media m JOIN signage_screens sc ON sc.tenant_id = m.tenant_id WHERE sc.token = $1 AND m.id = $2`,
            [t.data, id.data],
          )
        : { rows: [] };
    if (!rows[0]) throw new HttpError(404, "not_found", "Picture not found");
    // A picture never changes under its id, so the TV keeps it and plays on through an outage.
    return reply.type(rows[0].content_type).header("cache-control", "private, max-age=604800, immutable").send(rows[0].bytes);
  });
}
