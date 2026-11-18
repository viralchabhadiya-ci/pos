import type { Db } from "../db.js";
import type { Account, AccountingConfig, AccountKey } from "./settings.js";

export type SupplyKind = "standard" | "zero" | "exempt" | "none";

/** One store's takings for one store day, summed from orders, payments and the cash drawer. */
export interface DayData {
  date: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  /** Order lines by sale/refund and VAT type. Refund amounts are negative, as stored. */
  supplies: { refund: boolean; kind: SupplyKind; rateBp: number; net: number; vat: number; lines: number }[];
  payments: { methodId: string; methodName: string; kind: string; amount: number; count: number }[];
  sales: number;
  refunds: number;
  /** Sum of order totals (net + VAT). */
  total: number;
  cashRounding: number;
  /** Counted minus expected cash for tills closed this day. */
  cashVariance: number;
  cashIn: number;
  cashOut: number;
}

export interface JournalLine {
  key: AccountKey | "method";
  account: Account;
  description: string;
  /** Fils. Debit is positive, credit negative. */
  amount: number;
  /** On revenue lines: the VAT type, and the VAT that belongs to this line (same sign as amount). */
  tax?: { kind: SupplyKind; rateBp: number; vat: number };
}

export interface Journal {
  date: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  reference: string;
  narration: string;
  lines: JournalLine[];
  /** Things the accountant should look at before posting. */
  warnings: string[];
  sales: number;
  refunds: number;
}

const SALES_ACCOUNT: Record<SupplyKind, AccountKey> = {
  standard: "salesStandard",
  zero: "salesZero",
  exempt: "salesExempt",
  none: "salesNoVat",
};
const KIND_LABEL: Record<SupplyKind, string> = {
  standard: "standard rated",
  zero: "zero rated",
  exempt: "exempt",
  none: "outside VAT",
};
const aed = (fils: number) => `AED ${(fils / 100).toFixed(2)}`;
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

/**
 * Turns a store day into a balanced journal: payments received on the debit side, sales
 * (net of VAT), VAT output and cash rounding on the credit side, refunds reversing them.
 * Anything that would leave it unbalanced goes to the rounding account with a warning.
 */
export function buildJournal(day: DayData, config: AccountingConfig): Journal {
  const acc = config.accounts;
  const lines: JournalLine[] = [];
  const warnings: string[] = [];
  const add = (line: JournalLine) => {
    if (line.amount !== 0) lines.push(line);
  };

  for (const p of day.payments) {
    const own = config.methodAccounts[p.methodId];
    const key: AccountKey = p.kind === "cash" ? "cash" : p.kind === "card" || p.kind === "card_manual" ? "card" : "otherPayments";
    add({ key: own ? "method" : key, account: own ?? acc[key], description: `${p.methodName} takings`, amount: p.amount });
  }

  let vat = 0;
  for (const s of day.supplies) {
    const label = s.kind === "standard" ? `${KIND_LABEL[s.kind]} ${pct(s.rateBp)}` : KIND_LABEL[s.kind];
    add({
      key: s.refund ? "returns" : SALES_ACCOUNT[s.kind],
      account: s.refund ? acc.returns : acc[SALES_ACCOUNT[s.kind]],
      description: s.refund ? `Refunds, ${label}` : `Sales, ${label}`,
      amount: -s.net,
      tax: { kind: s.kind, rateBp: s.rateBp, vat: -s.vat },
    });
    vat += s.vat;
    if (s.kind === "none" && !s.refund) warnings.push(`${aed(s.net)} of sales were for products with no VAT type set.`);
  }
  add({ key: "vatOutput", account: acc.vatOutput, description: "VAT on sales less refunds", amount: -vat });
  add({ key: "rounding", account: acc.rounding, description: "Cash rounding", amount: -day.cashRounding });

  if (day.cashIn) add({ key: "cash", account: acc.cash, description: "Cash paid in", amount: day.cashIn });
  if (day.cashIn) add({ key: "cashMovements", account: acc.cashMovements, description: "Cash paid in", amount: -day.cashIn });
  if (day.cashOut) add({ key: "cash", account: acc.cash, description: "Cash paid out", amount: -day.cashOut });
  if (day.cashOut) add({ key: "cashMovements", account: acc.cashMovements, description: "Cash paid out", amount: day.cashOut });
  if (day.cashVariance) {
    const d = day.cashVariance > 0 ? "Cash over at till close" : "Cash short at till close";
    add({ key: "cash", account: acc.cash, description: d, amount: day.cashVariance });
    add({ key: "overShort", account: acc.overShort, description: d, amount: -day.cashVariance });
  }

  const off = lines.reduce((n, l) => n + l.amount, 0);
  if (off !== 0) {
    add({ key: "rounding", account: acc.rounding, description: "Payments not matching bill totals", amount: -off });
    warnings.push(`Payments and bill totals differ by ${aed(Math.abs(off))}; posted to ${acc.rounding.name}. Check the day's bills.`);
  }

  const compact = day.date.replaceAll("-", "");
  return {
    date: day.date,
    storeId: day.storeId,
    storeCode: day.storeCode,
    storeName: day.storeName,
    reference: `POS-${day.storeCode}-${compact}`,
    narration: `POS takings ${day.storeName} ${day.date}`,
    lines,
    warnings,
    sales: day.sales,
    refunds: day.refunds,
  };
}

