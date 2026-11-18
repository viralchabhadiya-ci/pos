import { randomUUID } from "node:crypto";
import { withTx, type Db } from "./db.js";
import { hashPassword, hashPin, newPairingCode } from "./security.js";

export interface SeedResult {
  tenantId: string;
  storeId: string;
  registerId: string;
  cashierId: string;
  managerId: string;
  ownerId: string;
  /** Back office sign-in for the owner. */
  ownerEmail: string;
  ownerPassword: string;
  vatId: string;
  cashMethodId: string;
  cardMethodId: string;
  giftCardMethodId: string;
  pointsMethodId: string;
  variants: { id: string; name: string; price: number; barcode: string }[];
}

const PRODUCTS: [category: string, name: string, nameAr: string, price: number, barcode: string, uom?: "kg"][] = [
  ["Beverages", "Al Ain Water 1.5L", "مياه العين 1.5 لتر", 150, "6291003000014"],
  ["Beverages", "Masafi Water 500ml", "مسافي مياه 500 مل", 100, "6291003000021"],
  ["Beverages", "Coca-Cola 330ml", "كوكا كولا 330 مل", 250, "5449000000996"],
  ["Beverages", "Lipton Iced Tea 320ml", "ليبتون شاي مثلج", 300, "8712100000017"],
  ["Dairy", "Al Rawabi Milk 1L", "حليب الروابي 1 لتر", 650, "6291003000038"],
  ["Dairy", "Laban Up 180ml", "لبن أب 180 مل", 175, "6291003000045"],
  ["Dairy", "Puck Cream Cheese 240g", "جبنة بوك 240 غ", 1450, "5701000000013"],
  ["Bakery", "Arabic Bread (6 pcs)", "خبز عربي 6 حبات", 300, "6291003000052"],
  ["Bakery", "Croissant", "كرواسون", 450, "6291003000069"],
  ["Snacks", "Lays Salt 48g", "ليز ملح 48 غ", 350, "6281000000014"],
  ["Snacks", "Oman Chips 15g", "شيبس عمان 15 غ", 100, "6291003000076"],
  ["Fresh", "Bananas (per kg)", "موز (للكيلو)", 795, "2100001000000", "kg"],
  ["Fresh", "Tomatoes (per kg)", "طماطم (للكيلو)", 550, "2100002000000", "kg"],
  ["Household", "Fine Tissues 200", "مناديل فاين 200", 895, "6281000000021"],
];

