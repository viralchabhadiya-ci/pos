import { ApiError, OfflineError, request } from "./api.js";
import { t } from "./i18n.js";

export interface GiftCardInfo {
  code: string;
  status: "active" | "disabled";
  balance: number;
  expiresAt: string | null;
}

/** True when the server could not be reached (directly, or through a store hub that is offline). */
export const isOffline = (err: unknown) => err instanceof OfflineError || (err instanceof ApiError && err.status === 503);

/** A message the cashier can act on, in the till's language. */
export function giftCardError(err: unknown): string {
  if (isOffline(err)) return t("Gift cards and points need the internet. Take another payment.");
  if (err instanceof ApiError) {
    if (err.code === "gift_card_not_found") return t("No gift card with that number.");
    if (err.code === "gift_card_disabled") return t("This gift card has been switched off.");
    if (err.code === "gift_card_expired") return t("This gift card has expired.");
    if (err.code === "gift_card_balance") return t("There is not enough left on this gift card.");
    if (err.code === "bad_code") return t("Gift card numbers are 6 to 40 letters, digits or dashes.");
  }
  return (err as Error).message;
}

export const checkGiftCard = (code: string) => request<GiftCardInfo>(`/gift-cards/${encodeURIComponent(code.trim().toUpperCase())}`);

/** Takes the amount off the card now, so no other till can spend it; tied to the sale when it syncs. */
export const holdGiftCard = (paymentId: string, code: string, amount: number, userId: string) =>
  request<{ balance: number }>("/gift-cards/redeem", { body: { paymentId, code, amount, userId } });

/** Gives a held amount back to the card (the payment was removed or the sale abandoned). */
export const releaseGiftCard = (paymentId: string, userId: string) =>
  request<{ voided: boolean }>(`/gift-cards/redeem/${paymentId}/void`, { body: { userId } });

export const GIFT_CARD_CODE = /^[A-Z0-9-]{6,40}$/;
