/**
 * Builds UAE e-invoices in the PINT AE profile of Peppol UBL 2.1.
 *
 * Amounts arrive as integer fils and are always positive in a document: a refund
 * becomes a credit note with positive quantities and amounts. Discounts are already
 * inside each line's net amount, so lines need no allowance elements.
 */

export const PINT_AE_CUSTOMIZATION = "urn:peppol:pint:billing-1@ae-1";
export const PINT_AE_PROFILE = "urn:peppol:bis:billing";
/** UAE TIN as a Peppol participant identifier scheme. */
export const UAE_TIN_SCHEME = "0235";
/** GTIN scheme for barcodes. */
const GTIN_SCHEME = "0160";

export const EMIRATES = {
  AUH: "Abu Dhabi",
  DXB: "Dubai",
  SHJ: "Sharjah",
  AJM: "Ajman",
  UAQ: "Umm Al Quwain",
  RAK: "Ras Al Khaimah",
  FUJ: "Fujairah",
} as const;
export type Emirate = keyof typeof EMIRATES;

/** S standard rated, Z zero rated, E exempt (UNCL5305). */
export type TaxCategory = "S" | "Z" | "E";

export interface PintParty {
  name: string;
  trn?: string | null;
  street?: string | null;
  city?: string | null;
  emirate?: Emirate | null;
}

export interface PintLine {
  lineNo: number;
  name: string;
  qty: number;
  uom: "unit" | "kg";
  /** Line amount without VAT, after discounts. */
  net: number;
  tax: number;
  gross: number;
  category: TaxCategory | null;
  rateBp: number;
  sku?: string | null;
  barcode?: string | null;
}

export interface PintDocument {
  kind: "invoice" | "credit_note";
  number: string;
  /** The bill's own id, sent as the document UUID. */
  uuid: string;
  issuedAt: string | Date;
  timezone: string;
  seller: PintParty;
  buyer: PintParty;
  lines: PintLine[];
  /** Cash rounding added on top of the VAT-inclusive total. */
  cashRounding: number;
  paymentKinds: string[];
  /** For credit notes: the invoice being credited. */
  billingReference?: { number: string; issuedAt: string | Date } | null;
  note?: string | null;
}

export interface PintTotals {
  lineExtension: number;
  taxExclusive: number;
  tax: number;
  taxInclusive: number;
  rounding: number;
  payable: number;
  subtotals: { category: TaxCategory; rateBp: number; taxable: number; tax: number }[];
}

const TRN = /^\d{15}$/;

/** Problems that would make the ASP reject the document, worded for a shop owner. */
export function validatePint(doc: PintDocument): string[] {
  const problems: string[] = [];
  if (!doc.seller.trn) problems.push("The store has no TRN. Add it under Settings.");
  else if (!TRN.test(doc.seller.trn)) problems.push("The store TRN must have 15 digits.");
  if (!doc.seller.name.trim()) problems.push("The seller's legal name is missing. Add it under E-invoicing settings.");
  if (!doc.seller.emirate) problems.push("The seller's emirate is missing. Choose it under E-invoicing settings.");
  if (doc.buyer.trn && !TRN.test(doc.buyer.trn)) problems.push("The customer's TRN must have 15 digits.");
  if (doc.kind === "credit_note" && !doc.billingReference) problems.push("A credit note needs the original invoice.");
  if (doc.lines.length === 0) problems.push("The bill has no items.");
  for (const l of doc.lines) {
    if (!l.category) problems.push(`Item ${l.lineNo} (${l.name}) has no VAT rate.`);
    if (!(l.qty > 0)) problems.push(`Item ${l.lineNo} (${l.name}) has no quantity.`);
    if (l.net + l.tax !== l.gross) problems.push(`Item ${l.lineNo} (${l.name}) amounts do not add up.`);
    if (l.category === "S" && l.rateBp <= 0) problems.push(`Item ${l.lineNo} (${l.name}) is standard rated at 0%.`);
  }
  return problems;
}

export function pintTotals(doc: PintDocument): PintTotals {
  const groups = new Map<string, { category: TaxCategory; rateBp: number; taxable: number; tax: number }>();
  for (const l of doc.lines) {
    const category = l.category ?? "S";
    const rateBp = category === "S" ? l.rateBp : 0;
    const key = `${category}:${rateBp}`;
    const g = groups.get(key) ?? { category, rateBp, taxable: 0, tax: 0 };
    g.taxable += l.net;
    g.tax += l.tax;
    groups.set(key, g);
  }
  const lineExtension = doc.lines.reduce((s, l) => s + l.net, 0);
  const tax = doc.lines.reduce((s, l) => s + l.tax, 0);
  const taxInclusive = lineExtension + tax;
  return {
    lineExtension,
    taxExclusive: lineExtension,
    tax,
    taxInclusive,
    rounding: doc.cashRounding,
    payable: taxInclusive + doc.cashRounding,
    subtotals: [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || b.rateBp - a.rateBp),
  };
}

