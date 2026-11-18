import { randomUUID } from "node:crypto";
import type { Db, Tx } from "./db.js";
import { hashPassword, hashPin } from "./security.js";
import { EMIRATES, TEMPLATES, type BusinessType, type Emirate } from "./templates.js";

export const TRIAL_DAYS = 14;
/** The plan a trial runs on; the business picks its real plan when the trial ends. */
export const TRIAL_PLAN = "growth";

export interface NewTenant {
  businessName: string;
  businessType: BusinessType;
  ownerName: string;
  email: string;
  password: string;
  pin: string;
  phone?: string;
  storeName: string;
  emirate: Emirate;
  trn?: string;
  samples: boolean;
}

/**
 * Creates a working business in one transaction: the tenant on a trial, one store with one
 * register, UAE VAT rates, the usual payment methods, the owner, and the categories (and
 * optionally sample products) of its business type. Ready to pair a till right away.
 */
export async function createTenant(tx: Tx, input: NewTenant) {
  const tenantId = randomUUID();
  const storeId = randomUUID();
  const registerId = randomUUID();
  const ownerId = randomUUID();
  const vatId = randomUUID();
  const zeroId = randomUUID();
  const template = TEMPLATES[input.businessType];

  await tx.query(
    `INSERT INTO tenants (id, name, plan_id, status, trial_ends_at, business_type, contact_email, contact_phone, status_changed_at)
     VALUES ($1, $2, $3, 'trial', now() + make_interval(days => $4), $5, $6, $7, now())`,
    [tenantId, input.businessName, TRIAL_PLAN, TRIAL_DAYS, input.businessType, input.email, input.phone ?? null],
  );
  await tx.query(
    `INSERT INTO stores (id, tenant_id, code, name, address, trn, receipt_footer)
     VALUES ($1, $2, $3, $4, $5, $6, 'Thank you for shopping with us | شكرا لتسوقكم معنا')`,
    [storeId, tenantId, `${EMIRATES[input.emirate].code}1`, input.storeName, `${EMIRATES[input.emirate].label}, UAE`, input.trn ?? null],
  );
  await tx.query("INSERT INTO registers (id, store_id, code, name) VALUES ($1, $2, 'R1', 'Counter 1')", [registerId, storeId]);
  await tx.query(
    `INSERT INTO taxes (id, tenant_id, name, rate_bp, price_included, kind) VALUES
       ($1, $2, 'VAT 5%', 500, true, 'standard'), ($3, $2, 'Zero-rated 0%', 0, true, 'zero'),
       ($4, $2, 'Exempt', 0, true, 'exempt')`,
    [vatId, tenantId, zeroId, randomUUID()],
  );
  await tx.query(
    `INSERT INTO payment_methods (id, tenant_id, name, kind) VALUES
       ($1, $4, 'Cash', 'cash'), ($2, $4, 'Card', 'card'), ($3, $4, 'Card (manual terminal)', 'card_manual'),
       ($5, $4, 'Gift card', 'gift_card'), ($6, $4, 'Points', 'points')`,
    [randomUUID(), randomUUID(), randomUUID(), tenantId, randomUUID(), randomUUID()],
  );
  // Points start switched off; the owner turns them on under Loyalty.
  await tx.query("INSERT INTO loyalty_settings (tenant_id) VALUES ($1)", [tenantId]);

  const pin = hashPin(input.pin);
  await tx.query(
    `INSERT INTO users (id, tenant_id, name, email, role, pin_salt, pin_hash, password_hash)
     VALUES ($1, $2, $3, $4, 'owner', $5, $6, $7)`,
    [ownerId, tenantId, input.ownerName, input.email, pin.salt, pin.hash, hashPassword(input.password)],
  );

  const categoryIds = new Map<string, string>();
  for (const [i, c] of template.categories.entries()) {
    const id = randomUUID();
    categoryIds.set(c.name, id);
    await tx.query("INSERT INTO categories (id, tenant_id, name, name_ar, sort) VALUES ($1, $2, $3, $4, $5)", [
      id,
      tenantId,
      c.name,
      c.nameAr,
      i,
    ]);
  }
  let products = 0;
  if (input.samples) {
    for (const [category, name, nameAr, price, byWeight, zeroRated] of template.samples) {
      const productId = randomUUID();
      await tx.query(
        `INSERT INTO products (id, tenant_id, category_id, name, name_ar, uom, tax_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [productId, tenantId, categoryIds.get(category), name, nameAr, byWeight ? "kg" : "unit", zeroRated ? zeroId : vatId],
      );
      await tx.query("INSERT INTO variants (id, tenant_id, product_id, price) VALUES ($1, $2, $3, $4)", [
        randomUUID(),
        tenantId,
        productId,
        price,
      ]);
      products++;
    }
  }
  return { tenantId, storeId, registerId, ownerId, categories: template.categories.length, products };
}

/** Plan limits for a business, with what it uses now. A null limit means unlimited. */
export async function planUsage(db: Db | Tx, tenantId: string) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.max_stores, p.max_registers,
            (SELECT COUNT(*)::int FROM stores s WHERE s.tenant_id = t.id) AS stores,
            (SELECT COUNT(*)::int FROM registers r JOIN stores s ON s.id = r.store_id WHERE s.tenant_id = t.id) AS registers
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
    [tenantId],
  );
  const r = rows[0];
  return {
    planId: r.id as string,
    planName: r.name as string,
    maxStores: r.max_stores as number | null,
    maxRegisters: r.max_registers as number | null,
    stores: r.stores as number,
    registers: r.registers as number,
  };
}
