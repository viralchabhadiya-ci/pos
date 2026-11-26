import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import type { Cart, CartLine } from "../lib/cart.js";
import { money, qtyText } from "../lib/format.js";
import { t } from "../lib/i18n.js";

/**
 * Splits a table's bill: pick what this guest pays for now. Their items become their own
 * sale; the rest stays on the table.
 */
export function splitCart(cart: Cart, take: Record<string, number>, newId: () => string = () => crypto.randomUUID()): { now: Cart; rest: Cart } {
  const now: CartLine[] = [];
  const rest: CartLine[] = [];
  for (const l of cart.lines) {
    const q = Math.min(take[l.id] ?? 0, l.qty);
    if (q <= 0) rest.push(l);
    else if (q >= l.qty) now.push(l);
    else {
      const sentNow = Math.min(l.sentQty ?? 0, q);
      now.push({ ...l, id: newId(), qty: q, sentQty: sentNow });
      rest.push({ ...l, qty: Math.round((l.qty - q) * 1000) / 1000, sentQty: Math.max(0, (l.sentQty ?? 0) - sentNow) });
    }
  }
  // This guest's part is a sale of its own; the table's bill (tab) carries on with the rest.
  const { tabId: _id, tabVersion: _v, kitchenVoids: _k, ...plain } = cart;
  return { now: { ...plain, lines: now, codes: [] }, rest: { ...cart, lines: rest } };
}

export function SplitDialog({ cart, onPay, onClose }: { cart: Cart; onPay: (take: Record<string, number>) => void; onClose: () => void }) {
  const [take, setTake] = useState<Record<string, number>>({});
  const units = (l: CartLine) => (l.uom === "unit" && Number.isInteger(l.qty) ? l.qty : 1);
  const set = (l: CartLine, n: number) => setTake((x) => ({ ...x, [l.id]: Math.max(0, Math.min(n, units(l))) }));
  const qtyOf = (l: CartLine) => {
    const n = take[l.id] ?? 0;
    return l.uom === "unit" && Number.isInteger(l.qty) ? n : n ? l.qty : 0;
  };
  const chosen = cart.lines.filter((l) => qtyOf(l) > 0);
  const amount = chosen.reduce((s, l) => s + Math.round(l.unitPrice * qtyOf(l) * (1 - (l.discountBp ?? 0) / 10_000)), 0);
  const all = chosen.length === cart.lines.length && cart.lines.every((l) => qtyOf(l) >= l.qty);

  return (
    <Modal onClose={onClose} label={t("Split the bill")} wide>
      <h2>{t("Split the bill")}</h2>
      <p className="muted">{t("Pick what this guest pays for now. The rest stays on the table.")}</p>
      <ul className="split-lines">
        {cart.lines.map((l) => {
          const max = units(l);
          const n = take[l.id] ?? 0;
          return (
            <li key={l.id}>
              <span className="desc">
                {l.name}
                {l.modifiers?.length ? <small className="muted">{l.modifiers.map((m) => m.name).join(", ")}</small> : null}
                <small className="muted">
                  <bdi>
                    {qtyText(l.qty, l.uom)} × {money(l.unitPrice)}
                  </bdi>
                </small>
              </span>
              <div className="stepper" role="group" aria-label={l.name}>
                <button type="button" aria-label={t("Less")} disabled={n <= 0} onClick={() => set(l, n - 1)}>
                  <Icon name="minus" size={18} />
                </button>
                <span className="tnum" aria-live="polite">
                  {max === 1 && l.qty !== 1 ? (n ? t("All") : "0") : `${n} / ${max}`}
                </span>
                <button type="button" aria-label={t("More")} disabled={n >= max} onClick={() => set(l, n + 1)}>
                  <Icon name="plus" size={18} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button type="button" className="btn primary" disabled={!chosen.length || all} onClick={() => onPay(take)}>
          {t("Pay these")} · <bdi className="tnum">{money(amount)}</bdi>
        </button>
      </div>
      {all && <p className="muted small">{t("That is the whole bill. Close this and press Pay.")}</p>}
    </Modal>
  );
}