/** Store-local day of a timestamp column. */
const DAY = (col: string) => `to_char((${col} AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD')`;
const IN_RANGE = (col: string) =>
  `s.tenant_id = $1 AND ($2::uuid IS NULL OR s.id = $2) AND (${col} AT TIME ZONE s.timezone)::date BETWEEN $3::date AND $4::date`;

/** Loads every store day with activity in the range, oldest first. */
export async function loadDays(db: Db, tenantId: string, from: string, to: string, storeId: string | null): Promise<DayData[]> {
  const params = [tenantId, storeId, from, to];
  const [supplies, payments, orders, closes, moves] = await Promise.all([
    db.query(
      `SELECT o.store_id, ${DAY("o.created_at")} AS day, o.refund_of_order_id IS NOT NULL AS refund,
              COALESCE(t.kind, CASE WHEN ol.tax_rate_bp > 0 THEN 'standard' ELSE 'none' END) AS kind,
              COALESCE(ol.tax_rate_bp, 0)::int AS rate_bp, SUM(ol.net)::bigint AS net, SUM(ol.tax)::bigint AS vat,
              COUNT(*)::int AS lines
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN stores s ON s.id = o.store_id
         LEFT JOIN taxes t ON t.id = ol.tax_id
        WHERE ${IN_RANGE("o.created_at")}
        GROUP BY 1, 2, 3, 4, 5 ORDER BY 3, 5 DESC, 4`,
      params,
    ),
    db.query(
      `SELECT o.store_id, ${DAY("o.created_at")} AS day, m.id AS method_id, m.name AS method_name, m.kind,
              SUM(p.amount)::bigint AS amount, COUNT(*)::int AS count
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN stores s ON s.id = o.store_id
         JOIN payment_methods m ON m.id = p.method_id
        WHERE ${IN_RANGE("o.created_at")}
        GROUP BY 1, 2, 3, 4, 5 ORDER BY m.kind, m.name`,
      params,
    ),
    db.query(
      `SELECT o.store_id, ${DAY("o.created_at")} AS day,
              COUNT(*) FILTER (WHERE o.refund_of_order_id IS NULL)::int AS sales,
              COUNT(*) FILTER (WHERE o.refund_of_order_id IS NOT NULL)::int AS refunds,
              SUM(o.total)::bigint AS total, SUM(o.cash_rounding)::bigint AS rounding
         FROM orders o JOIN stores s ON s.id = o.store_id
        WHERE ${IN_RANGE("o.created_at")}
        GROUP BY 1, 2`,
      params,
    ),
    db.query(
      `SELECT r.store_id, ${DAY("se.closed_at")} AS day,
              SUM(se.closing_cash_counted - se.expected_cash)::bigint AS variance
         FROM sessions se JOIN registers r ON r.id = se.register_id JOIN stores s ON s.id = r.store_id
        WHERE se.state = 'closed' AND se.closing_cash_counted IS NOT NULL AND se.expected_cash IS NOT NULL
          AND ${IN_RANGE("se.closed_at")}
        GROUP BY 1, 2`,
      params,
    ),
    db.query(
      `SELECT r.store_id, ${DAY("cm.at")} AS day,
              COALESCE(SUM(cm.amount) FILTER (WHERE cm.kind = 'in'), 0)::bigint AS cash_in,
              COALESCE(SUM(cm.amount) FILTER (WHERE cm.kind = 'out'), 0)::bigint AS cash_out
         FROM cash_moves cm JOIN sessions se ON se.id = cm.session_id JOIN registers r ON r.id = se.register_id
         JOIN stores s ON s.id = r.store_id
        WHERE ${IN_RANGE("cm.at")}
        GROUP BY 1, 2`,
      params,
    ),
  ]);
  const stores = await db.query("SELECT id, code, name FROM stores WHERE tenant_id = $1", [tenantId]);
  const storeById = new Map(stores.rows.map((s) => [s.id as string, s]));

  const days = new Map<string, DayData>();
  const get = (store: string, day: string): DayData => {
    const key = `${day}|${store}`;
    let d = days.get(key);
    if (!d) {
      const s = storeById.get(store);
      d = {
        date: day,
        storeId: store,
        storeCode: s?.code ?? "STORE",
        storeName: s?.name ?? "Store",
        supplies: [],
        payments: [],
        sales: 0,
        refunds: 0,
        total: 0,
        cashRounding: 0,
        cashVariance: 0,
        cashIn: 0,
        cashOut: 0,
      };
      days.set(key, d);
    }
    return d;
  };
  for (const r of supplies.rows) {
    get(r.store_id, r.day).supplies.push({
      refund: r.refund,
      kind: r.kind,
      rateBp: r.rate_bp,
      net: Number(r.net),
      vat: Number(r.vat),
      lines: r.lines,
    });
  }
  for (const r of payments.rows) {
    get(r.store_id, r.day).payments.push({
      methodId: r.method_id,
      methodName: r.method_name,
      kind: r.kind,
      amount: Number(r.amount),
      count: r.count,
    });
  }
  for (const r of orders.rows) {
    const d = get(r.store_id, r.day);
    d.sales = r.sales;
    d.refunds = r.refunds;
    d.total = Number(r.total);
    d.cashRounding = Number(r.rounding);
  }
  for (const r of closes.rows) get(r.store_id, r.day).cashVariance = Number(r.variance);
  for (const r of moves.rows) {
    const d = get(r.store_id, r.day);
    d.cashIn = Number(r.cash_in);
    d.cashOut = Number(r.cash_out);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.storeCode.localeCompare(b.storeCode));
}
