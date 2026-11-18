import type { Emirate } from "./einvoice.js";

export interface Account {
  code: string;
  name: string;
}

export const ACCOUNT_FIELDS = [
  { key: "salesStandard", label: "Sales, standard rated (5%)", group: "sales" },
  { key: "salesZero", label: "Sales, zero rated", group: "sales" },
  { key: "salesExempt", label: "Sales, exempt", group: "sales" },
  { key: "salesNoVat", label: "Sales with no VAT type set", group: "sales" },
  { key: "returns", label: "Sales returns (refunds)", group: "sales" },
  { key: "vatOutput", label: "VAT output (payable)", group: "sales" },
  { key: "cash", label: "Cash on hand", group: "money" },
  { key: "card", label: "Card payments (until the bank pays out)", group: "money" },
  { key: "otherPayments", label: "Other payment methods", group: "money" },
  { key: "giftCards", label: "Gift cards redeemed", group: "money" },
  { key: "storeCredit", label: "Store credit redeemed", group: "money" },
  { key: "loyalty", label: "Loyalty points redeemed", group: "money" },
  { key: "rounding", label: "Cash rounding", group: "money" },
  { key: "overShort", label: "Cash over and short", group: "money" },
  { key: "cashMovements", label: "Cash paid in and out of the drawer", group: "money" },
] as const;
export type AccountKey = (typeof ACCOUNT_FIELDS)[number]["key"];

export type DateFormat = "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd";
export type SupplyKind = "standard" | "zero" | "exempt" | "none";

export interface AccountingConfig {
  accounts: Record<AccountKey, Account>;
  methodAccounts: Record<string, Account>;
  xeroTaxRates: Record<SupplyKind, string>;
  dateFormat: DateFormat;
  storeEmirates: Record<string, Emirate>;
}

export interface AccountingSettings {
  config: AccountingConfig;
  saved: boolean;
  defaults: AccountingConfig;
  methods: { id: string; name: string; kind: string; active: boolean }[];
  stores: { id: string; code: string; name: string }[];
  einvoicingEmirate: Emirate | null;
}

export interface JournalLine {
  key: string;
  account: Account;
  description: string;
  amount: number;
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
  warnings: string[];
  sales: number;
  refunds: number;
}

export type ExportFormat = "generic" | "xero" | "quickbooks" | "zoho" | "sales" | "vat" | "payments";

export interface JournalsResponse {
  from: string;
  to: string;
  configured: boolean;
  journals: Journal[];
  totals: { debit: number; credit: number };
  overlapping: { format: ExportFormat; from: string; to: string; at: string; by: string | null }[];
}

export interface Amounts {
  amount: number;
  vat: number;
}

export interface Vat201 {
  from: string;
  to: string;
  emirates: ({ emirate: Emirate; box: string; name: string } & Amounts)[];
  unassigned: ({ storeId: string; storeName: string } & Amounts)[];
  box4ZeroRated: number;
  box5Exempt: number;
  box8Total: Amounts;
  noVatType: number;
  box9Purchases: Amounts & { receipts: number };
  box12TotalDue: number;
  box13Recoverable: number;
  box14Payable: number;
  creditNotes: Amounts;
}

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  generic: "CSV journal",
  xero: "Xero",
  quickbooks: "QuickBooks",
  zoho: "Zoho Books",
  sales: "Sales journal",
  vat: "VAT journal",
  payments: "Payments journal",
};

export const FILE_PREFIX: Record<ExportFormat, string> = {
  generic: "journal",
  xero: "xero-manual-journals",
  quickbooks: "quickbooks-journal-entries",
  zoho: "zoho-books-journals",
  sales: "sales-journal",
  vat: "vat-journal",
  payments: "payments-journal",
};