export function buildPintXml(doc: PintDocument): string {
  const credit = doc.kind === "credit_note";
  const t = pintTotals(doc);
  const root = credit ? "CreditNote" : "Invoice";
  const ns = credit
    ? "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
    : "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
  const { date, time } = localDateTime(doc.issuedAt, doc.timezone);
  const x = new Xml();

  x.raw('<?xml version="1.0" encoding="UTF-8"?>');
  x.open(root, {
    xmlns: ns,
    "xmlns:cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "xmlns:cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  });
  x.el("cbc:CustomizationID", PINT_AE_CUSTOMIZATION);
  x.el("cbc:ProfileID", PINT_AE_PROFILE);
  // BTAE-02 transaction type flags: free zone, deemed supply, margin scheme, summary,
  // continuous supply, disclosed agent, e-commerce, exports. A shop sale sets none.
  x.el("cbc:ProfileExecutionID", "00000000");
  x.el("cbc:ID", doc.number);
  x.el("cbc:UUID", doc.uuid);
  x.el("cbc:IssueDate", date);
  x.el("cbc:IssueTime", time);
  x.el(credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", credit ? "381" : "380");
  if (doc.note) x.el("cbc:Note", doc.note);
  x.el("cbc:DocumentCurrencyCode", "AED");
  if (doc.billingReference) {
    x.open("cac:BillingReference");
    x.open("cac:InvoiceDocumentReference");
    x.el("cbc:ID", doc.billingReference.number);
    x.el("cbc:IssueDate", localDateTime(doc.billingReference.issuedAt, doc.timezone).date);
    x.close("cac:InvoiceDocumentReference");
    x.close("cac:BillingReference");
  }

  x.open("cac:AccountingSupplierParty");
  party(x, doc.seller);
  x.close("cac:AccountingSupplierParty");
  x.open("cac:AccountingCustomerParty");
  party(x, doc.buyer);
  x.close("cac:AccountingCustomerParty");

  for (const kind of [...new Set(doc.paymentKinds)]) {
    x.open("cac:PaymentMeans");
    // UNCL4461: 10 cash, 48 bank card, ZZZ agreed between the parties (gift card, points).
    const [code, name] = kind === "cash" ? ["10", "Cash"] : kind === "gift_card" ? ["ZZZ", "Gift card"] : kind === "points" ? ["ZZZ", "Loyalty points"] : ["48", "Card"];
    x.el("cbc:PaymentMeansCode", code, { name });
    x.close("cac:PaymentMeans");
  }

  x.open("cac:TaxTotal");
  x.el("cbc:TaxAmount", amount(t.tax), { currencyID: "AED" });
  for (const s of t.subtotals) {
    x.open("cac:TaxSubtotal");
    x.el("cbc:TaxableAmount", amount(s.taxable), { currencyID: "AED" });
    x.el("cbc:TaxAmount", amount(s.tax), { currencyID: "AED" });
    taxCategory(x, "cac:TaxCategory", s.category, s.rateBp);
    x.close("cac:TaxSubtotal");
  }
  x.close("cac:TaxTotal");

  x.open("cac:LegalMonetaryTotal");
  x.el("cbc:LineExtensionAmount", amount(t.lineExtension), { currencyID: "AED" });
  x.el("cbc:TaxExclusiveAmount", amount(t.taxExclusive), { currencyID: "AED" });
  x.el("cbc:TaxInclusiveAmount", amount(t.taxInclusive), { currencyID: "AED" });
  if (t.rounding !== 0) x.el("cbc:PayableRoundingAmount", amount(t.rounding), { currencyID: "AED" });
  x.el("cbc:PayableAmount", amount(t.payable), { currencyID: "AED" });
  x.close("cac:LegalMonetaryTotal");

  const lineTag = credit ? "cac:CreditNoteLine" : "cac:InvoiceLine";
  for (const l of doc.lines) {
    const category = l.category ?? "S";
    x.open(lineTag);
    x.el("cbc:ID", String(l.lineNo));
    x.el(credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", quantity(l.qty), {
      unitCode: l.uom === "kg" ? "KGM" : "C62",
    });
    x.el("cbc:LineExtensionAmount", amount(l.net), { currencyID: "AED" });
    // BTAE-08: VAT on the line, in AED.
    x.open("cac:TaxTotal");
    x.el("cbc:TaxAmount", amount(l.tax), { currencyID: "AED" });
    x.close("cac:TaxTotal");
    x.open("cac:Item");
    x.el("cbc:Name", l.name);
    if (l.sku) {
      x.open("cac:SellersItemIdentification");
      x.el("cbc:ID", l.sku);
      x.close("cac:SellersItemIdentification");
    }
    if (l.barcode && /^\d{8,14}$/.test(l.barcode)) {
      x.open("cac:StandardItemIdentification");
      x.el("cbc:ID", l.barcode, { schemeID: GTIN_SCHEME });
      x.close("cac:StandardItemIdentification");
    }
    taxCategory(x, "cac:ClassifiedTaxCategory", category, l.rateBp);
    x.close("cac:Item");
    x.open("cac:Price");
    x.el("cbc:PriceAmount", unitPrice(l.net, l.qty), { currencyID: "AED" });
    x.close("cac:Price");
    // Line amount including VAT.
    x.open("cac:ItemPriceExtension");
    x.el("cbc:Amount", amount(l.gross), { currencyID: "AED" });
    x.close("cac:ItemPriceExtension");
    x.close(lineTag);
  }
  x.close(root);
  return x.toString();
}

