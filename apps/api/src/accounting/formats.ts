import { roundHalfAway } from "@pos/core";
import type { DayData, Journal } from "./journal.js";
import type { AccountingConfig } from "./settings.js";

export const FORMATS = ["generic", "xero", "quickbooks", "zoho", "sales", "vat", "payments"] as const;
export type ExportFormat = (typeof FORMATS)[number];

/** Journal formats post to the books; the others are plain day-by-day listings. */
export const JOURNAL_FORMATS: ExportFormat[] = ["generic", "xero", "quickbooks", "zoho"];

export interface Table {
  header: string[];
  rows: (string | number)[][];
  /** Accounting tools read the header row by name; a BOM in front of it can break that. */
  bom: boolean;
}

const m = (fils: number) => (fils / 100).toFixed(2);
const blankIfZero = (fils: number) => (fils ? m(fils) : "");

export function formatDate(ymd: string, format: AccountingConfig["dateFormat"]): string {
  const [y, mo, d] = ymd.split("-");
  if (format === "dd/mm/yyyy") return `${d}/${mo}/${y}`;
  if (format === "mm/dd/yyyy") return `${mo}/${d}/${y}`;
  return ymd;
}

/** Debit and credit columns, which every tool and spreadsheet understands. */
function generic(journals: Journal[]): Table {
  const rows = journals.flatMap((j) =>
    j.lines.map((l) => [
      j.date,
      j.reference,
      j.storeName,
      l.account.code,
      l.account.name,
      l.description,
      l.amount > 0 ? m(l.amount) : "",
      l.amount < 0 ? m(-l.amount) : "",
      l.tax ? (l.tax.rateBp / 100).toFixed(2) : "",
    ]),
  );
  return {
    header: ["Date", "Journal", "Store", "Account code", "Account name", "Description", "Debit", "Credit", "VAT rate %"],
    rows,
    bom: true,
  };
}

/**
 * Xero manual journal import. Amounts are positive for debits and negative for credits and
 * are tax exclusive: Xero works out the VAT from each line's tax rate and posts it to its own
 * VAT account, which is what puts the sales on Xero's VAT return. Xero rounds VAT per line,
 * so any fils of difference from the bills go to the rounding account to keep it balanced.
 */
function xero(journals: Journal[], config: AccountingConfig): Table {
  const rates = config.xeroTaxRates;
  const rows: (string | number)[][] = [];
  for (const j of journals) {
    const date = formatDate(j.date, config.dateFormat);
    const row = (description: string, code: string, rate: string, amount: number) =>
      rows.push([j.narration, date, description, code, rate, m(amount), "Store", j.storeName]);
    let diff = 0;
    for (const l of j.lines) {
      if (l.key === "vatOutput") continue;
      if (l.tax) {
        const theirs = roundHalfAway((l.amount * l.tax.rateBp) / 10_000);
        diff += l.tax.vat - theirs;
        row(l.description, l.account.code, rates[l.tax.kind], l.amount);
      } else {
        row(l.description, l.account.code, rates.none, l.amount);
      }
    }
    if (diff) row("VAT rounding difference", config.accounts.rounding.code, rates.none, diff);
  }
  return {
    header: ["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount", "TrackingName1", "TrackingOption1"],
    rows,
    bom: false,
  };
}

/** QuickBooks Online journal entry import: lines with the same Journal No. form one entry. */
function quickbooks(journals: Journal[], config: AccountingConfig): Table {
  const rows = journals.flatMap((j) =>
    j.lines.map((l) => [
      j.reference,
      formatDate(j.date, config.dateFormat),
      l.account.name,
      l.amount > 0 ? m(l.amount) : "",
      l.amount < 0 ? m(-l.amount) : "",
      `${l.description} - ${j.storeName}`,
      j.storeName,
    ]),
  );
  return { header: ["Journal No", "Journal Date", "Account Name", "Debits", "Credits", "Description", "Location"], rows, bom: false };
}

