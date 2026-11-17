import type { PaymentProvider } from "./provider.js";
import { SimulatorProvider } from "./simulator.js";

export * from "./provider.js";

/**
 * Providers the platform can talk to. Real ones (Network International, Magnati, Geidea)
 * are added here as adapters once a merchant agreement and API credentials exist.
 */
export function createProviders(): Map<string, PaymentProvider> {
  return new Map<string, PaymentProvider>([["simulator", new SimulatorProvider()]]);
}
