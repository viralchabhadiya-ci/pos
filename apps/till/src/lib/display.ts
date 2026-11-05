import type { DisplayState } from "@pos/core";
import { request } from "./api.js";

/** Same-device second window (e.g. a second HDMI screen) listens here. */
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pos-display") : null;

let pending: DisplayState | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows a state on the customer display. A window on this device gets it at once; a
 * paired display gets it through the hub or the cloud, sent at most every 150 ms so fast
 * scanning does not flood the network. Failures are ignored: the display is a nicety and
 * must never slow down a sale.
 */
export function publishDisplay(state: DisplayState) {
  channel?.postMessage(state);
  pending = state;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const s = pending;
    pending = null;
    if (s) void request("/display/state", { method: "PUT", body: { state: s } }).catch(() => {});
  }, 150);
}

export function onLocalDisplay(fn: (state: DisplayState) => void): () => void {
  if (!channel) return () => {};
  const handler = (e: MessageEvent<DisplayState>) => fn(e.data);
  channel.addEventListener("message", handler);
  return () => channel.removeEventListener("message", handler);
}

/** Waits for the next state from the hub or cloud. Resolves with null on timeout. */
export async function pollDisplay(after: number): Promise<{ version: number; state: DisplayState | null }> {
  return request(`/display/state?after=${after}&wait=12000`);
}

export const receiptUrl = (publicUrl: string | null | undefined, orderId: string) => (publicUrl ? `${publicUrl}/r/${orderId}` : null);
