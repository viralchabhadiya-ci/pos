import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DineIn } from "./DineIn.js";
import { ApiError, shopApi } from "./lib/api.js";
import { countItems, loadBasket, saveBasket, setQty, stepOf, type Basket } from "./lib/basket.js";
import { aed, qtyText } from "./lib/format.js";
import { itemsText, setLang, t, useLang } from "./lib/i18n.js";

interface Store {
  id: string;
  name: string;
  nameAr: string | null;
  address: string | null;
  phone: string | null;
}
interface Product {
  variantId: string;
  productId: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  uom: string | null;
  categoryId: string | null;
  price: number;
  inStock: boolean;
}
interface ShopData {
  shop: { slug: string; name: string; notice: string | null; minOrder: number; readyMinutes: number };
  stores: Store[];
  storeId: string;
  categories: { id: string; name: string; nameAr: string | null }[];
  products: Product[];
}
interface Quote {
  lines: { variantId: string; name: string; qty: number; price: number; total: number }[];
  total: number;
  minOrder: number;
}
interface OrderView {
  number: string;
  status: "new" | "accepted" | "ready" | "collected" | "cancelled";
  name: string;
  lines: { name: string; qty: number }[];
  total: number;
  pickupCode: string;
  note: string | null;
  cancelReason: string | null;
  store: { name: string; nameAr: string | null; address: string | null; phone: string | null };
  shop: { name: string; slug: string };
}

/* ---------- Address: #/<shop> and #/<shop>/order/<token> ---------- */

const hashStore = (f: () => void) => (window.addEventListener("hashchange", f), () => window.removeEventListener("hashchange", f));
function useRoute() {
  const hash = useSyncExternalStore(hashStore, () => location.hash);
  const [slug = "", kind, token] = hash.replace(/^#\/?/, "").split("/");
  // #/t/<token>: the QR code on a table; #/k/<token>: a self-order kiosk.
  if ((slug === "t" || slug === "k") && kind) return { slug: "", dineIn: { kind: slug === "t" ? ("table" as const) : ("kiosk" as const), token: kind } };
  return { slug: decodeURIComponent(slug).toLowerCase(), token: kind === "order" ? token : undefined };
}
const go = (path: string) => {
  location.hash = path;
  window.scrollTo(0, 0);
};

/** Names in Arabic when the business gave one. */
export const local = (x: { name: string; nameAr?: string | null }, lang: string) => (lang === "ar" && x.nameAr ? x.nameAr : x.name);

export function App() {
  const { slug, token, dineIn } = useRoute();
  useLang();
  if (dineIn) return <DineIn key={dineIn.token} kind={dineIn.kind} token={dineIn.token} />;
  if (!slug) return <Closed />;
  return token ? <OrderPage key={token} slug={slug} token={token} /> : <ShopPage key={slug} slug={slug} />;
}

function LangToggle() {
  const lang = useLang();
  return (
    <button type="button" className="lang" onClick={() => setLang(lang === "ar" ? "en" : "ar")} lang={lang === "ar" ? "en" : "ar"}>
      {lang === "ar" ? "English" : "عربي"}
    </button>
  );
}

export function Header({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="top">
      <div className="top-text">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <LangToggle />
    </header>
  );
}

function Closed({ message }: { message?: string }) {
  return (
    <main className="page center">
      <Header title={t("This shop is not open online")} />
      <p className="muted">{message ?? t("Open the link the shop gave you.")}</p>
    </main>
  );
}

export function Problem({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="btn ghost small" onClick={onRetry}>
          {t("Try again")}
        </button>
      )}
    </div>
  );
}

/* ---------- The shop ---------- */

