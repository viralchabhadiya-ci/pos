export type EInvoiceStatus = "pending" | "sending" | "accepted" | "rejected" | "failed" | "skipped";

export interface EInvoice {
  id: string;
  orderId: string;
  kind: "invoice" | "credit_note";
  status: EInvoiceStatus;
  forced: boolean;
  attempts: number;
  nextAttemptAt: string;
  provider: string | null;
  providerRef: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  hasXml: boolean;
}

export interface EInvoiceRow extends EInvoice {
  number: string;
  total: number;
  billAt: string;
}

export interface EInvoiceAttempt {
  at: string;
  provider: string;
  outcome: "accepted" | "rejected" | "error";
  message: string | null;
  providerRef: string | null;
  durationMs: number | null;
}

export type Emirate = "AUH" | "DXB" | "SHJ" | "AJM" | "UAQ" | "RAK" | "FUJ";
export const EMIRATES: { value: Emirate; label: string }[] = [
  { value: "AUH", label: "Abu Dhabi" },
  { value: "DXB", label: "Dubai" },
  { value: "SHJ", label: "Sharjah" },
  { value: "AJM", label: "Ajman" },
  { value: "UAQ", label: "Umm Al Quwain" },
  { value: "RAK", label: "Ras Al Khaimah" },
  { value: "FUJ", label: "Fujairah" },
];

export interface EInvoiceSettings {
  enabled: boolean;
  scope: "b2b" | "all";
  provider: "simulator" | "http";
  simulatorMode: "accept" | "flaky" | "down" | "reject";
  endpointUrl: string | null;
  hasApiKey: boolean;
  legalName: string | null;
  street: string | null;
  city: string | null;
  emirate: Emirate | null;
  maxAttempts: number;
}

/** Owner-facing words for each state, and which badge colour goes with it. */
export const STATUS: Record<EInvoiceStatus, { label: string; tone: "good" | "warn" | "bad" | "" }> = {
  pending: { label: "Waiting to send", tone: "warn" },
  sending: { label: "Sending", tone: "warn" },
  accepted: { label: "Accepted", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
  skipped: { label: "Not sent", tone: "" },
};

export const canRetry = (s: EInvoiceStatus) => s === "pending" || s === "failed" || s === "rejected" || s === "skipped";
