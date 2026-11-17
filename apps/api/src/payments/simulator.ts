import type { PaymentProvider, ProviderResult, TerminalRequest } from "./provider.js";
import { ProviderUnreachable } from "./provider.js";

/**
 * A pretend terminal for demos and tests. The amount's last two digits pick the outcome,
 * like the test cards card schemes publish:
 *   .13 declined, .14 the customer takes long (approved after 4x the delay),
 *   .15 terminal unreachable, .16 approved but the first status checks fail (lost answer).
 * Anything else is approved once the delay has passed.
 */
export class SimulatorProvider implements PaymentProvider {
  readonly label = "Simulator (testing)";
  private started = new Map<string, number>();
  private cancelled = new Set<string>();
  private flaky = new Map<string, number>();

  constructor(private delayMs = Number(process.env.CARD_SIMULATOR_DELAY_MS ?? 3000)) {}

  private outcome(req: TerminalRequest): ProviderResult {
    const cents = req.amount % 100;
    const at = this.started.get(req.id) ?? Date.now();
    const elapsed = Date.now() - at;
    const ref = `SIM-${req.id.slice(0, 8)}`;
    if (this.cancelled.has(req.id)) return { status: "cancelled", providerRef: ref, message: "Cancelled on the terminal" };
    const wait = cents === 14 ? this.delayMs * 4 : this.delayMs;
    if (elapsed < wait) return { status: "pending", providerRef: ref, message: "Waiting for the customer to tap or insert the card" };
    if (cents === 13) return { status: "declined", providerRef: ref, message: "Declined by the bank: insufficient funds" };
    const last4 = String(4000 + (parseInt(req.id.replace(/-/g, "").slice(0, 6), 16) % 6000)).padStart(4, "0");
    return {
      status: "approved",
      providerRef: ref,
      authCode: req.id.replace(/-/g, "").slice(-6).toUpperCase(),
      cardBrand: cents % 2 ? "Mastercard" : "Visa",
      cardLast4: last4,
      message: req.kind === "refund" ? "Refund approved" : "Approved",
    };
  }

  async start(req: TerminalRequest): Promise<ProviderResult> {
    if (req.amount % 100 === 15) throw new ProviderUnreachable("The terminal is not responding");
    if (!this.started.has(req.id)) this.started.set(req.id, Date.now());
    return this.outcome(req);
  }

  async status(req: TerminalRequest): Promise<ProviderResult> {
    if (req.amount % 100 === 16) {
      const n = (this.flaky.get(req.id) ?? 0) + 1;
      this.flaky.set(req.id, n);
      if (n <= 2) throw new ProviderUnreachable("No answer from the payment provider");
    }
    // After a server restart the simulator forgets start times; treat such payments as done.
    if (!this.started.has(req.id)) this.started.set(req.id, 0);
    return this.outcome(req);
  }

  async cancel(req: TerminalRequest): Promise<ProviderResult> {
    const now = this.outcome(req);
    if (now.status === "pending") this.cancelled.add(req.id);
    return this.outcome(req);
  }
}
