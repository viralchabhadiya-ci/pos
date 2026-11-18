import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FILE_PREFIX, FORMATS, JOURNAL_FORMATS, renderExport } from "../../accounting/formats.js";
import { buildJournal, loadDays } from "../../accounting/journal.js";
import { ConfigSchema, DEFAULT_CONFIG, loadConfig } from "../../accounting/settings.js";
import { vat201, vat201Rows } from "../../accounting/vat201.js";
import { toCsv } from "../../csv.js";
import { badRequest } from "../../errors.js";
import { adminAudit, forbidden } from "./common.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
const RangeSchema = z.object({ from: Day, to: Day, storeId: z.string().uuid().optional() });
const ExportSchema = RangeSchema.extend({ format: z.enum(FORMATS) });
const VatSchema = z.object({ from: Day, to: Day, format: z.enum(["json", "csv"]).default("json") });

/** A year and a bit, so a typo in the year does not scan the whole history. */
const MAX_DAYS = 400;

function checkRange(q: { from: string; to: string }) {
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
  if (Number.isNaN(days)) throw badRequest("Use dates like 2026-01-31");
  if (days < 0) throw badRequest("The start date is after the end date");
  if (days > MAX_DAYS) throw badRequest(`Pick at most ${MAX_DAYS} days`);
}

/** Daily journals for the books, exports for Xero, QuickBooks and Zoho Books, and the VAT 201 figures. */
export async function accountingRoutes(app: FastifyInstance) {
  app.get("/accounting/settings", async (req) => {
    const ctx = await app.authAdmin(req);
    const [{ config, saved }, methods, stores, einv] = await Promise.all([
      loadConfig(app.db, ctx.tenantId),
      app.db.query(`SELECT id, name, kind, active FROM payment_methods WHERE tenant_id = $1 ORDER BY active DESC, kind, name`, [ctx.tenantId]),
      app.db.query(`SELECT id, code, name FROM stores WHERE tenant_id = $1 ORDER BY code`, [ctx.tenantId]),
      app.db.query(`SELECT emirate FROM einvoice_settings WHERE tenant_id = $1`, [ctx.tenantId]),
    ]);
    return {
      config,
      saved,
      defaults: DEFAULT_CONFIG,
      methods: methods.rows,
      stores: stores.rows,
      einvoicingEmirate: einv.rows[0]?.emirate ?? null,
    };
  });

  app.put("/accounting/settings", async (req) => {
    const ctx = await app.authAdmin(req);
    if (ctx.role !== "owner") throw forbidden("Only the owner can change the accounts");
    const config = ConfigSchema.parse(req.body);
    // Only this business's own methods and stores may be mapped.
    const [methods, stores] = await Promise.all([
      app.db.query("SELECT id FROM payment_methods WHERE tenant_id = $1", [ctx.tenantId]),
      app.db.query("SELECT id FROM stores WHERE tenant_id = $1", [ctx.tenantId]),
    ]);
    const methodIds = new Set(methods.rows.map((r) => r.id));
    const storeIds = new Set(stores.rows.map((r) => r.id));
    if (Object.keys(config.methodAccounts).some((id) => !methodIds.has(id))) throw badRequest("Unknown payment method");
    if (Object.keys(config.storeEmirates).some((id) => !storeIds.has(id))) throw badRequest("Unknown store");
    await app.db.query(
      `INSERT INTO accounting_settings (tenant_id, config) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET config = $2, updated_at = now()`,
      [ctx.tenantId, JSON.stringify(config)],
    );
    await adminAudit(app.db, ctx, "accounting.settings", "accounting", ctx.tenantId, {});
    return { config, saved: true };
  });

  app.get("/accounting/journals", async (req) => {
    const ctx = await app.authAdmin(req);
    const q = RangeSchema.parse(req.query);
    checkRange(q);
    const { config, saved } = await loadConfig(app.db, ctx.tenantId);
    const journals = (await loadDays(app.db, ctx.tenantId, q.from, q.to, q.storeId ?? null)).map((d) => buildJournal(d, config));
    let debit = 0;
    let credit = 0;
    for (const j of journals) {
      for (const l of j.lines) {
        if (l.amount > 0) debit += l.amount;
        else credit -= l.amount;
      }
    }
    const exported = await app.db.query(
      `SELECT e.format, e.from_date::text AS "from", e.to_date::text AS "to", e.created_at AS "at", u.name AS "by"
         FROM accounting_exports e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.tenant_id = $1 AND e.from_date <= $3::date AND e.to_date >= $2::date
          AND (e.store_id IS NULL OR $4::uuid IS NULL OR e.store_id = $4)
        ORDER BY e.created_at DESC LIMIT 5`,
      [ctx.tenantId, q.from, q.to, q.storeId ?? null],
    );
    return { from: q.from, to: q.to, configured: saved, journals, totals: { debit, credit }, overlapping: exported.rows };
  });

  app.get("/accounting/export", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = ExportSchema.parse(req.query);
    checkRange(q);
    const { config } = await loadConfig(app.db, ctx.tenantId);
    const days = await loadDays(app.db, ctx.tenantId, q.from, q.to, q.storeId ?? null);
    const journals = days.map((d) => buildJournal(d, config));
    const table = renderExport(q.format, days, journals, config);
    if (JOURNAL_FORMATS.includes(q.format)) {
      await app.db.query(
        `INSERT INTO accounting_exports (id, tenant_id, user_id, format, store_id, from_date, to_date, journals)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), ctx.tenantId, ctx.userId, q.format, q.storeId ?? null, q.from, q.to, journals.length],
      );
      await adminAudit(app.db, ctx, "accounting.export", "accounting", ctx.tenantId, {
        format: q.format,
        from: q.from,
        to: q.to,
        storeId: q.storeId ?? null,
        journals: journals.length,
      });
    }
    const csv = toCsv(table.header, table.rows, { bom: table.bom });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${FILE_PREFIX[q.format]}-${q.from}-to-${q.to}.csv"`)
      .send(csv);
  });

  app.get("/accounting/exports", async (req) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT e.id, e.format, e.from_date::text AS "from", e.to_date::text AS "to", e.journals, e.created_at AS "at",
              u.name AS "by", s.name AS "storeName"
         FROM accounting_exports e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN stores s ON s.id = e.store_id
        WHERE e.tenant_id = $1 ORDER BY e.created_at DESC LIMIT 20`,
      [ctx.tenantId],
    );
    return { exports: rows };
  });

  app.get("/accounting/vat-return", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const q = VatSchema.parse(req.query);
    checkRange(q);
    const { config } = await loadConfig(app.db, ctx.tenantId);
    const v = await vat201(app.db, ctx.tenantId, q.from, q.to, config);
    if (q.format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="vat-return-${q.from}-to-${q.to}.csv"`)
        .send(toCsv(["Box", "Description", "Amount (AED)", "VAT (AED)"], vat201Rows(v)));
    }
    return v;
  });
}