function ShopPage({ slug }: { slug: string }) {
  const lang = useLang();
  const [data, setData] = useState<ShopData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [storeId, setStoreId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`shop-store:${slug}`);
    } catch {
      return null;
    }
  });
  const [basket, setBasket] = useState<Basket>(() => loadBasket(slug));
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    shopApi<ShopData>(`${encodeURIComponent(slug)}${storeId ? `?store=${storeId}` : ""}`)
      .then((d) => {
        setData(d);
        document.title = d.shop.name;
      })
      .catch((e: ApiError) => setError(e));
  }, [slug, storeId]);
  useEffect(load, [load]);

  const changeBasket = (b: Basket) => {
    setBasket(b);
    saveBasket(slug, b);
  };
  const chooseStore = (id: string) => {
    setStoreId(id);
    try {
      localStorage.setItem(`shop-store:${slug}`, id);
    } catch {
      // Remembered for this visit only.
    }
  };

  const byVariant = useMemo(() => new Map((data?.products ?? []).map((p) => [p.variantId, p])), [data]);
  // Items this store doesn't sell drop out of the basket when the store changes.
  const lines = Object.entries(basket).filter(([id]) => byVariant.get(id)?.inStock);
  const estimate = lines.reduce((s, [id, q]) => s + Math.round(byVariant.get(id)!.price * q), 0);

  if (error?.status === 404) return <Closed />;
  if (!data)
    return (
      <main className="page">
        <Header title=" " />
        {error ? <Problem text={error.message} onRetry={load} /> : <div className="skeleton" aria-busy="true" />}
      </main>
    );

  const q = query.trim().toLowerCase();
  const shown = data.products.filter(
    (p) => (!category || p.categoryId === category) && (!q || p.name.toLowerCase().includes(q) || (p.nameAr ?? "").includes(q)),
  );
  const store = data.stores.find((s) => s.id === data.storeId)!;

  return (
    <main className="page has-bar">
      <Header title={data.shop.name} sub={t("Order online, collect in store")} />
      <section className="intro">
        <p>
          {t("Pay when you collect.")} {t("Usually ready in {n} minutes.", { n: data.shop.readyMinutes })}
        </p>
        {data.shop.notice && <p className="notice" dir="auto">{data.shop.notice}</p>}
        {data.stores.length > 1 ? (
          <label className="field">
            <span>{t("Collect from")}</span>
            <select value={data.storeId} onChange={(e) => chooseStore(e.target.value)}>
              {data.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {local(s, lang)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="muted small">
            {t("Collect from")}: <strong>{local(store, lang)}</strong>
            {store.address ? ` · ${store.address}` : ""}
          </p>
        )}
      </section>

      {data.products.length === 0 ? (
        <p className="empty">{t("Nothing is for sale online yet.")}</p>
      ) : (
        <>
          <div className="filters">
            <input type="search" className="search" placeholder={t("Search products")} aria-label={t("Search")} value={query} onChange={(e) => setQuery(e.target.value)} />
            {data.categories.length > 1 && (
              <div className="chips" role="group">
                <button type="button" className="chip" aria-pressed={!category} onClick={() => setCategory(null)}>
                  {t("All")}
                </button>
                {data.categories.map((c) => (
                  <button key={c.id} type="button" className="chip" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                    {local(c, lang)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="empty">{t("Nothing matches.")}</p>
          ) : (
            <ul className="products">
              {shown.map((p) => (
                <ProductRow key={p.variantId} p={p} qty={basket[p.variantId] ?? 0} onQty={(n) => changeBasket(setQty(basket, p.variantId, n))} />
              ))}
            </ul>
          )}
        </>
      )}

      {lines.length > 0 && !open && (
        <div className="bar">
          <button type="button" className="btn primary bar-btn" onClick={() => setOpen(true)}>
            <span>{t("View basket")}</span>
            <span className="muted-on-accent">{itemsText(lines.length)}</span>
            <span className="tnum">{aed(estimate)}</span>
          </button>
        </div>
      )}

      {open && (
        <Checkout
          data={data}
          basket={Object.fromEntries(lines)}
          byVariant={byVariant}
          onBasket={changeBasket}
          onClose={() => setOpen(false)}
          onPlaced={(token) => {
            changeBasket({});
            go(`/${slug}/order/${token}`);
          }}
          onStale={load}
        />
      )}
    </main>
  );
}

function Stepper({ p, qty, onQty }: { p: Product; qty: number; onQty: (n: number) => void }) {
  const step = stepOf(p.uom);
  const name = local(p, useLang());
  return (
    <div className="stepper" role="group" aria-label={name}>
      <button type="button" aria-label={t("Less")} onClick={() => onQty(qty - step)}>
        −
      </button>
      <span className="tnum" aria-live="polite">
        {qtyText(qty)}
        {p.uom === "kg" ? " kg" : ""}
      </span>
      <button type="button" aria-label={t("More")} onClick={() => onQty(qty + step)}>
        +
      </button>
    </div>
  );
}

function ProductRow({ p, qty, onQty }: { p: Product; qty: number; onQty: (n: number) => void }) {
  const lang = useLang();
  return (
    <li className={`product${p.inStock ? "" : " out"}`}>
      <div className="product-text">
        <strong>{local(p, lang)}</strong>
        {p.description && <span className="desc" dir="auto">{p.description}</span>}
        <span className="price tnum">
          {aed(p.price)}
          {p.uom === "kg" && <span className="muted"> {t("per kg")}</span>}
        </span>
      </div>
      {!p.inStock ? (
        <span className="badge">{t("Sold out")}</span>
      ) : qty > 0 ? (
        <Stepper p={p} qty={qty} onQty={onQty} />
      ) : (
        <button type="button" className="btn outline add" onClick={() => onQty(stepOf(p.uom))}>
          {t("Add")}
        </button>
      )}
    </li>
  );
}

/* ---------- Basket and checkout ---------- */

function Checkout({
  data,
  basket,
  byVariant,
  onBasket,
  onClose,
  onPlaced,
  onStale,
}: {
  data: ShopData;
  basket: Basket;
  byVariant: Map<string, Product>;
  onBasket: (b: Basket) => void;
  onClose: () => void;
  onPlaced: (token: string) => void;
  onStale: () => void;
}) {
  const lang = useLang();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [form, setForm] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("shop-me") ?? "{}") as Partial<{ name: string; phone: string; email: string; consent: boolean }>;
      return { name: "", phone: "", email: "", consent: false, ...saved, note: "" };
    } catch {
      return { name: "", phone: "", email: "", note: "", consent: false };
    }
  });
  const [placing, setPlacing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per attempt, so a retry after a dropped connection can't place the order twice.
  const orderId = useRef(crypto.randomUUID());
  const dialog = useRef<HTMLDivElement>(null);

  const lines = Object.entries(basket).map(([variantId, qty]) => ({ variantId, qty }));
  const key = JSON.stringify(lines);

  useEffect(() => {
    if (!lines.length) return;
    let live = true;
    setQuoteError(null);
    const timer = setTimeout(() => {
      shopApi<Quote>(`${data.shop.slug}/quote`, { storeId: data.storeId, lines })
        .then((q) => live && setQuote(q))
        .catch((e: ApiError) => live && setQuoteError(e.message));
    }, 250);
    orderId.current = crypto.randomUUID();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, data.storeId]);

  useEffect(() => {
    dialog.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    document.body.classList.add("locked");
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.classList.remove("locked");
    };
  }, [onClose]);

  const fresh = quote && JSON.stringify(quote.lines.map((l) => ({ variantId: l.variantId, qty: l.qty }))) === key;
  const belowMin = !!quote && quote.total < quote.minOrder;

  const place = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fresh || belowMin) return;
    if (form.name.trim().length < 2) return setProblem(t("Enter your name"));
    if (form.phone.replace(/\D/g, "").length < 7) return setProblem(t("Enter your mobile number"));
    setPlacing(true);
    setProblem(null);
    try {
      localStorage.setItem("shop-me", JSON.stringify({ name: form.name, phone: form.phone, email: form.email, consent: form.consent }));
    } catch {
      // Not remembered for next time; the order still goes.
    }
    try {
      const r = await shopApi<{ token: string }>(`${data.shop.slug}/orders`, {
        id: orderId.current,
        storeId: data.storeId,
        name: form.name,
        phone: form.phone,
        email: form.email || null,
        note: form.note || null,
        marketingConsent: form.consent,
        lines,
        expectedTotal: quote!.total,
      });
      onPlaced(r.token);
    } catch (err) {
      const e = err as ApiError;
      setProblem(e.message);
      if (e.code === "price_changed" || e.code === "out_of_stock" || e.code === "unavailable") {
        setQuote(null);
        onStale();
      }
      setPlacing(false);
    }
  };

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="basket-title" tabIndex={-1} ref={dialog}>
        <div className="sheet-head">
          <h2 id="basket-title">{t("Your basket")}</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
        {!lines.length ? (
          <p className="empty">{t("Your basket is empty.")}</p>
        ) : (
          <form onSubmit={place} noValidate>
            <ul className="basket">
              {lines.map((l) => {
                const p = byVariant.get(l.variantId)!;
                const ql = fresh ? quote.lines.find((x) => x.variantId === l.variantId) : undefined;
                return (
                  <li key={l.variantId}>
                    <span className="basket-name">{local(p, lang)}</span>
                    <Stepper p={p} qty={l.qty} onQty={(n) => onBasket(setQty(basket, l.variantId, n))} />
                    <span className="tnum basket-total">{ql ? aed(ql.total) : "…"}</span>
                  </li>
                );
              })}
            </ul>
            <div className="total">
              <span>{t("Total, VAT included")}</span>
              <strong className="tnum">{fresh ? aed(quote.total) : t("Checking prices…")}</strong>
            </div>
            {quoteError && <Problem text={quoteError} />}
            {belowMin && <p className="warn">{t("Minimum order {amount}", { amount: aed(quote.minOrder) })}</p>}

            <h3>{t("Your details")}</h3>
            <label className="field">
              <span>{t("Name")}</span>
              <input autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} />
            </label>
            <label className="field">
              <span>{t("Mobile")}</span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                placeholder="05x xxx xxxx"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                required
                maxLength={30}
              />
            </label>
            <label className="field">
              <span>{t("Email (optional)")}</span>
              <input type="email" autoComplete="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={200} />
            </label>
            <label className="field">
              <span>{t("Note for the shop (optional)")}</span>
              <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
              <span>{t("Send me offers by SMS and WhatsApp")}</span>
            </label>
            {problem && <Problem text={problem} />}
            <button type="submit" className="btn primary wide" disabled={placing || !fresh || belowMin}>
              {placing ? t("Placing order…") : t("Place order")}
              {fresh && !placing && <span className="tnum"> · {aed(quote.total)}</span>}
            </button>
            <p className="muted small center-text">{t("You pay at the counter when you collect.")}</p>
          </form>
        )}
      </div>
    </div>
  );
}

