/**
 * Payments the customer makes on their own phone: Tabby or Tamara (pay later in instalments)
 * and card payment links (a payment gateway's checkout). One adapter per provider; the till
 * never talks to them directly.
 *
 * Until a business has its merchant keys, every provider runs on the simulator: the link opens
 * our own checkout page (<PUBLIC_URL>/pay/<token>), where the customer, or the cashier trying
 * it out, presses Pay or Decline.
 */
export const LINK_PROVIDERS = {
  tabby: { label: "Tabby", kind: "bnpl", instalments: 4 },
  tamara: { label: "Tamara", kind: "bnpl", instalments: 3 },
  link: { label: "Pay by link", kind: "pay_link", instalments: 1 },
} as const;
export type LinkProviderId = keyof typeof LINK_PROVIDERS;

export type LinkStatus = "pending" | "paid" | "declined" | "expired" | "cancelled" | "failed";

export interface LinkRequest {
  id: string;
  kind: "sale" | "refund";
  amount: number;
  currency: string;
  token: string;
  phone: string | null;
  /** For a refund: the provider's reference of the payment it goes back to. */
  originalRef?: string | null;
}

export interface LinkResult {
  status: LinkStatus;
  providerRef?: string | null;
  /** The provider's own checkout page; null when our page is the checkout (the simulator). */
  checkoutUrl?: string | null;
  message?: string | null;
}

export interface LinkProvider {
  readonly label: string;
  /** Opens a checkout (or, for a refund, sends the refund). Safe to call twice with the same id. */
  create(req: LinkRequest): Promise<LinkResult>;
  /** What happened to it. `current` is what we last stored, which the simulator's page updates. */
  status(req: LinkRequest, current: LinkStatus): Promise<LinkResult>;
  cancel(req: LinkRequest): Promise<LinkResult>;
}

/**
 * The pretend provider. A sale stays pending until the checkout page says paid or declined;
 * a refund goes through at once, except refunds of an amount ending in .13, which fail.
 */
export class SimulatedLinkProvider implements LinkProvider {
  constructor(readonly label: string) {}
  async create(req: LinkRequest): Promise<LinkResult> {
    const ref = `SIM-${req.id.slice(0, 8)}`;
    if (req.kind === "refund") {
      return req.amount % 100 === 13 ? { status: "failed", providerRef: ref, message: "Refund refused by the provider" } : { status: "paid", providerRef: ref, message: "Refunded" };
    }
    return { status: "pending", providerRef: ref, checkoutUrl: null, message: "Waiting for the customer" };
  }
  async status(_req: LinkRequest, current: LinkStatus): Promise<LinkResult> {
    return { status: current };
  }
  async cancel(): Promise<LinkResult> {
    return { status: "cancelled", message: "Cancelled at the till" };
  }
}

export function createLinkProviders(): Map<LinkProviderId, LinkProvider> {
  return new Map((Object.keys(LINK_PROVIDERS) as LinkProviderId[]).map((id) => [id, new SimulatedLinkProvider(LINK_PROVIDERS[id].label)]));
}
