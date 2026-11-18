import { z } from "zod";
import type { Db } from "../db.js";

export const EMIRATES = ["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"] as const;
export type Emirate = (typeof EMIRATES)[number];

const Account = z.object({
  code: z.string().trim().max(40).default(""),
  name: z.string().trim().min(1, "Enter the account name").max(150),
});
export type Account = z.infer<typeof Account>;

/** The accounts a POS day posts to. Each business maps these to its own chart of accounts. */
export const ACCOUNT_KEYS = [
  "salesStandard",
  "salesZero",
  "salesExempt",
  "salesNoVat",
  "returns",
  "vatOutput",
  "cash",
  "card",
  "otherPayments",
  "rounding",
  "overShort",
  "cashMovements",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

/**
 * A plain UAE retail chart. The codes are placeholders that rarely match a real ledger,
 * so the back office asks the owner to check them before the first export.
 */
export const DEFAULT_ACCOUNTS: Record<AccountKey, Account> = {
  salesStandard: { code: "4000", name: "Sales" },
  salesZero: { code: "4010", name: "Sales - zero rated" },
  salesExempt: { code: "4020", name: "Sales - exempt" },
  salesNoVat: { code: "4030", name: "Sales - outside VAT" },
  returns: { code: "4100", name: "Sales returns" },
  vatOutput: { code: "2200", name: "VAT output" },
  cash: { code: "1000", name: "Cash on hand" },
  card: { code: "1010", name: "Card payments clearing" },
  otherPayments: { code: "1020", name: "Other payments clearing" },
  rounding: { code: "4900", name: "Cash rounding" },
  overShort: { code: "6900", name: "Cash over and short" },
  cashMovements: { code: "6910", name: "Cash paid in and out" },
};

export const DEFAULT_XERO_TAX = {
  standard: "Standard Rated Income",
  zero: "Zero Rated Income",
  exempt: "Exempt Income",
  none: "No VAT",
};

export const ConfigSchema = z.object({
  accounts: z.object(Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, Account])) as Record<AccountKey, typeof Account>),
  /** A payment method that should not go to the default cash/card/other account, by method id. */
  methodAccounts: z.record(z.string().uuid(), Account).default({}),
  /** Tax rate names exactly as they are in the business's Xero organisation. */
  xeroTaxRates: z.object({
    standard: z.string().trim().min(1).max(60),
    zero: z.string().trim().min(1).max(60),
    exempt: z.string().trim().min(1).max(60),
    none: z.string().trim().min(1).max(60),
  }),
  /** Date format the accounting tool expects for imports. */
  dateFormat: z.enum(["dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"]),
  /** Emirate of each store, for VAT return box 1. Falls back to the e-invoicing emirate. */
  storeEmirates: z.record(z.string().uuid(), z.enum(EMIRATES)).default({}),
});
export type AccountingConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AccountingConfig = {
  accounts: DEFAULT_ACCOUNTS,
  methodAccounts: {},
  xeroTaxRates: DEFAULT_XERO_TAX,
  dateFormat: "dd/mm/yyyy",
  storeEmirates: {},
};

/** Saved settings over the defaults, so a key added later never leaves a hole. */
export function mergeConfig(saved: unknown): AccountingConfig {
  const s = (saved ?? {}) as Partial<AccountingConfig>;
  const merged = {
    accounts: { ...DEFAULT_ACCOUNTS, ...(s.accounts ?? {}) },
    methodAccounts: s.methodAccounts ?? {},
    xeroTaxRates: { ...DEFAULT_XERO_TAX, ...(s.xeroTaxRates ?? {}) },
    dateFormat: s.dateFormat ?? DEFAULT_CONFIG.dateFormat,
    storeEmirates: s.storeEmirates ?? {},
  };
  const parsed = ConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

export async function loadConfig(db: Db, tenantId: string): Promise<{ config: AccountingConfig; saved: boolean }> {
  const { rows } = await db.query("SELECT config FROM accounting_settings WHERE tenant_id = $1", [tenantId]);
  return { config: mergeConfig(rows[0]?.config), saved: rows.length > 0 };
}
