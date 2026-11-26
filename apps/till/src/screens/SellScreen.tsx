import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon.js";
import { ManagerPin, type RemoteAsk } from "../components/ManagerPin.js";
import { StrandedCards } from "../components/StrandedCards.js";
import { Modal } from "../components/Modal.js";
import { Toast } from "../components/Toast.js";
import { maskGiftCard, parseScaleBarcode } from "@pos/core";
import {
  addCode,
  addGiftCard,
  addItem,
  addScaleItem,
  cartTotals,
  emptyCart,
  needsManager,
  promoteCart,
  removeCode,
  removeLine,
  repriceCart,
  setCustomer,
  updateLine,
  type Cart,
  type SellableItem,
} from "../lib/cart.js";
import { db, type DeviceSetup, type LocalOrder, type ParkedSale, type Session, type User } from "../lib/db.js";
import { publishDisplay, receiptUrl } from "../lib/display.js";
import { aed, money, qtyText, tryParseMoney } from "../lib/format.js";
import { itemCount, t } from "../lib/i18n.js";
import { logTillEvent } from "../lib/till.js";
import { useScaleRules } from "../lib/scale.js";
import { useScale } from "../lib/scaleReader.js";
import { ScaleWeight } from "../components/ScaleSetup.js";
import { usePricing } from "../lib/usePricing.js";
import { useScanner } from "../lib/useScanner.js";
import { CouponDialog } from "./CouponDialog.js";
import { GiftCardDialog } from "./GiftCardDialog.js";
import { useLoyalty } from "../lib/loyalty.js";
import { CustomerDialog } from "./CustomerDialog.js";
import { PaymentDialog } from "./PaymentDialog.js";
import { ReceiptView } from "./ReceiptView.js";
import { RefundDialog } from "./RefundDialog.js";
import { useWebOrders, WebOrdersDialog } from "./WebOrdersDialog.js";
import { useSyncStatus } from "../lib/useSync.js";

type PadMode = "qty" | "disc" | "price";
const MODE_LABEL: Record<PadMode, string> = { qty: "Qty", disc: "% Disc", price: "Price" };

interface Props {
  setup: DeviceSetup;
  user: User;
  session: Session;
  onMenu: () => void;
}

