import { useState, type FormEvent } from "react";
import { Modal } from "../components/Modal.js";
import { request } from "../lib/api.js";
import { emptyCart, type Cart, type CartLine } from "../lib/cart.js";
import { db } from "../lib/db.js";
import { money } from "../lib/format.js";
import { findSale } from "../lib/till.js";
import { Icon } from "../components/Icon.js";

interface SoldLine {
  variantId: string;
  name: string;
  qty: number;
  unitPrice: number;
  discountBp: number;
  taxId: string | null;
}

/**
 * Refunds always start from the original receipt so the credit note links to it and
 * the server can stop a second refund of the same items.
 */
export function RefundDialog({ onStart, onCancel }: { onStart: (cart: Cart) => void; onCancel: () => void }) {
  const [number, setNumber] = useState("");
  const [sale, setSale] = useState<{ id: string; number: string; lines: SoldLine[] } | null>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const hit = await findSale(number);
    if (!hit) return setError("No sale found with that receipt number");
    if ("remote" in hit) {
      try {
        const full = await request<{
          id: string;
          number: string;
          lines: { name: string; qty: number | string; unit_price: number; variant_id: string; discount_bp: number; tax_id: string | null }[];
        }>(`/orders/${hit.id}`);
        const lines = full.lines.map((l) => ({
          variantId: l.variant_id,
          name: l.name,
          qty: Number(l.qty),
          unitPrice: l.unit_price,
          discountBp: l.discount_bp,
          taxId: l.tax_id,
        }));
        setSale({ id: full.id, number: full.number, lines });
        setPicked(Object.fromEntries(lines.map((l, i) => [i, l.qty])));
      } catch {
        setError("This sale is from another till; connect to the internet to refund it");
      }
      return;
    }
    setSale({ id: hit.id, number: hit.number, lines: hit.lines.map((l) => ({ ...l, discountBp: l.discountBp ?? 0 })) });
    setPicked(Object.fromEntries(hit.lines.map((l, i) => [i, l.qty])));
  };

  const start = async () => {
    if (!sale) return;
    const products = new Map((await db.products.toArray()).map((p) => [p.id, p]));
    const variants = new Map((await db.variants.toArray()).map((v) => [v.id, v]));
    const lines: CartLine[] = sale.lines
      .map((l, i) => ({ l, qty: picked[i] ?? 0 }))
      .filter(({ qty }) => qty > 0)
      .map(({ l, qty }) => {
        const v = variants.get(l.variantId);
        const uom = (v && products.get(v.productId)?.uom) ?? "unit";
        return { id: crypto.randomUUID(), variantId: l.variantId, name: l.name, unitPrice: l.unitPrice, qty: -qty, discountBp: l.discountBp, taxId: l.taxId, uom };
      });
    if (!lines.length) return setError("Pick at least one item to return");
    onStart({ ...emptyCart(), lines, refundOfOrderId: sale.id });
  };

  return (
    <Modal onClose={onCancel} wide label="Refund">
      <h2>Refund</h2>
      {!sale ? (
        <form onSubmit={lookup}>
          <label htmlFor="rnum">Receipt number</label>
          <input id="rnum" value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} placeholder="DXB1-R1-0001-0001" autoFocus />
          {error && (
          <p className="error" role="alert">
            <Icon name="alert" size={18} />
            {error}
          </p>
        )}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn primary" disabled={!number.trim()}>
              Find sale
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">Sale {sale.number}. Choose how many of each item come back.</p>
          <table className="refund-table">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: "right" }}>Sold</th>
                <th style={{ textAlign: "right" }}>Price</th>
                <th style={{ textAlign: "right" }}>Return</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.name}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{money(l.unitPrice)}</td>
                  <td className="num">
                    <input
                      aria-label={`Return quantity for ${l.name}`}
                      inputMode="decimal"
                      value={picked[i] ?? 0}
                      onChange={(e) => setPicked({ ...picked, [i]: Math.min(l.qty, Math.max(0, Number(e.target.value) || 0)) })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && (
          <p className="error" role="alert">
            <Icon name="alert" size={18} />
            {error}
          </p>
        )}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={start}>
              Start refund
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