/* ---------- The customer's order ---------- */

const STEPS = ["new", "accepted", "ready", "collected"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { new: "Received", accepted: "Being packed", ready: "Ready to collect", collected: "Collected" };

function OrderPage({ slug, token }: { slug: string; token: string }) {
  const lang = useLang();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    shopApi<OrderView>(`${encodeURIComponent(slug)}/orders/${encodeURIComponent(token)}`)
      .then((o) => {
        if (!live) return;
        setOrder(o);
        setError(null);
        document.title = `${o.number} · ${o.shop.name}`;
      })
      .catch((e: ApiError) => live && setError(e));
    const timer = setTimeout(() => setTick((n) => n + 1), 20_000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slug, token, tick]);

  const cancel = async () => {
    setProblem(null);
    try {
      await shopApi(`${encodeURIComponent(slug)}/orders/${encodeURIComponent(token)}/cancel`, {});
    } catch (e) {
      setProblem((e as ApiError).message);
    }
    setAsking(false);
    setTick((n) => n + 1);
  };

  if (error?.status === 404) return <Closed message={error.message} />;
  if (!order)
    return (
      <main className="page">
        <Header title=" " />
        {error ? <Problem text={error.message} onRetry={() => setTick((n) => n + 1)} /> : <div className="skeleton" aria-busy="true" />}
      </main>
    );

  const done = order.status === "collected" || order.status === "cancelled";
  const at = STEPS.indexOf(order.status as (typeof STEPS)[number]);

  return (
    <main className="page">
      <Header title={t("Order {n}", { n: order.number })} sub={order.shop.name} />
      {error && <Problem text={error.message} />}

      {order.status === "cancelled" ? (
        <section className="card cancelled">
          <h2>{t("Cancelled")}</h2>
          {order.cancelReason && <p>{t("Reason: {r}", { r: order.cancelReason })}</p>}
        </section>
      ) : (
        <>
          <ol className="timeline" aria-label={t("Order {n}", { n: order.number })}>
            {STEPS.map((s, i) => (
              <li key={s} className={i < at ? "past" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
                <span className="dot" aria-hidden="true" />
                {t(STEP_LABEL[s])}
              </li>
            ))}
          </ol>
          {!done && (
            <section className={`card code${order.status === "ready" ? " ready" : ""}`}>
              <span className="label">{t("Pickup code")}</span>
              <strong className="tnum" dir="ltr">
                {order.pickupCode}
              </strong>
              <p>{t("Say this code at the counter.")}</p>
              {order.status !== "ready" && <p className="muted small">{t("We'll send you a message when it is ready.")}</p>}
            </section>
          )}
        </>
      )}

      <section className="card">
        <h3>{t("Collect from")}</h3>
        <p>
          <strong>{local(order.store, lang)}</strong>
          {order.store.address && <span className="muted"> · {order.store.address}</span>}
        </p>
        {order.store.phone && (
          <p>
            <a href={`tel:${order.store.phone}`} dir="ltr">
              {order.store.phone}
            </a>
          </p>
        )}
      </section>

      <section className="card">
        <h3>{t("Items")}</h3>
        <ul className="lines">
          {order.lines.map((l, i) => (
            <li key={i}>
              <span className="tnum">{qtyText(l.qty)} ×</span> {l.name}
            </li>
          ))}
        </ul>
        {order.note && <p className="muted" dir="auto">“{order.note}”</p>}
        <div className="total">
          <span>{order.status === "collected" ? t("Total, VAT included") : t("To pay")}</span>
          <strong className="tnum">{aed(order.total)}</strong>
        </div>
      </section>

      {problem && <Problem text={problem} />}
      {order.status === "new" &&
        (asking ? (
          <div className="confirm" role="group" aria-label={t("Cancel this order?")}>
            <p>{t("Cancel this order?")}</p>
            <button type="button" className="btn danger" onClick={() => void cancel()}>
              {t("Yes, cancel")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              {t("Keep it")}
            </button>
          </div>
        ) : (
          <button type="button" className="btn ghost wide" onClick={() => setAsking(true)}>
            {t("Cancel order")}
          </button>
        ))}
      {!done && <p className="muted small center-text">{t("Keep this page to check your order.")}</p>}
      <button type="button" className="btn outline wide" onClick={() => go(`/${slug}`)}>
        {t("Order more")}
      </button>
    </main>
  );
}
