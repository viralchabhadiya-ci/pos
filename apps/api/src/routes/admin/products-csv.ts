import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTx } from "../../db.js";
import { HttpError } from "../../errors.js";
import { money, parseCsv, parseMoney, toCsv } from "../../csv.js";
import { ProductSchema, saveProduct, uniqueToBarcode, type ProductInput } from "./catalog.js";
import { adminAudit } from "./common.js";

export const PRODUCT_COLUMNS = [
  "name",
  "name_ar",
  "category",
  "barcode",
  "extra_barcodes",
  "sku",
  "price",
  "cost",
  "vat",
  "unit",
  "reorder_level",
  "active",
] as const;

const ImportSchema = z.object({
  csv: z.string().max(5_000_000),
  /** true checks the file and reports what would change, without saving anything. */
  dryRun: z.boolean().default(true),
});

const MAX_ROWS = 5000;

interface RowError {
  row: number;
  message: string;
}

/** Undo the apostrophe our export puts in front of formula-like text. */
const unescape = (s: string) => s.trim().replace(/^'(?=[=+@\-\t])/, "");

export async function productCsvRoutes(app: FastifyInstance) {
  app.get("/products/export.csv", async (req, reply) => {
    const ctx = await app.authAdmin(req);
    const { rows } = await app.db.query(
      `SELECT p.name, p.name_ar, c.name AS category, v.barcode, v.extra_barcodes, v.sku, v.price, v.cost, t.name AS vat,
              p.uom, v.reorder_level, p.active
         FROM products p
         JOIN LATERAL (SELECT * FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) v ON true
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN taxes t ON t.id = p.tax_id
        WHERE p.tenant_id = $1 ORDER BY c.sort NULLS LAST, p.name`,
      [ctx.tenantId],
    );
    const csv = toCsv(
      [...PRODUCT_COLUMNS],
      rows.map((r) => [
        r.name,
        r.name_ar,
        r.category,
        r.barcode,
        r.extra_barcodes.join("|"),
        r.sku,
        money(r.price),
        money(r.cost),
        r.vat,
        r.uom,
        r.reorder_level,
        r.active ? "yes" : "no",
      ]),
    );
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="products.csv"')
      .send(csv);
  });

  /**
   * Adds or updates products from a spreadsheet. A row matches an existing product by barcode,
   * then by SKU; otherwise it is new. Unknown categories are created. Nothing is saved when any
   * row has a problem, so a half-imported price list never reaches the tills.
   */
  app.post("/products/import", { bodyLimit: 6_000_000 }, async (req) => {
    const ctx = await app.authAdmin(req);
    const { csv, dryRun } = ImportSchema.parse(req.body);
    const table = parseCsv(csv);
    if (table.length < 2) throw new HttpError(400, "bad_request", "The file has no product rows");
    if (table.length - 1 > MAX_ROWS) throw new HttpError(400, "bad_request", `Import at most ${MAX_ROWS} products at a time`);
    const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = (name: string) => header.indexOf(name);
    for (const required of ["name", "price"]) {
      if (col(required) < 0) throw new HttpError(400, "bad_request", `The file needs a "${required}" column`);
    }

    const [taxes, categories, existing] = await Promise.all([
      app.db.query("SELECT id, name, kind FROM taxes WHERE tenant_id = $1 AND active", [ctx.tenantId]),
      app.db.query("SELECT id, name FROM categories WHERE tenant_id = $1", [ctx.tenantId]),
      app.db.query(
        `SELECT p.id, p.name_ar AS "nameAr", p.category_id AS "categoryId", p.uom, p.tax_id AS "taxId", p.active,
                v.barcode, v.sku, v.extra_barcodes AS "extraBarcodes", v.cost, v.reorder_level AS "reorderLevel"
           FROM products p JOIN variants v ON v.product_id = p.id WHERE p.tenant_id = $1`,
        [ctx.tenantId],
      ),
    ]);
    const taxByName = new Map(taxes.rows.map((t) => [t.name.toLowerCase(), t.id as string]));
    for (const t of taxes.rows) if (!taxByName.has(t.kind)) taxByName.set(t.kind, t.id);
    const defaultTax = taxes.rows.find((t) => t.kind === "standard")?.id ?? null;
    const categoryByName = new Map(categories.rows.map((c) => [c.name.toLowerCase(), c.id as string]));
    const byBarcode = new Map<string, string>();
    const bySku = new Map<string, string>();
    const current = new Map(existing.rows.map((r) => [r.id as string, r]));
    for (const r of existing.rows) {
      if (r.barcode) byBarcode.set(r.barcode, r.id);
      for (const b of r.extraBarcodes) byBarcode.set(b, r.id);
      if (r.sku) bySku.set(r.sku.toLowerCase(), r.id);
    }

    const errors: RowError[] = [];
    const plan: { row: number; id: string | null; body: ProductInput; category?: string | null }[] = [];
    const has = (name: string) => col(name) >= 0;
    const seenIds = new Set<string>();
    table.slice(1).forEach((cells, i) => {
      const row = i + 2; // spreadsheet row number, counting the header
      const get = (name: string) => (col(name) >= 0 ? unescape(cells[col(name)] ?? "") : "");
      const fail = (message: string) => errors.push({ row, message });

      const price = parseMoney(get("price"));
      if (price === null) return fail(`Price "${get("price")}" is not an amount like 2.50`);
      const costText = get("cost");
      const cost = costText ? parseMoney(costText) : null;
      if (costText && cost === null) return fail(`Cost "${costText}" is not an amount like 1.20`);
      const vatText = get("vat").toLowerCase();
      const taxId = vatText ? taxByName.get(vatText) : defaultTax;
      if (vatText && !taxId) return fail(`VAT "${get("vat")}" is not one of: ${taxes.rows.map((t) => t.name).join(", ")}`);
      const unit = get("unit").toLowerCase() || "unit";
      if (!["unit", "kg"].includes(unit)) return fail(`Unit must be "unit" or "kg"`);
      const levelText = get("reorder_level");
      const reorderLevel = levelText ? Number(levelText) : null;
      if (levelText && !(Number.isFinite(reorderLevel) && reorderLevel! >= 0)) return fail(`Reorder level "${levelText}" is not a number`);
      const activeText = get("active").toLowerCase();
      if (activeText && !["yes", "no", "true", "false", "1", "0"].includes(activeText)) return fail(`Active must be yes or no`);

      const parsed = ProductSchema.safeParse({
        name: get("name"),
        nameAr: get("name_ar") || null,
        uom: unit,
        taxId,
        price,
        cost,
        barcode: get("barcode") || null,
        extraBarcodes: get("extra_barcodes")
          .split("|")
          .map((b) => b.trim())
          .filter(Boolean),
        sku: get("sku") || null,
        reorderLevel,
        active: !["no", "false", "0"].includes(activeText),
      });
      if (!parsed.success) return fail(parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; "));
      const body = parsed.data;
      const id = (body.barcode && byBarcode.get(body.barcode)) || (body.sku && bySku.get(body.sku.toLowerCase())) || null;
      let category: string | null | undefined = get("category") || null;
      if (id) {
        if (seenIds.has(id)) return fail("Another row in this file updates the same product");
        seenIds.add(id);
        // A column left out of the file keeps what the product already has.
        const cur = current.get(id)!;
        if (!has("name_ar")) body.nameAr = cur.nameAr;
        if (!has("unit")) body.uom = cur.uom;
        if (!has("vat")) body.taxId = cur.taxId;
        if (!has("cost")) body.cost = cur.cost;
        if (!has("barcode")) body.barcode = cur.barcode;
        if (!has("extra_barcodes")) body.extraBarcodes = cur.extraBarcodes;
        if (!has("sku")) body.sku = cur.sku;
        if (!has("reorder_level")) body.reorderLevel = cur.reorderLevel;
        if (!has("active")) body.active = cur.active;
        if (!has("category")) {
          category = undefined;
          body.categoryId = cur.categoryId;
        }
      }
      plan.push({ row, id, body, category });
    });

    const summary = {
      rows: table.length - 1,
      create: plan.filter((p) => !p.id).length,
      update: plan.filter((p) => p.id).length,
      newCategories: [...new Set(plan.map((p) => p.category).filter((c): c is string => !!c && !categoryByName.has(c.toLowerCase())))],
      errors,
    };
    if (errors.length || dryRun) return { ...summary, saved: false };

    await withTx(app.db, async (tx) => {
      for (const name of summary.newCategories) {
        const id = randomUUID();
        await tx.query("INSERT INTO categories (id, tenant_id, name) VALUES ($1, $2, $3)", [id, ctx.tenantId, name]);
        categoryByName.set(name.toLowerCase(), id);
      }
      for (const p of plan) {
        const body =
          p.category === undefined ? p.body : { ...p.body, categoryId: p.category ? categoryByName.get(p.category.toLowerCase()) : null };
        try {
          await tx.query(`SAVEPOINT r`);
          await saveProduct(tx, ctx, p.id, body, "import");
        } catch (err) {
          await tx.query(`ROLLBACK TO SAVEPOINT r`);
          try {
            uniqueToBarcode(err);
          } catch (e) {
            errors.push({ row: p.row, message: (e as Error).message });
          }
        }
      }
      if (errors.length) throw new ImportFailed();
      await adminAudit(tx, ctx, "product.import", "product", "-", { create: summary.create, update: summary.update });
    }).catch((err) => {
      if (!(err instanceof ImportFailed)) throw err;
    });
    return { ...summary, errors, saved: errors.length === 0 };
  });
}

class ImportFailed extends Error {}
