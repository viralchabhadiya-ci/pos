import { z } from "zod";

/**
 * What the customer-facing screen shows. The till publishes it on every cart change; a
 * paired display (tablet, TV box or a second window) reads it from the hub or the cloud.
 */
export const DisplayStateSchema = z.object({
  kind: z.enum(["idle", "cart", "paid"]),
  storeName: z.string().max(200),
  storeNameAr: z.string().max(200).nullable().optional(),
  lines: z
    .array(
      z.object({
        name: z.string().max(200),
        nameAr: z.string().max(200).nullable().optional(),
        qty: z.number(),
        uom: z.enum(["unit", "kg"]),
        gross: z.number().int(),
      }),
    )
    .max(300),
  subtotalNet: z.number().int(),
  taxTotal: z.number().int(),
  discountTotal: z.number().int(),
  total: z.number().int(),
  refund: z.boolean().optional(),
  paid: z
    .object({
      due: z.number().int(),
      tendered: z.number().int(),
      change: z.number().int(),
      receiptUrl: z.string().url().nullable().optional(),
    })
    .optional(),
});
export type DisplayState = z.infer<typeof DisplayStateSchema>;

/**
 * Holds the latest display state per register and lets readers wait for a newer one
 * (long polling), so a display updates within moments without a socket server.
 */
export class DisplayRelay {
  private states = new Map<string, { version: number; state: DisplayState }>();
  private waiters = new Map<string, Set<() => void>>();

  put(registerId: string, state: DisplayState): number {
    const version = (this.states.get(registerId)?.version ?? 0) + 1;
    this.states.set(registerId, { version, state });
    const waiting = this.waiters.get(registerId);
    this.waiters.delete(registerId);
    waiting?.forEach((wake) => wake());
    return version;
  }

  /** Answers at once when there is something newer than `after`, else waits up to `waitMs`. */
  async get(registerId: string, after: number, waitMs: number): Promise<{ version: number; state: DisplayState | null }> {
    const now = this.states.get(registerId);
    if ((now?.version ?? 0) > after || waitMs <= 0) return now ?? { version: 0, state: null };
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(registerId) ?? new Set();
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        set.delete(wake);
        resolve();
      }, waitMs);
      set.add(wake);
      this.waiters.set(registerId, set);
    });
    return this.states.get(registerId) ?? { version: 0, state: null };
  }

  /** Wakes every waiting reader, e.g. on shutdown. */
  close() {
    for (const set of this.waiters.values()) set.forEach((wake) => wake());
    this.waiters.clear();
  }
}