/** Demo data for a Dubai minimart: one store, one register, VAT 5% included in prices. */
export async function seed(
  db: Db,
  opts: {
    cashierPin?: string;
    managerPin?: string;
    ownerPin?: string;
    ownerEmail?: string;
    ownerPassword?: string;
    /** A demo customer with points and a demo gift card, for trying the till by hand. */
    demoCustomers?: boolean;
  } = {},
): Promise<SeedResult> {
  return withTx(db, async (tx) => {
    const tenantId = randomUUID();
    const storeId = randomUUID();
    const registerId = randomUUID();
    const vatId = randomUUID();
    const cashierId = randomUUID();
    const managerId = randomUUID();
    const ownerId = randomUUID();
    const cashMethodId = randomUUID();
    const cardMethodId = randomUUID();
    const manualCardId = randomUUID();
    const giftCardMethodId = randomUUID();
    const pointsMethodId = randomUUID();

    await tx.query("INSERT INTO tenants (id, name) VALUES ($1, 'Demo Minimart LLC')", [tenantId]);
    await tx.query(
      `INSERT INTO stores (id, tenant_id, code, name, name_ar, address, trn, receipt_footer)
       VALUES ($1, $2, 'DXB1', 'Demo Minimart Al Barsha', 'ميني ماركت ديمو البرشاء', 'Al Barsha 1, Dubai, UAE',
               '100000000000003', 'Thank you for shopping with us | شكرا لتسوقكم معنا')`,
      [storeId, tenantId],
    );
    await tx.query("INSERT INTO registers (id, store_id, code, name) VALUES ($1, $2, 'R1', 'Counter 1')", [
      registerId,
      storeId,
    ]);
    await tx.query(
      `INSERT INTO taxes (id, tenant_id, name, rate_bp, price_included, kind) VALUES
         ($1, $2, 'VAT 5%', 500, true, 'standard'), ($3, $2, 'Zero-rated 0%', 0, true, 'zero'),
         ($4, $2, 'Exempt', 0, true, 'exempt')`,
      [vatId, tenantId, randomUUID(), randomUUID()],
    );

    const cashier = hashPin(opts.cashierPin ?? "1234");
    const manager = hashPin(opts.managerPin ?? "9999");
    await tx.query(
      `INSERT INTO users (id, tenant_id, name, role, pin_salt, pin_hash) VALUES
         ($1, $3, 'Aisha (Cashier)', 'cashier', $4, $5), ($2, $3, 'Rahul (Manager)', 'manager', $6, $7)`,
      [cashierId, managerId, tenantId, cashier.salt, cashier.hash, manager.salt, manager.hash],
    );
    // Emails are unique across businesses, so a second demo seed gets its own address.
    let ownerEmail = opts.ownerEmail ?? "owner@demo.ae";
    const taken = await tx.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [ownerEmail]);
    if (taken.rowCount) ownerEmail = ownerEmail.replace("@", `+${tenantId.slice(0, 8)}@`);
    const ownerPassword = opts.ownerPassword ?? "demo1234";
    const owner = hashPin(opts.ownerPin ?? "7777");
    await tx.query(
      `INSERT INTO users (id, tenant_id, name, email, role, pin_salt, pin_hash, password_hash)
       VALUES ($1, $2, 'Omar (Owner)', $3, 'owner', $4, $5, $6)`,
      [ownerId, tenantId, ownerEmail, owner.salt, owner.hash, hashPassword(ownerPassword)],
    );
    await tx.query(
      `INSERT INTO payment_methods (id, tenant_id, name, kind) VALUES
         ($1, $4, 'Cash', 'cash'), ($2, $4, 'Card', 'card'), ($3, $4, 'Card (manual terminal)', 'card_manual'),
         ($5, $4, 'Gift card', 'gift_card'), ($6, $4, 'Points', 'points')`,
      [cashMethodId, cardMethodId, manualCardId, tenantId, giftCardMethodId, pointsMethodId],
    );
    // Points on: 1 point per AED 1 spent, 100 points pay AED 1.
    await tx.query("INSERT INTO loyalty_settings (tenant_id, enabled) VALUES ($1, true)", [tenantId]);
    await tx.query("INSERT INTO scale_settings (tenant_id) VALUES ($1)", [tenantId]);

    const categoryIds = new Map<string, string>();
    let sort = 0;
    for (const [category] of PRODUCTS) {
      if (categoryIds.has(category)) continue;
      const id = randomUUID();
      categoryIds.set(category, id);
      await tx.query("INSERT INTO categories (id, tenant_id, name, sort) VALUES ($1, $2, $3, $4)", [
        id,
        tenantId,
        category,
        sort++,
      ]);
    }

    const variants: SeedResult["variants"] = [];
    for (const [category, name, nameAr, price, barcode, uom] of PRODUCTS) {
      const productId = randomUUID();
      const variantId = randomUUID();
      await tx.query(
        `INSERT INTO products (id, tenant_id, category_id, name, name_ar, uom, tax_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [productId, tenantId, categoryIds.get(category), name, nameAr, uom ?? "unit", vatId],
      );
      await tx.query(
        "INSERT INTO variants (id, tenant_id, product_id, barcode, price, plu) VALUES ($1, $2, $3, $4, $5, $6)",
        // Fresh produce sold by the kg has an item code on the scale: 1 for bananas, 2 for tomatoes.
        [variantId, tenantId, productId, barcode, price, uom === "kg" ? String(Number(barcode.slice(2, 7))) : null],
      );
      variants.push({ id: variantId, name, price, barcode });
    }

    if (opts.demoCustomers) {
      const customerId = randomUUID();
      await tx.query("INSERT INTO customers (id, tenant_id, name, phone, points) VALUES ($1, $2, 'Fatima Al Mansoori', '0501234567', 2500)", [
        customerId,
        tenantId,
      ]);
      await tx.query("INSERT INTO loyalty_moves (tenant_id, customer_id, points, kind, note) VALUES ($1, $2, 2500, 'adjust', 'Welcome points')", [
        tenantId,
        customerId,
      ]);
      const card = await tx.query(
        "INSERT INTO gift_cards (tenant_id, code, balance, loaded, note) VALUES ($1, 'GIFT-DEMO-100', 10000, 10000, 'Demo card') RETURNING id",
        [tenantId],
      );
      await tx.query("INSERT INTO gift_card_moves (tenant_id, gift_card_id, amount, kind, note) VALUES ($1, $2, 10000, 'issue', 'Demo card')", [
        tenantId,
        card.rows[0].id,
      ]);
    }

    return {
      tenantId,
      storeId,
      registerId,
      cashierId,
      managerId,
      ownerId,
      ownerEmail,
      ownerPassword,
      vatId,
      cashMethodId,
      cardMethodId,
      giftCardMethodId,
      pointsMethodId,
      variants,
    };
  });
}

export async function createPairingCode(db: Db, registerId: string, role: "till" | "display" = "till") {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newPairingCode();
    const res = await db.query(
      `INSERT INTO pairing_codes (code, register_id, role, expires_at)
       VALUES ($1, $2, $3, now() + interval '15 minutes') ON CONFLICT (code) DO NOTHING`,
      [code, registerId, role],
    );
    if (res.rowCount) return code;
  }
  throw new Error("Could not create a unique pairing code");
}