export function SellScreen({ setup, user, session }: Props) {
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<PadMode>("qty");
  const [entry, setEntry] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<LocalOrder | null>(null);
  const [receiptPhone, setReceiptPhone] = useState<string | null>(null);
  const [weighing, setWeighing] = useState<SellableItem | null>(null);
  const [approval, setApproval] = useState<{ reason: string; ask: RemoteAsk; apply: (approvedBy: string, approvalId?: string) => void } | null>(null);
  const [refunding, setRefunding] = useState(false);
  const scaleRules = useScaleRules();
  const [refundOk, setRefundOk] = useState<{ orderId: string; amount: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [showParked, setShowParked] = useState(false);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showCoupon, setShowCoupon] = useState(false);
  const [showGiftCard, setShowGiftCard] = useState(false);
  const [showWebOrders, setShowWebOrders] = useState(false);
  const { online } = useSyncStatus();
  const webOrders = useWebOrders(online);
  const newWebOrders = webOrders.orders?.filter((o) => o.status === "new").length ?? 0;
  const loyalty = useLoyalty();
  // Happy-hour promotions start and stop by the clock, so the sale is re-priced each minute.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(timer);
  }, []);
  const pricing = usePricing(setup, cart.customer?.priceListId);
  const parkedCount = useLiveQuery(() => db.parked.count(), []) ?? 0;

  const categories = useLiveQuery(() => db.categories.orderBy("sort").filter((c) => c.active).toArray(), []) ?? [];
  const taxes = useLiveQuery(async () => Object.fromEntries((await db.taxes.toArray()).map((t) => [t.id, t])), []) ?? {};
  const catalog = useLiveQuery(async () => {
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
          extraBarcodes: v.extraBarcodes ?? [],
          sku: v.sku,
          plu: v.plu ?? null,
          categoryId: p.categoryId,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);
  // Tiles and scans use this sale's prices (price lists).
  const items = useMemo(
    () => (catalog && pricing ? catalog.map((i) => ({ ...i, price: pricing.priceOf(i.variantId) ?? i.price })) : catalog),
    [catalog, pricing],
  );

  // A customer with their own price list (or a change to the lists) re-prices the sale.
  useEffect(() => {
    if (pricing) setCart((c) => (c.refundOfOrderId ? c : repriceCart(c, pricing.priceOf)));
  }, [pricing]);

  const promoted = useMemo(
    // `minute` is read so the promotions are worked out again as the clock moves.
    () => (pricing && minute ? promoteCart(cart, pricing.env, new Date()) : { cart, applied: [], unknownCodes: [] }),
    [cart, pricing, minute],
  );
  const promoNames = useMemo(() => new Map((pricing?.env.promotions ?? []).map((p) => [p.id, p.name])), [pricing]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (!categoryId || i.categoryId === categoryId) &&
        (!q || i.name.toLowerCase().includes(q) || (i.barcode === q || i.extraBarcodes.includes(q)) || i.sku?.toLowerCase() === q || i.nameAr?.includes(q)),
    );
  }, [items, search, categoryId]);

  const totals = useMemo(() => cartTotals(promoted.cart, taxes), [promoted, taxes]);
  const promoTotal = promoted.applied.reduce((s, a) => s + a.amount, 0);
  const isRefund = cart.refundOfOrderId !== null;

  /**
   * Runs something a cashier needs a manager for. A manager or owner on the till goes ahead;
   * a cashier gets the manager PIN, or can ask the owner on their phone.
   */
  const withManager = (reason: string, ask: Omit<RemoteAsk, "userId">, apply: (approvedBy: string, approvalId?: string) => void) => {
    if (user.role !== "cashier") apply(user.id);
    else setApproval({ reason, ask: { ...ask, userId: user.id }, apply });
  };

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
          nameAr: l.variantId ? (arabic.get(l.variantId) ?? null) : null,
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
    setNotice(t("Sale parked. Open Parked to continue it."));
  };

  const resume = async (p: ParkedSale) => {
    await db.parked.delete(p.id);
    setCart(p.cart);
    setSelected(null);
    setShowParked(false);
  };

  const add = (item: SellableItem, qty = 1) => {
    if (isRefund) return setNotice(t("Finish or clear the refund before adding items"));
    if (item.uom === "kg" && qty === 1) return setWeighing(item);
    const next = addItem(cart, item, qty);
    setCart(next);
    setSelected(next.lines.find((l) => l.variantId === item.variantId && l.qty >= qty)?.id ?? next.lines.at(-1)!.id);
    setEntry("");
  };

  const scan = (code: string) => {
    const hit = items?.find((i) => i.barcode === code || i.extraBarcodes.includes(code) || i.sku === code);
    if (hit) return add(hit);
    // A label printed by the shop's scale: item code plus weight or price.
    const label = parseScaleBarcode(code, scaleRules);
    if (!label) return setNotice(t("No product with barcode {code}", { code }));
    if (isRefund) return setNotice(t("Finish or clear the refund before adding items"));
    const item = items?.find((i) => i.plu === label.plu);
    if (!item) return setNotice(t("No product with scale code {plu}. Add the code to the product in the back office.", { plu: label.plu }));
    const next = addScaleItem(cart, item, label, code);
    if (!next) return setNotice(t("{name} is sold by the piece, but this label has a weight.", { name: item.name }));
    setCart(next);
    setSelected(next.lines.at(-1)!.id);
    setEntry("");
  };
  useScanner(scan);

  const selectedLine = cart.lines.find((l) => l.id === selected);

  // Keep the line being edited (usually the one just scanned) in view.
  useEffect(() => {
    if (selected) document.querySelector(".line.on")?.scrollIntoView({ block: "nearest" });
  }, [selected, cart.lines.length]);

  const applyEntry = () => {
    if (!selectedLine || entry === "") return;
    if (selectedLine.giftCardCode) {
      setEntry("");
      return setNotice(t("A gift card's amount is set when it is added. Delete the line and add it again to change it."));
    }
    if (selectedLine.scaleLabel && mode !== "disc") {
      setEntry("");
      return setNotice(t("This line comes from a scale label. Weigh the item again for a new label."));
    }
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
      // The pad starts empty again whatever the manager or owner decides.
      setEntry("");
      const price = patch.unitPrice !== undefined;
      const summary = price
        ? `Price of ${selectedLine.name} from AED ${money(selectedLine.unitPrice)} to AED ${money(patch.unitPrice!)}`
        : `${(patch.discountBp ?? 0) / 100}% off ${selectedLine.name} (AED ${money(selectedLine.unitPrice * Math.abs(selectedLine.qty))})`;
      const kind = price ? "price_override" : "discount";
      withManager(price ? t("Change the price") : t("Discount above 10%"), { kind, summary }, (approvedBy, approvalId) => {
        apply();
        void logTillEvent({ kind, sessionId: session.id, userId: user.id, approvedBy, approvalId, summary, details: { variantId: selectedLine.variantId } });
      });
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
    setReceiptPhone(cart.customer?.phone ?? null);
    setCart(emptyCart());
    setSelected(null);
  };

  const clearNotice = useCallback(() => setNotice(null), []);

  /** A cashier's refund needs a manager (or the owner from their phone) before money goes back. */
  const startPaying = () => {
    if (!isRefund) return setPaying(true);
    const amount = Math.abs(totals.total);
    // Approved once for this refund; asked again only if it has grown since.
    if (refundOk && refundOk.orderId === cart.refundOfOrderId && amount <= refundOk.amount) return setPaying(true);
    const summary = `Refund AED ${money(amount)}${cart.refundOfNumber ? ` on bill ${cart.refundOfNumber}` : ""}`;
    withManager(t("Refund"), { kind: "refund", summary, amount }, (approvedBy, approvalId) => {
      setRefundOk({ orderId: cart.refundOfOrderId!, amount });
      setPaying(true);
      void logTillEvent({
        kind: "refund",
        sessionId: session.id,
        userId: user.id,
        approvedBy,
        approvalId,
        summary,
        amount,
        details: { refundOfOrderId: cart.refundOfOrderId },
      });
    });
  };

  const clear = () => {
    if (cart.lines.length && !isRefund) {
      const count = cart.lines.reduce((n, l) => n + (l.uom === "kg" ? 1 : Math.abs(l.qty)), 0);
      const summary = `Void a sale of ${count} item${count === 1 ? "" : "s"}, AED ${money(totals.total)}`;
      const voided = cart.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice }));
      withManager(t("Void this sale"), { kind: "void", summary, amount: totals.total }, (approvedBy, approvalId) => {
        setCart(emptyCart());
        setSelected(null);
        void logTillEvent({ kind: "void", sessionId: session.id, userId: user.id, approvedBy, approvalId, summary, amount: totals.total, details: { lines: voided } });
      });
    } else {
      setCart(emptyCart());
      setSelected(null);
    }
  };

  return (
    <div className="sell">
      <h1 className="sr-only">{t("Sell")}</h1>
      <StrandedCards userId={user.id} />
      <section className="catalog" aria-label={t("Products")}>
        <div className="searchrow">
          <div className="searchbox">
            <label htmlFor="search" className="sr-only">
              {t("Search products or scan a barcode")}
            </label>
            <Icon name="search" />
            <input
            id="search"
            type="search"
            placeholder={t("Search name or scan barcode")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const exact = items?.find((i) => i.barcode === search.trim() || i.extraBarcodes.includes(search.trim()) || i.sku === search.trim());
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
              {t("Parked")} <span className="count">{parkedCount}</span>
            </button>
          )}
          <button
            type="button"
            className="btn outline"
            onClick={() => (isRefund ? setNotice(t("Finish or clear the refund before adding items")) : setShowGiftCard(true))}
          >
            <Icon name="gift" />
            {t("Gift card")}
          </button>
          <button type="button" className="btn outline" onClick={() => setRefunding(true)}>
            <Icon name="refund" />
            {t("Refund")}
          </button>
          {(webOrders.orders?.length ?? 0) > 0 && (
            <button type="button" className="btn outline" onClick={() => setShowWebOrders(true)}>
              <Icon name="online" />
              {t("Online orders")} <span className={newWebOrders ? "count" : "count quiet"}>{webOrders.orders!.length}</span>
            </button>
          )}
        </div>
        <nav className="cats" aria-label={t("Categories")}>
          <button type="button" className={categoryId === null ? "chip on" : "chip"} aria-pressed={categoryId === null} onClick={() => setCategoryId(null)}>
            {t("All")}
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
                <bdi>
                  {money(i.price)}
                  {i.uom === "kg" && <span className="unit"> / kg</span>}
                </bdi>
              </span>
            </button>
          ))}
          {items && visible.length === 0 && (
            <div className="no-results">
              <p>{t("No products match “{q}”.", { q: search || categories.find((c) => c.id === categoryId)?.name || "" })}</p>
              <button
                type="button"
                className="btn outline"
                onClick={() => {
                  setSearch("");
                  setCategoryId(null);
                }}
              >
                {t("Show all products")}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="cart" aria-label={t("Current sale")}>
        <div className={isRefund ? "cart-head refund" : "cart-head"}>
          <h2>{isRefund ? t("Refund") : cart.webOrderNumber ? t("Online order {n}", { n: cart.webOrderNumber }) : t("Current sale")}</h2>
          <span className="badge">{itemCount(cart.lines.length)}</span>
        </div>
        {!isRefund && (
          <div className="cart-tags">
            <button
              type="button"
              className={cart.customer ? "cust on" : "cust"}
              onClick={() => setShowCustomer(true)}
              aria-label={cart.customer ? t("Customer: {name}", { name: cart.customer.name }) : t("Add customer")}
            >
              <Icon name="user" size={16} />
              <span className="cust-name">{cart.customer ? cart.customer.name : t("Customer")}</span>
              {pricing?.listName && <span className="cust-list">{pricing.listName}</span>}
              {loyalty.enabled && cart.customer?.points !== undefined && (
                <span className="cust-list">{t("{n} pts", { n: cart.customer.points })}</span>
              )}
            </button>
            <button
              type="button"
              className={cart.codes?.length ? "cust coupon on" : "cust coupon"}
              onClick={() => setShowCoupon(true)}
              aria-label={cart.codes?.length ? t("Coupons: {codes}", { codes: cart.codes.join(", ") }) : t("Add coupon")}
            >
              <Icon name="ticket" size={16} />
              <span className="cust-name">{cart.codes?.length ? cart.codes.join(", ") : t("Coupon")}</span>
            </button>
          </div>
        )}
        <ol className="lines">
          {cart.lines.map((l, idx) => (
            <li key={l.id}>
              <button type="button" className={l.id === selected ? "line on" : "line"} aria-pressed={l.id === selected} onClick={() => setSelected(l.id)}>
                <span className="n">{idx + 1}</span>
                <span className="desc">
                  {l.giftCardCode ? `${t("Gift card")} ${maskGiftCard(l.giftCardCode)}` : l.name}
                  <small className="muted">
                    <bdi>
                      {qtyText(l.qty, l.uom)} × {money(l.unitPrice)}
                    </bdi>
                    {l.discountBp ? ` · ${t("{pct}% off", { pct: (l.discountBp / 100).toFixed(2) })}` : ""}
                  </small>
                  {(() => {
                    const p = promoted.cart.lines[idx];
                    const name = p?.promotionId ? promoNames.get(p.promotionId) : null;
                    return name ? (
                      <small className="promo">
                        <Icon name="tag" size={14} />
                        {name}
                      </small>
                    ) : null;
                  })()}
                  {l.note && <small className="muted note">“{l.note}”</small>}
                </span>
                <span className="amt">{money(totals.lines[idx]?.gross ?? 0)}</span>
              </button>
            </li>
          ))}
          {cart.lines.length === 0 && (
            <li className="empty">
              <Icon name="search" size={32} />
              {t("Scan a barcode or tap a product to start.")}
            </li>
          )}
        </ol>

        <div className="totals">
          <div>
            <span>{t("Subtotal (excl. VAT)")}</span>
            <span>{money(totals.subtotalNet)}</span>
          </div>
          {promoted.applied.map((a) => (
            <div key={a.promotionId} className="promo">
              <span>
                {a.name}
                {a.code ? ` (${a.code})` : ""}
              </span>
              <span>-{money(a.amount)}</span>
            </div>
          ))}
          {totals.discountTotal - promoTotal !== 0 && (
            <div>
              <span>{t("Discounts")}</span>
              <span>-{money(Math.abs(totals.discountTotal - promoTotal))}</span>
            </div>
          )}
          <div>
            <span>{t("VAT")}</span>
            <span>{money(totals.taxTotal)}</span>
          </div>
          <div className="grand">
            <span>{t("Total")}</span>
            <span>{aed(totals.total)}</span>
          </div>
        </div>

        <div className="padarea">
          <div className={entry ? "entry typing" : "entry"} aria-live="polite">
            {entry ||
              (selectedLine
                ? t("Edit {mode} of line {n}", { mode: t(MODE_LABEL[mode]).toLowerCase(), n: cart.lines.indexOf(selectedLine) + 1 })
                : t("Select a line to change it"))}
          </div>
          <div className="numpad">
            {["7", "8", "9", "back", "4", "5", "6", "1", "2", "3", ".", "0"].map((k) => (
              <button
                key={k}
                type="button"
                className={k === "0" ? "key zero" : k === "back" ? "key subtle" : "key"}
                style={{ gridArea: k === "back" ? "bk" : k === "." ? "dot" : `k${k}` }}
                onClick={() => pad(k)}
                aria-label={k === "back" ? t("Delete last digit") : undefined}
              >
                {k === "back" ? <Icon name="backspace" /> : k}
              </button>
            ))}
            <button type="button" className="key primary apply" style={{ gridArea: "ap" }} onClick={() => pad("enter")} disabled={!selectedLine || !entry}>
              {t("Apply")}
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
                {t(MODE_LABEL[m])}
              </button>
            ))}
            <button
              type="button"
              className="mode danger"
              style={{ gridArea: "del" }}
              disabled={!selectedLine}
              aria-label={t("Delete selected line")}
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
              {t("Clear")}
            </button>
            {!isRefund && (
              <>
                <button type="button" className="btn ghost" onClick={() => setNoting(true)} disabled={!selectedLine}>
                  <Icon name="note" size={18} />
                  {t("Note")}
                </button>
                <button type="button" className="btn ghost" onClick={() => void park()} disabled={!cart.lines.length}>
                  <Icon name="pause" size={18} />
                  {t("Park")}
                </button>
              </>
            )}
            <button type="button" className="btn primary pay" disabled={!cart.lines.length} onClick={startPaying}>
              <span>{isRefund ? t("Refund") : t("Pay")}</span>
              <span>{aed(totals.total)}</span>
            </button>
          </div>
        </div>
      </section>

      {showGiftCard && (
        <GiftCardDialog
          onClose={() => setShowGiftCard(false)}
          onAdd={(code, amount) => {
            const next = addGiftCard(cart, code, amount);
            setCart(next);
            setSelected(next.lines.at(-1)!.id);
            setShowGiftCard(false);
          }}
        />
      )}
      {paying && (
        <PaymentDialog
          setup={setup}
          cart={promoted.cart}
          promotions={promoted.applied}
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
          phone={receiptPhone}
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
          ask={approval.ask}
          onApprove={(managerId, approvalId) => {
            approval.apply(managerId, approvalId);
            setApproval(null);
          }}
        />
      )}
      {showWebOrders && (
        <WebOrdersDialog
          orders={webOrders.orders}
          error={webOrders.error}
          reload={webOrders.reload}
          items={items ?? []}
          userId={user.id}
          busy={cart.lines.length > 0}
          onClose={() => setShowWebOrders(false)}
          onRingUp={(c) => {
            setShowWebOrders(false);
            setCart(c);
            setSelected(null);
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
      {showCustomer && (
        <CustomerDialog
          current={cart.customer ?? null}
          onCancel={() => setShowCustomer(false)}
          onPick={(c) => {
            setCart((x) => setCustomer(x, c));
            setShowCustomer(false);
          }}
        />
      )}
      {showCoupon && pricing && (
        <CouponDialog
          codes={cart.codes ?? []}
          appliedCodes={promoted.applied.map((a) => a.code).filter((c): c is string => !!c)}
          promotions={pricing.env.promotions}
          storeId={setup.store.id}
          timezone={setup.store.timezone}
          onAdd={(c) => setCart((x) => addCode(x, c))}
          onRemove={(c) => setCart((x) => removeCode(x, c))}
          onClose={() => setShowCoupon(false)}
        />
      )}
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}

function NoteDialog({ line, initial, onSave, onCancel }: { line: string; initial: string; onSave: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState(initial);
  return (
    <Modal onClose={onCancel} label={t("Note for {line}", { line })}>
      <h2>{t("Note for {line}", { line })}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(note.trim());
        }}
      >
        <label htmlFor="line-note">{t("Note (prints on the receipt)")}</label>
        <input id="line-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t("e.g. gift wrap, size swap")} autoFocus />
        <div className="actions">
          {initial && (
            <button type="button" className="btn ghost danger" onClick={() => onSave("")}>
              {t("Remove note")}
            </button>
          )}
          <button type="submit" className="btn primary">
            {t("Save note")}
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
    <Modal onClose={onClose} label={t("Parked sales")} wide>
      <h2>{t("Parked sales")}</h2>
      {busy && <p className="muted">{t("Park or clear the current sale before you continue another one.")}</p>}
      <ul className="parked">
        {parked.map((p) => (
          <li key={p.id}>
            <span className="desc">
              <strong>{aed(p.total)}</strong>
              <small className="muted">
                {itemCount(p.cart.lines.length)} · {p.cashierName} ·{" "}
                {new Date(p.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </small>
              <small className="muted">{p.cart.lines.slice(0, 3).map((l) => l.name).join(", ")}{p.cart.lines.length > 3 ? "…" : ""}</small>
            </span>
            {confirm === p.id ? (
              <>
                <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
                  {t("Keep")}
                </button>
                <button type="button" className="btn outline danger" onClick={() => onDiscard(p)}>
                  {t("Yes, discard")}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn ghost danger" onClick={() => setConfirm(p.id)}>
                  {t("Discard")}
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => onResume(p)}>
                  {t("Continue")}
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
  const scale = useScale();
  const onScale = scale.reading?.stable && scale.reading.kg > 0 ? scale.reading.kg : null;
  return (
    <Modal onClose={onCancel} label={t("Weigh {name}", { name: item.name })}>
      <h2>{item.name}</h2>
      <p className="muted">{t("AED {price} per kg", { price: money(item.price) })}</p>
      <label htmlFor="kg">{t("Weight (kg)")}</label>
      <input
        id="kg"
        inputMode="decimal"
        value={kg}
        onChange={(e) => setKg(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value > 0 && onWeight(value)}
        placeholder="0.000"
        autoFocus
      />
      <p className="muted" aria-live="polite">{value > 0 ? t("Price: {price}", { price: aed(Math.round(item.price * value)) }) : t("Put the item on the scale or type its weight.")}</p>
      <ScaleWeight pricePerKg={item.price} />
      {scale.status === "on" && (
        <button type="button" className="btn outline block" disabled={!onScale} onClick={() => onScale && onWeight(onScale)}>
          <Icon name="scale" size={18} />
          {onScale ? t("Add {kg} kg from the scale", { kg: onScale.toFixed(3) }) : t("Waiting for a steady weight…")}
        </button>
      )}
      <button type="button" className="btn primary block" disabled={!(value > 0)} onClick={() => onWeight(value)}>
        {t("Add")}
      </button>
    </Modal>
  );
}
