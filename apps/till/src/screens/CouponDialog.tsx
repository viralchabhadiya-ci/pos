import { promotionRunning, type Promotion } from "@pos/core";
import { useState, type FormEvent } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { t } from "../lib/i18n.js";

/**
 * Coupon codes for the sale. A code is checked against the promotions this till has synced,
 * so it works offline; whether the sale qualifies shows in the cart's totals.
 */
export function CouponDialog({
  codes,
  appliedCodes,
  promotions,
  storeId,
  timezone,
  onAdd,
  onRemove,
  onClose,
}: {
  codes: string[];
  appliedCodes: string[];
  promotions: Promotion[];
  storeId: string;
  timezone: string;
  onAdd: (code: string) => void;
  onRemove: (code: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    const now = new Date();
    const hit = promotions.find((p) => p.code?.trim().toUpperCase() === c);
    if (!hit) return setError(t("No coupon with this code."));
    if (!promotionRunning(hit, { now, timezone, storeId })) return setError(t("This coupon is not valid at this time or in this store."));
    if (codes.includes(c)) return setError(t("This code is already on the sale."));
    onAdd(c);
    setCode("");
    setError(null);
  };

  return (
    <Modal onClose={onClose} label={t("Coupon")}>
      <h2>{t("Coupon")}</h2>
      <form onSubmit={submit}>
        <label htmlFor="coupon">{t("Coupon code")}</label>
        <div className="inline-field">
          <input
            id="coupon"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
            }}
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={30}
            autoFocus
          />
          <button type="submit" className="btn primary" disabled={!code.trim()}>
            {t("Apply")}
          </button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      )}
      {codes.length > 0 && (
        <ul className="codes">
          {codes.map((c) => {
            const on = appliedCodes.includes(c);
            return (
              <li key={c}>
                <Icon name="ticket" size={18} />
                <span className="desc">
                  <strong>{c}</strong>
                  <small className={on ? "ok" : "muted"}>{on ? t("Applied") : t("Not applied yet: the sale does not qualify")}</small>
                </span>
                <button type="button" className="btn ghost danger" onClick={() => onRemove(c)}>
                  {t("Remove")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="btn outline" onClick={onClose}>
          {t("Done")}
        </button>
      </div>
    </Modal>
  );
}
