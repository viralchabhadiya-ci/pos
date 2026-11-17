import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { BUSINESS_TYPES, EMIRATES, TEMPLATES, type BusinessType, type Emirate } from "../templates.js";
import { createTenant, TRIAL_DAYS } from "../tenants.js";
import { openAdminSession } from "./admin/auth.js";
import { isUniqueViolation } from "./admin/common.js";

/** Sign-ups allowed from one address per hour. */
const MAX_SIGNUPS_PER_HOUR = 5;

const SignupSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.enum(BUSINESS_TYPES as [BusinessType, ...BusinessType[]]),
  ownerName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, "Use at least 8 characters").max(200),
  pin: z.string().regex(/^\d{4,6}$/, "Use 4 to 6 digits"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{7,20}$/, "Enter a phone number, e.g. +971 50 123 4567")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  storeName: z.string().trim().min(1).max(120).optional(),
  emirate: z.enum(Object.keys(EMIRATES) as [Emirate, ...Emirate[]]),
  trn: z
    .string()
    .trim()
    .regex(/^\d{15}$/, "A TRN has 15 digits")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  samples: z.boolean().default(true),
});

/** Self sign-up: a shop owner creates their business and lands in the back office on a free trial. */
export async function signupRoutes(app: FastifyInstance) {
  app.get("/signup/options", async () => ({
    trialDays: TRIAL_DAYS,
    businessTypes: BUSINESS_TYPES.map((id) => ({ id, label: TEMPLATES[id].label })),
    emirates: Object.entries(EMIRATES).map(([id, e]) => ({ id, label: e.label })),
  }));

  app.post("/signup", async (req) => {
    const recent = await app.db.query(
      "SELECT COUNT(*)::int AS n FROM signup_attempts WHERE ip = $1 AND at > now() - interval '1 hour'",
      [req.ip],
    );
    if (recent.rows[0].n >= MAX_SIGNUPS_PER_HOUR) {
      throw new HttpError(429, "too_many_signups", "Too many sign-ups from this network. Try again in an hour.");
    }
    await app.db.query("INSERT INTO signup_attempts (ip) VALUES ($1)", [req.ip]);
    const body = SignupSchema.parse(req.body);

    const taken = await app.db.query("SELECT 1 FROM users WHERE lower(email) = $1", [body.email]);
    if (taken.rowCount) throw new HttpError(409, "email_taken", "An account already uses this email. Sign in instead.");

    try {
      return await withTx(app.db, async (tx) => {
        const t = await createTenant(tx, { ...body, storeName: body.storeName || body.businessName });
        await tx.query(
          `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1::uuid, $2, 'business.signup', 'tenant', $1::text, $3)`,
          [t.tenantId, t.ownerId, JSON.stringify({ businessType: body.businessType, samples: body.samples })],
        );
        await tx.query("INSERT INTO platform_audit (tenant_id, action, data) VALUES ($1, 'tenant.signup', $2)", [
          t.tenantId,
          JSON.stringify({ name: body.businessName, email: body.email, businessType: body.businessType }),
        ]);
        const token = await openAdminSession(tx, t.ownerId, t.tenantId);
        return { token, tenantId: t.tenantId, registerId: t.registerId, products: t.products };
      });
    } catch (err) {
      // Two sign-ups racing with the same email.
      if (isUniqueViolation(err, "users_email_idx")) {
        throw new HttpError(409, "email_taken", "An account already uses this email. Sign in instead.");
      }
      throw err;
    }
  });
}
