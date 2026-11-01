import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon.js";
import { ManagerPin } from "../components/ManagerPin.js";
import { Modal } from "../components/Modal.js";
import { Toast } from "../components/Toast.js";
import { addItem, cartTotals, emptyCart, needsManager, removeLine, updateLine, type Cart, type SellableItem } from "../lib/cart.js";
import { db, type DeviceSetup, type LocalOrder, type ParkedSale, type Session, type User } from "../lib/db.js";
import { publishDisplay, receiptUrl } from "../lib/display.js";
import { aed, money, qtyText, tryParseMoney } from "../lib/format.js";
import { useScanner } from "../lib/useScanner.js";
import { PaymentDialog } from "./PaymentDialog.js";
import { ReceiptView } from "./ReceiptView.js";
import { RefundDialog } from "./RefundDialog.js";

type PadMode = "qty" | "disc" | "price";
const MODE_LABEL: Record<PadMode, string> = { qty: "Qty", disc: "% Disc", price: "Price" };

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
  const [noting, setNoting] = useState(false);
  const [showParked, setShowParked] = useState(false);
  const parkedCount = useLiveQuery(() => db.parked.count(), []) ?? 0;

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

  // The customer display follows the cart, then shows the change and the receipt QR.
  useEffect(() => {
    const store = { storeName: setup.store.name, storeNameAr: setup.store.nameAr };
    const zero = { lines: [], subtotalNet: 0, taxTotal: 0, discountTotal: 0, total: 0 };
    if (receipt) {
      const tendered = receipt.payments.reduce((sum, p) => sum + (p.tendered ?? p.amount), 0);
      publishDisplay({
        kind: "paid",
        ...store,
        ...zero,
        total: receipt.totals.total,
        paid: { due: receipt.payment.due, tendered, change: receipt.payment.change, receiptUrl: receiptUrl(setup.publicUrl, receipt.id) },
      });
    } else if (cart.lines.length === 0) {
      publishDisplay({ kind: "idle", ...store, ...zero });
    } else {
      const arabic = new Map((items ?? []).map((i) => [i.variantId, i.nameAr]));
      publishDisplay({
        kind: "cart",
        ...store,
        refund: isRefund,
        lines: cart.lines.map((l, i) => ({
          name: l.name,
          nameAr: arabic.get(l.variantId) ?? null,
          qty: l.qty,
          uom: l.uom,
          gross: totals.lines[i]?.gross ?? 0,
        })),
        subtotalNet: totals.subtotalNet,
        taxTotal: totals.taxTotal,
        discountTotal: totals.discountTotal,
        total: totals.total,
      });
    }
  }, [cart, totals, receipt, items, isRefund, setup]);

  /** Puts this sale aside so the next customer can be served. */
  const park = async () => {
    await db.parked.put({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), cashierName: user.name, cart, total: totals.total });
    setCart(emptyCart());
    setSelected(null);
    setNotice("Sale parked. Open Parked to continue it.");
  };

  const resume = async (p: ParkedSale) => {
    await db.parked.delete(p.id);
    setCart(p.cart);
    setSelected(null);
    setShowParked(false);
  };

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

  // Keep the line being edited (usually the one just scanned) in view.
  useEffect(() => {
    if (selected) document.querySelector(".line.on")?.scrollIntoView({ block: "nearest" });
  }, [selected, cart.lines.length]);

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

  const clearNotice = useCallback(() => setNotice(null), []);

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
      <h1 className="sr-only">Sell</h1>
      <section className="catalog" aria-label="Products">
        <div className="searchrow">
          <div className="searchbox">
            <label htmlFor="search" className="sr-only">
              Search products or scan a barcode
            </label>
            <Icon name="search" />
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
            autoComplete="off"
          />
          </div>
          {parkedCount > 0 && (
            <button type="button" className="btn outline" onClick={() => setShowParked(true)}>
              <Icon name="pause" />
              Parked <span className="count">{parkedCount}</span>
            </button>
          )}
          <button type="button" className="btn outline" onClick={() => setRefunding(true)}>
            <Icon name="refund" />
            Refund
          </button>
        </div>
        <nav className="cats" aria-label="Categories">
          <button type="button" className={categoryId === null ? "chip on" : "chip"} aria-pressed={categoryId === null} onClick={() => setCategoryId(null)}>
            All
          </button>
          {categories.map((c) => (
            <button key={c.id} type="button" className={categoryId === c.id ? "chip on" : "chip"} aria-pressed={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
              {c.name}
            </button>
          ))}
        </nav>
        <div className="grid">
          {visible.map((i) => (
            <button key={i.variantId} type="button" className="tile" onClick={() => add(i)}>
              <span className="name">{i.name}</span>
              {i.nameAr && (
                <span className="name-ar" dir="rtl" lang="ar">
                  {i.nameAr}
                </span>
              )}
              <span className="price">
                {money(i.price)}
                {i.uom === "kg" && <span className="unit"> / kg</span>}
              </span>
            </button>
          ))}
          {items && visible.length === 0 && (
            <div className="no-results">
              <p>No products match “{search || categories.find((c) => c.id === categoryId)?.name}”.</p>
              <button
                type="button"
                className="btn outline"
                onClick={() => {
                  setSearch("");
                  setCategoryId(null);
                }}
              >
                Show all products
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="cart" aria-label="Current sale">
        <div className={isRefund ? "cart-head refund" : "cart-head"}>
          <h2>{isRefund ? "Refund" : "Current sale"}</h2>
          <span className="badge">
            {cart.lines.length} {cart.lines.length === 1 ? "item" : "items"}
          </span>
        </div>
        <ol className="lines">
          {cart.lines.map((l, idx) => (
            <li key={l.id}>
              <button type="button" className={l.id === selected ? "line on" : "line"} aria-pressed={l.id === selected} onClick={() => setSelected(l.id)}>
                <span className="n">{idx + 1}</span>
                <span className="desc">
                  {l.name}
                  <small className="muted">
                    {qtyText(l.qty, l.uom)} × {money(l.unitPrice)}
                    {l.discountBp ? ` · ${(l.discountBp / 100).toFixed(2)}% off` : ""}
                  </small>
                  {l.note && <small className="muted note">“{l.note}”</small>}
                </span>
                <span className="amt">{money(totals.lines[idx]?.gross ?? 0)}</span>
              </button>
            </li>
          ))}
          {cart.lines.length === 0 && (
            <li className="empty">
              <Icon name="search" size={32} />
              Scan a barcode or tap a product to start.
            </li>
          )}
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
          <div className={entry ? "entry typing" : "entry"} aria-live="polite">
            {entry || (selectedLine ? `Edit ${MODE_LABEL[mode].toLowerCase()} of line ${cart.lines.indexOf(selectedLine) + 1}` : "Select a line to change it")}
          </div>
          <div className="numpad">
            {["7", "8", "9", "back", "4", "5", "6", "1", "2", "3", ".", "0"].map((k) => (
              <button
                key={k}
                type="button"
                className={k === "0" ? "key zero" : k === "back" ? "key subtle" : "key"}
                style={{ gridArea: k === "back" ? "bk" : k === "." ? "dot" : `k${k}` }}
                onClick={() => pad(k)}
                aria-label={k === "back" ? "Delete last digit" : undefined}
              >
                {k === "back" ? <Icon name="backspace" /> : k}
              </button>
            ))}
            <button type="button" className="key primary apply" style={{ gridArea: "ap" }} onClick={() => pad("enter")} disabled={!selectedLine || !entry}>
              Apply
            </button>
            {(["qty", "disc", "price"] as PadMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? "mode on" : "mode"}
                style={{ gridArea: m }}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
            <button
              type="button"
              className="mode danger"
              style={{ gridArea: "del" }}
              disabled={!selectedLine}
              aria-label="Delete selected line"
              onClick={() => {
                if (!selectedLine) return;
                setCart(removeLine(cart, selectedLine.id));
                setSelected(null);
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={clear} disabled={!cart.lines.length}>
              Clear
            </button>
            {!isRefund && (
              <>
                <button type="button" className="btn ghost" onClick={() => setNoting(true)} disabled={!selectedLine}>
                  <Icon name="note" size={18} />
                  Note
                </button>
                <button type="button" className="btn ghost" onClick={() => void park()} disabled={!cart.lines.length}>
                  <Icon name="pause" size={18} />
                  Park
                </button>
              </>
            )}
            <button type="button" className="btn primary pay" disabled={!cart.lines.length} onClick={() => setPaying(true)}>
              <span>{isRefund ? "Refund" : "Pay"}</span>
              <span>{aed(totals.total)}</span>
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
      {receipt && (
        <ReceiptView
          setup={setup}
          order={receipt}
          cashier={user}
          onClose={() => {
            setReceipt(null);
            // Ready for the next customer's first scan.
            requestAnimationFrame(() => document.getElementById("search")?.focus());
          }}
        />
      )}
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
      {noting && selectedLine && (
        <NoteDialog
          line={selectedLine.name}
          initial={selectedLine.note ?? ""}
          onCancel={() => setNoting(false)}
          onSave={(note) => {
            setCart((c) => updateLine(c, selectedLine.id, { note: note || undefined }));
            setNoting(false);
          }}
        />
      )}
      {showParked && (
        <ParkedDialog
          busy={cart.lines.length > 0}
          onResume={(p) => void resume(p)}
          onDiscard={(p) => void db.parked.delete(p.id)}
          onClose={() => setShowParked(false)}
        />
      )}
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}

function NoteDialog({ line, initial, onSave, onCancel }: { line: string; initial: string; onSave: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState(initial);
  return (
    <Modal onClose={onCancel} label={`Note for ${line}`}>
      <h2>Note for {line}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(note.trim());
        }}
      >
        <label htmlFor="line-note">Note (prints on the receipt)</label>
        <input id="line-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. gift wrap, size swap" autoFocus />
        <div className="actions">
          {initial && (
            <button type="button" className="btn ghost danger" onClick={() => onSave("")}>
              Remove note
            </button>
          )}
          <button type="submit" className="btn primary">
            Save note
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Sales put aside on this till, oldest first. */
function ParkedDialog({
  busy,
  onResume,
  onDiscard,
  onClose,
}: {
  busy: boolean;
  onResume: (p: ParkedSale) => void;
  onDiscard: (p: ParkedSale) => void;
  onClose: () => void;
}) {
  const loaded = useLiveQuery(() => db.parked.orderBy("createdAt").toArray(), []);
  const parked = loaded ?? [];
  const [confirm, setConfirm] = useState<string | null>(null);
  // Close by itself once the last parked sale is continued or discarded (not while loading).
  useEffect(() => {
    if (loaded && loaded.length === 0) onClose();
  }, [loaded, onClose]);
  return (
    <Modal onClose={onClose} label="Parked sales" wide>
      <h2>Parked sales</h2>
      {busy && <p className="muted">Park or clear the current sale before you continue another one.</p>}
      <ul className="parked">
        {parked.map((p) => (
          <li key={p.id}>
            <span className="desc">
              <strong>{aed(p.total)}</strong>
              <small className="muted">
                {p.cart.lines.length} {p.cart.lines.length === 1 ? "item" : "items"} · {p.cashierName} ·{" "}
                {new Date(p.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </small>
              <small className="muted">{p.cart.lines.slice(0, 3).map((l) => l.name).join(", ")}{p.cart.lines.length > 3 ? "…" : ""}</small>
            </span>
            {confirm === p.id ? (
              <>
                <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
                  Keep
                </button>
                <button type="button" className="btn outline danger" onClick={() => onDiscard(p)}>
                  Yes, discard
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn ghost danger" onClick={() => setConfirm(p.id)}>
                  Discard
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => onResume(p)}>
                  Continue
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Manual weight entry. A connected scale will fill this in through the store hub. */
function WeighDialog({ item, onWeight, onCancel }: { item: SellableItem; onWeight: (kg: number) => void; onCancel: () => void }) {
  const [kg, setKg] = useState("");
  const value = Number(kg);
  return (
    <Modal onClose={onCancel} label={`Weigh ${item.name}`}>
      <h2>{item.name}</h2>
      <p className="muted">AED {money(item.price)} per kg</p>
      <label htmlFor="kg">Weight (kg)</label>
      <input
        id="kg"
        inputMode="decimal"
        value={kg}
        onChange={(e) => setKg(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value > 0 && onWeight(value)}
        placeholder="0.000"
        autoFocus
      />
      <p className="muted" aria-live="polite">{value > 0 ? `Price: ${aed(Math.round(item.price * value))}` : "Put the item on the scale or type its weight."}</p>
      <button type="button" className="btn primary block" disabled={!(value > 0)} onClick={() => onWeight(value)}>
        Add
      </button>
    </Modal>
  );
}
