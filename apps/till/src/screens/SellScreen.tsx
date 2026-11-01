import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, useState } from "react";
import { ManagerPin } from "../components/ManagerPin.js";
import { Modal } from "../components/Modal.js";
import { addItem, cartTotals, emptyCart, needsManager, removeLine, updateLine, type Cart, type SellableItem } from "../lib/cart.js";
import { db, type DeviceSetup, type LocalOrder, type Session, type User } from "../lib/db.js";
import { aed, money, qtyText, tryParseMoney } from "../lib/format.js";
import { useScanner } from "../lib/useScanner.js";
import { PaymentDialog } from "./PaymentDialog.js";
import { ReceiptView } from "./ReceiptView.js";
import { RefundDialog } from "./RefundDialog.js";

type PadMode = "qty" | "disc" | "price";

interface Props {
  setup: DeviceSetup;
  user: User;
  session: Session;
  onMenu: () => void;
}

export function SellScreen({ setup, user }: Props) {
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<PadMode>("qty");
  const [entry, setEntry] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<LocalOrder | null>(null);
  const [weighing, setWeighing] = useState<SellableItem | null>(null);
  const [approval, setApproval] = useState<{ reason: string; apply: () => void } | null>(null);
  const [refunding, setRefunding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const categories = useLiveQuery(() => db.categories.orderBy("sort").filter((c) => c.active).toArray(), []) ?? [];
  const taxes = useLiveQuery(async () => Object.fromEntries((await db.taxes.toArray()).map((t) => [t.id, t])), []) ?? {};
  const items = useLiveQuery(async () => {
    const [products, variants] = await Promise.all([db.products.toArray(), db.variants.toArray()]);
    const byId = new Map(products.map((p) => [p.id, p]));
    return variants
      .filter((v) => v.active && byId.get(v.productId)?.active)
      .map((v) => {
        const p = byId.get(v.productId)!;
        const attrs = Object.values(v.attributes ?? {}).join(" ");
        return {
          variantId: v.id,
          name: attrs ? `${p.name} ${attrs}` : p.name,
          nameAr: p.nameAr,
          price: v.price,
          taxId: p.taxId,
          uom: p.uom,
          barcode: v.barcode,
          sku: v.sku,
          categoryId: p.categoryId,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (!categoryId || i.categoryId === categoryId) &&
        (!q || i.name.toLowerCase().includes(q) || i.barcode === q || i.sku?.toLowerCase() === q || i.nameAr?.includes(q)),
    );
  }, [items, search, categoryId]);

  const totals = useMemo(() => cartTotals(cart, taxes), [cart, taxes]);
  const isRefund = cart.refundOfOrderId !== null;

  const add = (item: SellableItem, qty = 1) => {
    if (isRefund) return setNotice("Finish or clear the refund before adding items");
    if (item.uom === "kg" && qty === 1) return setWeighing(item);
    const next = addItem(cart, item, qty);
    setCart(next);
    setSelected(next.lines.find((l) => l.variantId === item.variantId && l.qty >= qty)?.id ?? next.lines.at(-1)!.id);
    setEntry("");
  };

  const scan = (code: string) => {
    const hit = items?.find((i) => i.barcode === code || i.sku === code);
    if (hit) add(hit);
    else setNotice(`No product with barcode ${code}`);
  };
  useScanner(scan);

  const selectedLine = cart.lines.find((l) => l.id === selected);

  const applyEntry = () => {
    if (!selectedLine || entry === "") return;
    const value = Number(entry);
    if (!Number.isFinite(value)) return;
    let patch: { qty?: number; discountBp?: number; unitPrice?: number };
    if (mode === "qty") patch = { qty: isRefund ? -Math.abs(value) : value };
    else if (mode === "disc") patch = { discountBp: Math.round(Math.min(100, Math.max(0, value)) * 100) };
    else {
      const minor = tryParseMoney(entry);
      if (minor === null) return;
      patch = { unitPrice: minor };
    }
    const apply = () => {
      setCart((c) => updateLine(c, selectedLine.id, patch));
      setEntry("");
    };
    if (needsManager(patch, selectedLine)) {
      setApproval({ reason: mode === "price" ? "Change the price" : "Discount above 10%", apply });
    } else apply();
  };

  const pad = (k: string) => {
    if (k === "back") return setEntry(entry.slice(0, -1));
    if (k === "enter") return applyEntry();
    if (k === "." && entry.includes(".")) return;
    setEntry(entry + k);
  };

  const finish = (order: LocalOrder) => {
    setPaying(false);
    setReceipt(order);
    setCart(emptyCart());
    setSelected(null);
  };

  const clear = () => {
    if (cart.lines.length && !isRefund) {
      setApproval({
        reason: "Void this sale",
        apply: () => {
          setCart(emptyCart());
          setSelected(null);
        },
      });
    } else {
      setCart(emptyCart());
      setSelected(null);
    }
  };

  return (
    <div className="sell">
      <section className="catalog">
        <div className="searchrow">
          <input
            id="search"
            type="search"
            placeholder="Search name or scan barcode"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const exact = items?.find((i) => i.barcode === search.trim() || i.sku === search.trim());
              const only = visible.length === 1 ? visible[0] : undefined;
              const hit = exact ?? only;
              if (hit) {
                add(hit);
                setSearch("");
              }
            }}
          />
          <button type="button" className="btn ghost" onClick={() => setRefunding(true)}>
            Refund
          </button>
        </div>
        <nav className="cats" aria-label="Categories">
          <button type="button" className={categoryId === null ? "chip on" : "chip"} onClick={() => setCategoryId(null)}>
            All
          </button>
          {categories.map((c) => (
            <button key={c.id} type="button" className={categoryId === c.id ? "chip on" : "chip"} onClick={() => setCategoryId(c.id)}>
              {c.name}
            </button>
          ))}
        </nav>
        <div className="grid">
          {visible.map((i) => (
            <button key={i.variantId} type="button" className="tile" onClick={() => add(i)}>
              <span className="name">{i.name}</span>
              {i.nameAr && (
                <span className="name-ar" dir="rtl">
                  {i.nameAr}
                </span>
              )}
              <span className="price">
                {money(i.price)}
                {i.uom === "kg" ? " /kg" : ""}
              </span>
            </button>
          ))}
          {items && visible.length === 0 && <p className="muted">No products match.</p>}
        </div>
      </section>

      <section className="cart" aria-label="Current sale">
        <div className="cart-head">
          <strong>{isRefund ? "Refund" : "Sale"}</strong>
          <span className="muted">{cart.lines.length} lines</span>
        </div>
        <ol className="lines">
          {cart.lines.map((l, idx) => (
            <li key={l.id}>
              <button type="button" className={l.id === selected ? "line on" : "line"} onClick={() => setSelected(l.id)}>
                <span className="n">{idx + 1}</span>
                <span className="desc">
                  {l.name}
                  <small className="muted">
                    {qtyText(l.qty, l.uom)} × {money(l.unitPrice)}
                    {l.discountBp ? ` · ${(l.discountBp / 100).toFixed(2)}% off` : ""}
                  </small>
                </span>
                <span className="amt">{money(totals.lines[idx]?.gross ?? 0)}</span>
              </button>
            </li>
          ))}
          {cart.lines.length === 0 && <li className="empty muted">Scan or tap a product to start.</li>}
        </ol>

        <div className="totals">
          <div>
            <span>Subtotal (excl. VAT)</span>
            <span>{money(totals.subtotalNet)}</span>
          </div>
          {totals.discountTotal !== 0 && (
            <div>
              <span>Discounts</span>
              <span>-{money(totals.discountTotal)}</span>
            </div>
          )}
          <div>
            <span>VAT</span>
            <span>{money(totals.taxTotal)}</span>
          </div>
          <div className="grand">
            <span>Total</span>
            <span>{aed(totals.total)}</span>
          </div>
        </div>

        <div className="padarea">
          <div className="modes">
            {(["qty", "disc", "price"] as PadMode[]).map((m) => (
              <button key={m} type="button" className={mode === m ? "mode on" : "mode"} onClick={() => setMode(m)}>
                {m === "qty" ? "Qty" : m === "disc" ? "% Disc" : "Price"}
              </button>
            ))}
            <button
              type="button"
              className="mode"
              disabled={!selectedLine}
              onClick={() => {
                if (!selectedLine) return;
                setCart(removeLine(cart, selectedLine.id));
                setSelected(null);
              }}
            >
              Delete
            </button>
          </div>
          <div className="entry" aria-live="polite">
            {entry || (selectedLine ? `Edit ${mode} of line ${cart.lines.indexOf(selectedLine) + 1}` : "Select a line")}
          </div>
          <div className="numpad">
            {["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "back"].map((k) => (
              <button key={k} type="button" className="key" onClick={() => pad(k)}>
                {k === "back" ? "⌫" : k}
              </button>
            ))}
            <button type="button" className="key wide" onClick={() => pad("enter")} disabled={!selectedLine}>
              Apply
            </button>
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={clear} disabled={!cart.lines.length}>
              Clear
            </button>
            <button type="button" className="btn primary pay" disabled={!cart.lines.length} onClick={() => setPaying(true)}>
              {isRefund ? "Refund" : "Pay"} {aed(totals.total)}
            </button>
          </div>
        </div>
      </section>

      {paying && (
        <PaymentDialog
          setup={setup}
          cart={cart}
          total={totals.total}
          cashierId={user.id}
          onDone={finish}
          onCancel={() => setPaying(false)}
        />
      )}
      {receipt && <ReceiptView setup={setup} order={receipt} cashier={user} onClose={() => setReceipt(null)} />}
      {weighing && (
        <WeighDialog
          item={weighing}
          onCancel={() => setWeighing(null)}
          onWeight={(kg) => {
            const item = weighing;
            setWeighing(null);
            const next = addItem(cart, item, kg);
            setCart(next);
            setSelected(next.lines.at(-1)!.id);
          }}
        />
      )}
      {approval && (
        <ManagerPin
          reason={approval.reason}
          onCancel={() => setApproval(null)}
          onApprove={() => {
            approval.apply();
            setApproval(null);
          }}
        />
      )}
      {refunding && (
        <RefundDialog
          onCancel={() => setRefunding(false)}
          onStart={(refundCart) => {
            setRefunding(false);
            setCart(refundCart);
            setSelected(null);
          }}
        />
      )}
      {notice && (
        <Modal onClose={() => setNotice(null)}>
          <p>{notice}</p>
          <button type="button" className="btn primary block" onClick={() => setNotice(null)} autoFocus>
            OK
          </button>
        </Modal>
      )}
    </div>
  );
}

/** Manual weight entry. A connected scale will fill this in through the store hub. */
function WeighDialog({ item, onWeight, onCancel }: { item: SellableItem; onWeight: (kg: number) => void; onCancel: () => void }) {
  const [kg, setKg] = useState("");
  const value = Number(kg);
  return (
    <Modal onClose={onCancel}>
      <h2>{item.name}</h2>
      <p className="muted">{money(item.price)} per kg</p>
      <label htmlFor="kg">Weight (kg)</label>
      <input id="kg" inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} autoFocus />
      {value > 0 && <p>Price: {aed(Math.round(item.price * value))}</p>}
      <button type="button" className="btn primary block" disabled={!(value > 0)} onClick={() => onWeight(value)}>
        Add
      </button>
    </Modal>
  );
}