function party(x: Xml, p: PintParty) {
  x.open("cac:Party");
  if (p.trn) x.el("cbc:EndpointID", p.trn.slice(0, 10), { schemeID: UAE_TIN_SCHEME });
  x.open("cac:PartyName");
  x.el("cbc:Name", p.name);
  x.close("cac:PartyName");
  if (p.street || p.city || p.emirate) {
    x.open("cac:PostalAddress");
    if (p.street) x.el("cbc:StreetName", p.street);
    if (p.city) x.el("cbc:CityName", p.city);
    if (p.emirate) x.el("cbc:CountrySubentity", p.emirate);
    x.open("cac:Country");
    x.el("cbc:IdentificationCode", "AE");
    x.close("cac:Country");
    x.close("cac:PostalAddress");
  }
  if (p.trn) {
    x.open("cac:PartyTaxScheme");
    x.el("cbc:CompanyID", p.trn);
    x.open("cac:TaxScheme");
    x.el("cbc:ID", "VAT");
    x.close("cac:TaxScheme");
    x.close("cac:PartyTaxScheme");
  }
  x.open("cac:PartyLegalEntity");
  x.el("cbc:RegistrationName", p.name);
  x.close("cac:PartyLegalEntity");
  x.close("cac:Party");
}

function taxCategory(x: Xml, tag: string, category: TaxCategory, rateBp: number) {
  x.open(tag);
  x.el("cbc:ID", category);
  x.el("cbc:Percent", percent(category === "S" ? rateBp : 0));
  if (category === "E") x.el("cbc:TaxExemptionReason", "Exempt supply");
  x.open("cac:TaxScheme");
  x.el("cbc:ID", "VAT");
  x.close("cac:TaxScheme");
  x.close(tag);
}

/** 1050 fils -> "10.50"; never uses float maths or thousands separators. */
export function amount(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const percent = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2));
const quantity = (q: number) => String(Number(q.toFixed(3)));

/** Net unit price with up to 6 decimals, so quantity x price gives back the line amount. */
export function unitPrice(net: number, qty: number): string {
  const s = (net / 100 / qty).toFixed(6).replace(/0+$/, "");
  const [whole, frac = ""] = s.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** The date and time on the shop's own clock, as the FTA expects. */
export function localDateTime(at: string | Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** A tiny indenting XML writer; enough for UBL without a dependency. */
class Xml {
  private out: string[] = [];
  private depth = 0;
  raw(s: string) {
    this.out.push(s);
  }
  private attrs(a: Record<string, string>) {
    return Object.entries(a)
      .map(([k, v]) => ` ${k}="${escape(v)}"`)
      .join("");
  }
  open(tag: string, a: Record<string, string> = {}) {
    this.out.push(`${"  ".repeat(this.depth)}<${tag}${this.attrs(a)}>`);
    this.depth += 1;
  }
  close(tag: string) {
    this.depth -= 1;
    this.out.push(`${"  ".repeat(this.depth)}</${tag}>`);
  }
  el(tag: string, value: string, a: Record<string, string> = {}) {
    this.out.push(`${"  ".repeat(this.depth)}<${tag}${this.attrs(a)}>${escape(value)}</${tag}>`);
  }
  toString() {
    return `${this.out.join("\n")}\n`;
  }
}
