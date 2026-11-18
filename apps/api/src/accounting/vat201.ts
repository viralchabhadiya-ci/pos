import { roundHalfAway } from "@pos/core";
import type { Db } from "../db.js";
import { EMIRATES, type AccountingConfig, type Emirate } from "./settings.js";

export const EMIRATE_BOX: Record<Emirate, { box: string; name: string }> = {
  AUH: { box: "1a", name: "Abu Dhabi" },
  DXB: { box: "1b", name: "Dubai" },
  SHJ: { box: "1c", name: "Sharjah" },
  AJM: { box: "1d", name: "Ajman" },
  UAQ: { box: "1e", name: "Umm Al Quwain" },
  RAK: { box: "1f", name: "Ras Al Khaimah" },
  FUJ: { box: "1g", name: "Fujairah" },
};

interface Amounts {
  amount: number;
  vat: number;
}

export interface Vat201 {
  from: string;
  to: string;
  /** Box 1a-1g: standard-rated sales by the emirate of the store that made them. */
  emirates: ({ emirate: Emirate; box: string; name: string } & Amounts)[];
  /** Standard-rated sales from stores with no emirate set; they must be assigned before filing. */
  unassigned: ({ storeId: string; storeName: string } & Amounts)[];
  box4ZeroRated: number;
  box5Exempt: number;
  box8Total: Amounts;
  /** Sales of products with no VAT type: not on the return until they are classified. */
  noVatType: number;
  /** Box 9 from goods received in the POS, at the VAT rate on the purchase order. */
  box9Purchases: Amounts & { receipts: number };
  box12TotalDue: number;
  box13Recoverable: number;
  box14Payable: number;
  /** Credit notes (refunds) included above, for the accountant's reference. */
  creditNotes: Amounts;
}

/**
 * Figures for the FTA VAT 201 return. Sales come from the bills, net of refunds made in the
 * period (credit notes reduce the period they are issued in). Input VAT only covers stock
 * received in the POS; other business expenses are added by the accountant.
 */
