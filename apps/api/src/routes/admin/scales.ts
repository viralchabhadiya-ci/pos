import { DEFAULT_SCALE_RULES, scaleRuleProblem, type ScaleBarcodeRule } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import { adminAudit } from "./common.js";

const RuleSchema = z.object({
  prefix: z.string().trim(),
  kind: z.enum(["weight", "price"]),
  pluLength: z.number().int(),
});
const SettingsSchema = z.object({ rules: z.array(RuleSchema).max(6) });

/** How the business's scales print barcodes. Tills pick the rules up with the catalog. */
export async function scaleRoutes(app: FastifyInstance) {
  app.get("/scales", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query("SELECT rules FROM scale_settings WHERE tenant_id = $1", [ctx.tenantId]);
    const codes = await app.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM variants WHERE tenant_id = $1 AND plu IS NOT NULL", [
      ctx.tenantId,
    ]);
    return { rules: (rows[0]?.rules as ScaleBarcodeRule[] | undefined) ?? DEFAULT_SCALE_RULES, productsWithCode: codes.rows[0]!.n };
  });

  app.put("/scales", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rules } = SettingsSchema.parse(req.body);
    rules.forEach((r, i) => {
      const problem = scaleRuleProblem(r);
      if (problem) throw new HttpError(400, "bad_rule", `Rule ${i + 1}: ${problem}`);
    });
    const prefixes = rules.map((r) => r.prefix);
    if (new Set(prefixes).size !== prefixes.length) throw new HttpError(400, "bad_rule", "Two rules use the same prefix");
    await app.db.query(
      `INSERT INTO scale_settings (tenant_id, rules, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE SET rules = EXCLUDED.rules, updated_at = now()`,
      [ctx.tenantId, JSON.stringify(rules)],
    );
    await adminAudit(app.db, ctx, "scales.update", "scales", ctx.tenantId, { rules: rules.map((r) => `${r.prefix} ${r.kind} ${r.pluLength}`).join(", ") });
    return { rules };
  });
}