/** Zoho Books manual journal import: rows with the same reference form one journal. */
function zoho(journals: Journal[], config: AccountingConfig): Table {
  const rows = journals.flatMap((j) =>
    j.lines.map((l) => [
      formatDate(j.date, config.dateFormat),
      j.reference,
      j.narration,
      "AED",
      l.account.name,
      l.account.code,
      l.description,
      l.amount > 0 ? m(l.amount) : "",
      l.amount < 0 ? m(-l.amount) : "",
      "draft",
    ]),
  );
  return {
    header: ["Journal Date", "Reference Number", "Notes", "Currency", "Account", "Account Code", "Description", "Debit", "Credit", "Status"],
    rows,
    bom: false,
  };
}

const KIND: Record<string, string> = { standard: "Standard rated", zero: "Zero rated", exempt: "Exempt", none: "No VAT set" };

/** Sales journal: each day's sales and refunds by VAT type, before and after VAT. */
function salesListing(days: DayData[]): Table {
  const rows = days.flatMap((d) =>
    d.supplies.map((s) => [d.date, d.storeName, s.refund ? "Refund" : "Sale", KIND[s.kind] ?? s.kind, (s.rateBp / 100).toFixed(2), s.lines, m(s.net), m(s.vat), m(s.net + s.vat)]),
  );
  return { header: ["Date", "Store", "Type", "Supply", "VAT rate %", "Lines", "Net", "VAT", "Gross"], rows, bom: true };
}

/** VAT journal: output VAT per day and rate, with credit notes taken off. */
function vatListing(days: DayData[]): Table {
  const rows: (string | number)[][] = [];
  for (const d of days) {
    const byRate = new Map<string, { kind: string; rateBp: number; salesNet: number; salesVat: number; refundNet: number; refundVat: number }>();
    for (const s of d.supplies) {
      const key = `${s.kind}|${s.rateBp}`;
      const r = byRate.get(key) ?? { kind: s.kind, rateBp: s.rateBp, salesNet: 0, salesVat: 0, refundNet: 0, refundVat: 0 };
      if (s.refund) {
        r.refundNet -= s.net;
        r.refundVat -= s.vat;
      } else {
        r.salesNet += s.net;
        r.salesVat += s.vat;
      }
      byRate.set(key, r);
    }
    for (const r of byRate.values()) {
      rows.push([d.date, d.storeName, KIND[r.kind] ?? r.kind, (r.rateBp / 100).toFixed(2), m(r.salesNet), m(r.salesVat), m(r.refundNet), m(r.refundVat), m(r.salesNet - r.refundNet), m(r.salesVat - r.refundVat)]);
    }
  }
  return {
    header: ["Date", "Store", "Supply", "VAT rate %", "Sales net", "Sales VAT", "Credit notes net", "Credit notes VAT", "Net", "VAT due"],
    rows,
    bom: true,
  };
}

/** Payments journal: what each payment method took per day, for matching to bank and card statements. */
function paymentsListing(days: DayData[]): Table {
  const rows: (string | number)[][] = days.flatMap((d) =>
    d.payments.map((p) => [d.date, d.storeName, p.methodName, p.count, m(p.amount)]),
  );
  for (const d of days) {
    if (d.cashIn || d.cashOut || d.cashVariance) {
      rows.push([d.date, d.storeName, "Cash paid in", "", blankIfZero(d.cashIn)]);
      rows.push([d.date, d.storeName, "Cash paid out", "", d.cashOut ? m(-d.cashOut) : ""]);
      rows.push([d.date, d.storeName, "Cash over/short at close", "", blankIfZero(d.cashVariance)]);
    }
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  return { header: ["Date", "Store", "Payment method", "Payments", "Amount"], rows: rows.filter((r) => r[4] !== ""), bom: true };
}

export function renderExport(format: ExportFormat, days: DayData[], journals: Journal[], config: AccountingConfig): Table {
  switch (format) {
    case "generic":
      return generic(journals);
    case "xero":
      return xero(journals, config);
    case "quickbooks":
      return quickbooks(journals, config);
    case "zoho":
      return zoho(journals, config);
    case "sales":
      return salesListing(days);
    case "vat":
      return vatListing(days);
    case "payments":
      return paymentsListing(days);
  }
}

export const FILE_PREFIX: Record<ExportFormat, string> = {
  generic: "journal",
  xero: "xero-manual-journals",
  quickbooks: "quickbooks-journal-entries",
  zoho: "zoho-books-journals",
  sales: "sales-journal",
  vat: "vat-journal",
  payments: "payments-journal",
};
