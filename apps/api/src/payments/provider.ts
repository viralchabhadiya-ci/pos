/**
 * One adapter per card terminal provider (Network International, Magnati, Geidea, Adyen...).
 * The till never talks to a provider directly: it asks the cloud, which keeps a record of
 * every request so a lost answer can always be checked again.
 */
export type ProviderStatus = "pending" | "approved" | "declined" | "cancelled" | "failed";

export interface TerminalRequest {
  /** Our transaction id. Providers that support it use it as the idempotency key. */
  id: string;
  kind: "sale" | "refund";
  amount: number;
  currency: string;
  terminalRef: string;
  /** For refunds: the provider reference of the original payment. */
  originalRef?: string | null;
}

export interface ProviderResult {
  status: ProviderStatus;
  providerRef?: string | null;
  authCode?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  message?: string | null;
}

export interface PaymentProvider {
  /** Shown in the back office. */
  readonly label: string;
  /** Sends the request to the terminal. Must be safe to call twice with the same id. */
  start(req: TerminalRequest): Promise<ProviderResult>;
  /** Asks the provider what happened to a request. */
  status(req: TerminalRequest, providerRef: string | null): Promise<ProviderResult>;
  /** Tries to stop a request still waiting on the terminal. May answer "approved" if it is too late. */
  cancel(req: TerminalRequest, providerRef: string | null): Promise<ProviderResult>;
}

/** Thrown when the provider cannot be reached, so the outcome of a request is not known. */
export class ProviderUnreachable extends Error {}