export async function vat201(db: Db, tenantId: string, from: string, to: string, config: AccountingConfig): Promise<Vat201> {
  const params = [tenantId, from, to];
  const [sales, fallback, purchases] = await Promise.all([
    db.query(
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE(t.kind, CASE WHEN ol.tax_rate_bp > 0 THEN 'standard' ELSE 'none' END) AS kind,
              o.refund_of_order_id IS NOT NULL AS refund,
              SUM(ol.net)::bigint AS net, SUM(ol.tax)::bigint AS vat
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
         LEFT JOIN taxes t ON t.id = ol.tax_id
        WHERE o.tenant_id = $1 AND (o.created_at AT TIME ZONE s.timezone)::date BETWEEN $2::date AND $3::date
        GROUP BY 1, 2, 3, 4`,
      params,
    ),
    db.query("SELECT emirate FROM einvoice_settings WHERE tenant_id = $1", [tenantId]),
    db.query(
      `SELECT gr.id, grl.qty, grl.unit_cost, COALESCE(pol.tax_rate_bp, 500) AS rate_bp
         FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.receipt_id
         JOIN stores s ON s.id = gr.store_id
         LEFT JOIN purchase_order_lines pol ON pol.id = grl.po_line_id
        WHERE gr.tenant_id = $1 AND (gr.received_at AT TIME ZONE s.timezone)::date BETWEEN $2::date AND $3::date`,
      params,
    ),
  ]);
  const tenantEmirate = fallback.rows[0]?.emirate as Emirate | undefined;

  const byEmirate = new Map<Emirate, Amounts>();
  const unassigned = new Map<string, { storeId: string; storeName: string } & Amounts>();
  let zero = 0;
  let exempt = 0;
  let none = 0;
  const credit: Amounts = { amount: 0, vat: 0 };
  for (const r of sales.rows) {
    const net = Number(r.net);
    const vat = Number(r.vat);
    if (r.refund) {
      credit.amount -= net;
      credit.vat -= vat;
    }
    if (r.kind === "zero") zero += net;
    else if (r.kind === "exempt") exempt += net;
    else if (r.kind === "none") none += net;
    else {
      const emirate = config.storeEmirates[r.store_id] ?? tenantEmirate;
      if (emirate && (EMIRATES as readonly string[]).includes(emirate)) {
        const e = byEmirate.get(emirate) ?? { amount: 0, vat: 0 };
        e.amount += net;
        e.vat += vat;
        byEmirate.set(emirate, e);
      } else {
        const u = unassigned.get(r.store_id) ?? { storeId: r.store_id, storeName: r.store_name, amount: 0, vat: 0 };
        u.amount += net;
        u.vat += vat;
        unassigned.set(r.store_id, u);
      }
    }
  }

  const receipts = new Set<string>();
  const box9: Amounts = { amount: 0, vat: 0 };
  for (const r of purchases.rows) {
    const amount = roundHalfAway(Number(r.qty) * r.unit_cost);
    box9.amount += amount;
    box9.vat += roundHalfAway((amount * r.rate_bp) / 10_000);
    receipts.add(r.id);
  }

  const emirates = EMIRATES.map((e) => ({ emirate: e, ...EMIRATE_BOX[e], ...(byEmirate.get(e) ?? { amount: 0, vat: 0 }) }));
  const standard = [...emirates, ...unassigned.values()].reduce((s, e) => ({ amount: s.amount + e.amount, vat: s.vat + e.vat }), { amount: 0, vat: 0 });
  const box8Total = { amount: standard.amount + zero + exempt, vat: standard.vat };
  return {
    from,
    to,
    emirates,
    unassigned: [...unassigned.values()],
    box4ZeroRated: zero,
    box5Exempt: exempt,
    box8Total,
    noVatType: none,
    box9Purchases: { ...box9, receipts: receipts.size },
    box12TotalDue: box8Total.vat,
    box13Recoverable: box9.vat,
    box14Payable: box8Total.vat - box9.vat,
    creditNotes: credit,
  };
}

/** The return as rows for a CSV the accountant can keep with the filing. */
export function vat201Rows(v: Vat201): (string | number)[][] {
  const m = (fils: number) => (fils / 100).toFixed(2);
  const rows: (string | number)[][] = v.emirates.map((e) => [e.box, `Standard rated supplies in ${e.name}`, m(e.amount), m(e.vat)]);
  for (const u of v.unassigned) rows.push(["1?", `Standard rated supplies, ${u.storeName} (emirate not set)`, m(u.amount), m(u.vat)]);
  rows.push(
    ["2", "Tax refunds provided to tourists", "0.00", "0.00"],
    ["3", "Supplies subject to the reverse charge", "0.00", "0.00"],
    ["4", "Zero rated supplies", m(v.box4ZeroRated), ""],
    ["5", "Exempt supplies", m(v.box5Exempt), ""],
    ["6", "Goods imported into the UAE", "0.00", "0.00"],
    ["7", "Adjustments to goods imported", "0.00", "0.00"],
    ["8", "Totals", m(v.box8Total.amount), m(v.box8Total.vat)],
    ["9", "Standard rated expenses (stock received in the POS)", m(v.box9Purchases.amount), m(v.box9Purchases.vat)],
    ["10", "Supplies subject to the reverse charge", "0.00", "0.00"],
    ["11", "Totals", m(v.box9Purchases.amount), m(v.box9Purchases.vat)],
    ["12", "Total value of due tax for the period", "", m(v.box12TotalDue)],
    ["13", "Total value of recoverable tax for the period", "", m(v.box13Recoverable)],
    ["14", "Payable tax for the period", "", m(v.box14Payable)],
  );
  if (v.noVatType) rows.push(["", "Sales of products with no VAT type (not included above)", m(v.noVatType), ""]);
  rows.push(["", "Credit notes (refunds) already taken off above", m(v.creditNotes.amount), m(v.creditNotes.vat)]);
  return rows;
}
