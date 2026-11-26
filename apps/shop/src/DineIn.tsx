import { useEffect, useMemo, useRef, useState } from "react";
import { Header, Problem, local } from "./App.js";
import { ApiError, shopApi } from "./lib/api.js";
import { aed } from "./lib/format.js";
import { itemsText, t, useLang } from "./lib/i18n.js";

interface Option {
  id: string;
  name: string;
  nameAr: string | null;
  price: number;
}
interface Group {
  id: string;
  name: string;
  nameAr: string | null;
  minChoices: number;
  maxChoices: number;
  options: Option[];
}
interface Item {
  variantId: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  categoryId: string | null;
  price: number;
  modifierGroupIds: string[];
}
export interface Menu {
  kind: "table" | "kiosk";
  business: string;
  store: { name: string; nameAr: string | null };
  table: { name: string } | null;
  open: boolean;
  categories: { id: string; name: string; nameAr: string | null }[];
  products: Item[];
  modifierGroups: Group[];
}
/** One line of the guest's order: an item made one way. */
export interface PickLine {
  key: string;
  variantId: string;
  optionIds: string[];
  qty: number;
}
interface Placed {
  id: string;
  token: string;
  number: string;
  short: number;
}
interface Status {
  short: number;
  status: "new" | "accepted" | "ready" | "collected" | "cancelled";
  lines: { name: string; qty: number; modifiers: string[] }[];
  total: number;
  cancelReason: string | null;
}

/** Same item made the same way is one line, whatever order the choices were tapped in. */
export const lineKey = (variantId: string, optionIds: string[]) => [variantId, ...[...optionIds].sort()].join("+");

export function addPick(lines: PickLine[], variantId: string, optionIds: string[], qty = 1): PickLine[] {
  const key = lineKey(variantId, optionIds);
  const found = lines.find((l) => l.key === key);
  if (found) return lines.map((l) => (l.key === key ? { ...l, qty: Math.min(50, l.qty + qty) } : l));
  return [...lines, { key, variantId, optionIds: [...optionIds].sort(), qty }];
}
export const setPickQty = (lines: PickLine[], key: string, qty: number) =>
  qty <= 0 ? lines.filter((l) => l.key !== key) : lines.map((l) => (l.key === key ? { ...l, qty: Math.min(50, qty) } : l));

const storeKey = (token: string) => `dine-in:${token}`;
function loadPicks(token: string): PickLine[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storeKey(token)) ?? "[]") as PickLine[];
    return Array.isArray(raw) ? raw.filter((l) => l && typeof l.qty === "number" && l.qty > 0) : [];
  } catch {
    return [];
  }
}
function savePicks(token: string, lines: PickLine[]) {
  try {
    sessionStorage.setItem(storeKey(token), JSON.stringify(lines));
  } catch {
    // Kept for this page only.
  }
}

/** A kiosk starts again for the next guest after this long without a touch. */
const KIOSK_IDLE_MS = 90_000;
/** How long a kiosk shows the order number before starting again. */
const KIOSK_DONE_MS = 25_000;

/**
 * Ordering by the guest: from the QR code on the table (the staff add it to the table's bill)
 * or at a self-order kiosk (pay at the counter with the number it shows).
 */
export function DineIn({ kind, token }: { kind: "table" | "kiosk"; token: string }) {
  const lang = useLang();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [lines, setLines] = useState<PickLine[]>(() => (kind === "table" ? loadPicks(token) : []));
  const [category, setCategory] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<Item | null>(null);
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);

  const load = () => {
    setError(null);
    shopApi<Menu>(`${kind}/${encodeURIComponent(token)}`)
      .then((m) => {
        setMenu(m);
        document.title = m.table ? `${m.business} · ${t("Table {name}", { name: m.table.name })}` : m.business;
      })
      .catch((e: ApiError) => setError(e));
  };
  useEffect(load, [kind, token]);

  const change = (next: PickLine[]) => {
    setLines(next);
    if (kind === "table") savePicks(token, next);
  };
  const reset = () => {
    change([]);
    setPlaced(null);
    setOpen(false);
    setChoosing(null);
    setCategory(null);
    window.scrollTo(0, 0);
  };

  // A kiosk left with a half-made order starts again for the next guest.
  useEffect(() => {
    if (kind !== "kiosk" || (!lines.length && !open)) return;
    let timer = setTimeout(reset, KIOSK_IDLE_MS);
    const touched = () => {
      clearTimeout(timer);
      timer = setTimeout(reset, KIOSK_IDLE_MS);
    };
    window.addEventListener("pointerdown", touched);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", touched);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, lines.length, open]);

  const byId = useMemo(() => new Map((menu?.products ?? []).map((p) => [p.variantId, p])), [menu]);
  const groups = useMemo(() => new Map((menu?.modifierGroups ?? []).map((g) => [g.id, g])), [menu]);
  const valid = lines.filter((l) => byId.has(l.variantId));
  const estimate = valid.reduce((s, l) => s + l.qty * (byId.get(l.variantId)!.price + optionsTotal(l.optionIds, menu?.modifierGroups ?? [])), 0);

  if (error?.status === 404)
    return (
      <main className="page center">
        <Header title={t(kind === "table" ? "This QR code is not in use" : "This kiosk is not set up")} />
        <p className="muted">{error.message}</p>
      </main>
    );
  if (!menu)
    return (
      <main className="page">
        <Header title=" " />
        {error ? <Problem text={error.message} onRetry={load} /> : <div className="skeleton" aria-busy="true" />}
      </main>
    );

  if (placed)
    return kind === "kiosk" ? (
      <KioskDone placed={placed} onNext={reset} />
    ) : (
      <TableStatus placed={placed} menu={menu} onMore={() => setPlaced(null)} />
    );

  const shown = menu.products.filter((p) => !category || p.categoryId === category);
  const canOrder = menu.open && menu.products.length > 0;
  const add = (p: Item) => (p.modifierGroupIds.length ? setChoosing(p) : change(addPick(lines, p.variantId, [])));

  return (
    <main className={`page has-bar${kind === "kiosk" ? " kiosk" : ""}`}>
      <Header
        title={menu.business}
        sub={menu.table ? t("Table {name}", { name: menu.table.name }) : kind === "kiosk" ? t("Order here, pay at the counter") : local(menu.store, lang)}
      />
      {kind === "table" && !menu.open && <p className="notice">{t("Ordering from the table is off right now. Here is the menu; the staff will take your order.")}</p>}
      {menu.products.length === 0 ? (
        <p className="empty">{t("The menu is not ready yet. Ask the staff.")}</p>
      ) : (
        <>
          {menu.categories.length > 1 && (
            <div className="filters">
              <div className="chips" role="group" aria-label={t("Menu")}>
                <button type="button" className="chip" aria-pressed={!category} onClick={() => setCategory(null)}>
                  {t("All")}
                </button>
                {menu.categories.map((c) => (
                  <button key={c.id} type="button" className="chip" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                    {local(c, lang)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <ul className="products">
            {shown.map((p) => {
              const inOrder = valid.filter((l) => l.variantId === p.variantId).reduce((s, l) => s + l.qty, 0);
              return (
                <li key={p.variantId} className="product">
                  <div className="product-text">
                    <strong>{local(p, lang)}</strong>
                    {p.description && (
                      <span className="desc" dir="auto">
                        {p.description}
                      </span>
                    )}
                    <span className="price tnum">{aed(p.price)}</span>
                  </div>
                  {canOrder && (
                    <button type="button" className="btn outline add" onClick={() => add(p)}>
                      {inOrder ? t("Add another ({n})", { n: inOrder }) : t("Add")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {valid.length > 0 && !open && (
        <div className="bar">
          <button type="button" className="btn primary bar-btn" onClick={() => setOpen(true)}>
            <span>{t("View order")}</span>
            <span className="muted-on-accent">{itemsText(valid.reduce((s, l) => s + l.qty, 0))}</span>
            <span className="tnum">{aed(estimate)}</span>
          </button>
        </div>
      )}

      {choosing && (
        <ChoiceSheet
          item={choosing}
          groups={choosing.modifierGroupIds.map((id) => groups.get(id)).filter((g): g is Group => !!g)}
          onClose={() => setChoosing(null)}
          onAdd={(optionIds) => {
            change(addPick(lines, choosing.variantId, optionIds));
            setChoosing(null);
          }}
        />
      )}
      {open && (
        <OrderSheet
          kind={kind}
          token={token}
          menu={menu}
          lines={valid}
          onLines={change}
          onClose={() => setOpen(false)}
          onPlaced={(p) => {
            change([]);
            setOpen(false);
            setPlaced(p);
            window.scrollTo(0, 0);
          }}
          onStale={load}
        />
      )}
    </main>
  );
}

const optionsTotal = (optionIds: string[], groups: Group[]) =>
  groups.flatMap((g) => g.options).reduce((s, o) => s + (optionIds.includes(o.id) ? o.price : 0), 0);

function rule(g: Group): string {
  if (g.maxChoices === 1) return g.minChoices ? t("Pick 1") : t("Optional, pick 1");
  if (g.maxChoices === 0) return g.minChoices ? t("Pick at least {n}", { n: g.minChoices }) : t("Optional, pick any");
  return g.minChoices ? t("Pick {min} to {max}", { min: g.minChoices, max: g.maxChoices }) : t("Optional, up to {n}", { n: g.maxChoices });
}

/** A bottom sheet that traps Escape and locks the page behind it. */
function useSheet(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    document.body.classList.add("locked");
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.classList.remove("locked");
    };
  }, [onClose]);
  return ref;
}

function ChoiceSheet({ item, groups, onAdd, onClose }: { item: Item; groups: Group[]; onAdd: (optionIds: string[]) => void; onClose: () => void }) {
  const lang = useLang();
  const ref = useSheet(onClose);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [tried, setTried] = useState(false);
  const toggle = (g: Group, id: string) =>
    setPicked((p) => {
      const now = p[g.id] ?? [];
      if (now.includes(id)) return { ...p, [g.id]: now.filter((x) => x !== id) };
      if (g.maxChoices === 1) return { ...p, [g.id]: [id] };
      if (g.maxChoices && now.length >= g.maxChoices) return p;
      return { ...p, [g.id]: [...now, id] };
    });
  const missing = groups.filter((g) => (picked[g.id]?.length ?? 0) < g.minChoices);
  const ids = Object.values(picked).flat();
  const price = item.price + optionsTotal(ids, groups);

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="choice-title" tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2 id="choice-title">{local(item, lang)}</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
        {groups.map((g) => {
          const short = tried && missing.includes(g);
          return (
            <fieldset key={g.id} className={short ? "choices short" : "choices"}>
              <legend>
                <strong>{local(g, lang)}</strong> <span className={short ? "warn-text" : "muted small"}>{rule(g)}</span>
              </legend>
              {g.options.map((o) => {
                const on = !!picked[g.id]?.includes(o.id);
                return (
                  <button key={o.id} type="button" className={on ? "choice on" : "choice"} aria-pressed={on} onClick={() => toggle(g, o.id)}>
                    <span className="choice-mark" aria-hidden="true">
                      {on ? "✓" : ""}
                    </span>
                    <span className="choice-name">{local(o, lang)}</span>
                    {o.price > 0 && <span className="tnum muted">+{aed(o.price)}</span>}
                  </button>
                );
              })}
            </fieldset>
          );
        })}
        {tried && missing.length > 0 && <Problem text={t("Choose {name} first.", { name: missing.map((g) => local(g, lang)).join(", ") })} />}
        <button
          type="button"
          className="btn primary wide"
          onClick={() => {
            setTried(true);
            if (!missing.length) onAdd(ids);
          }}
        >
          {t("Add")} · <span className="tnum">{aed(price)}</span>
        </button>
      </div>
    </div>
  );
}

interface Quote {
  lines: { variantId: string; qty: number; total: number }[];
  total: number;
}

function OrderSheet({
  kind,
  token,
  menu,
  lines,
  onLines,
  onClose,
  onPlaced,
  onStale,
}: {
  kind: "table" | "kiosk";
  token: string;
  menu: Menu;
  lines: PickLine[];
  onLines: (l: PickLine[]) => void;
  onClose: () => void;
  onPlaced: (p: Placed) => void;
  onStale: () => void;
}) {
  const lang = useLang();
  const ref = useSheet(onClose);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [placing, setPlacing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per attempt, so a retry after a dropped connection can't send the order twice.
  const orderId = useRef(crypto.randomUUID());
  const body = lines.map((l) => ({ variantId: l.variantId, qty: l.qty, optionIds: l.optionIds }));
  const key = JSON.stringify(body);
  const byId = new Map(menu.products.map((p) => [p.variantId, p]));
  const options = new Map(menu.modifierGroups.flatMap((g) => g.options.map((o) => [o.id, o] as const)));

  useEffect(() => {
    if (!lines.length) return;
    let live = true;
    setQuoteError(null);
    const timer = setTimeout(() => {
      shopApi<Quote>(`${kind}/${encodeURIComponent(token)}/quote`, { lines: body })
        .then((q) => live && setQuote({ ...q, lines: q.lines }))
        .catch((e: ApiError) => live && setQuoteError(e.message));
    }, 250);
    orderId.current = crypto.randomUUID();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = !!quote && quote.lines.length === lines.length && quote.lines.every((q, i) => q.variantId === lines[i]!.variantId && q.qty === lines[i]!.qty);

  const send = async () => {
    if (!fresh) return;
    setPlacing(true);
    setProblem(null);
    try {
      const p = await shopApi<Placed>(`${kind}/${encodeURIComponent(token)}/orders`, {
        id: orderId.current,
        name: name.trim() || null,
        note: note.trim() || null,
        lines: body,
        expectedTotal: quote!.total,
      });
      onPlaced(p);
    } catch (err) {
      const e = err as ApiError;
      setProblem(e.message);
      if (e.code === "price_changed" || e.code === "unavailable") {
        setQuote(null);
        onStale();
      }
      setPlacing(false);
    }
  };

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="order-title" tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2 id="order-title">{t("Your order")}</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
        {!lines.length ? (
          <p className="empty">{t("Nothing picked yet.")}</p>
        ) : (
          <>
            <ul className="basket">
              {lines.map((l, i) => {
                const p = byId.get(l.variantId)!;
                // In the menu's order (Size before Extras), not the order they were tapped.
                const mods = [...options.values()].filter((o) => l.optionIds.includes(o.id));
                return (
                  <li key={l.key}>
                    <span className="basket-name">
                      {local(p, lang)}
                      {mods.length > 0 && <small className="muted">{mods.map((o) => local(o, lang)).join(" · ")}</small>}
                    </span>
                    <div className="stepper" role="group" aria-label={local(p, lang)}>
                      <button type="button" aria-label={t("Less")} onClick={() => onLines(setPickQty(lines, l.key, l.qty - 1))}>
                        −
                      </button>
                      <span className="tnum" aria-live="polite">
                        {l.qty}
                      </span>
                      <button type="button" aria-label={t("More")} onClick={() => onLines(setPickQty(lines, l.key, l.qty + 1))}>
                        +
                      </button>
                    </div>
                    <span className="tnum basket-total">{fresh ? aed(quote.lines[i]!.total) : "…"}</span>
                  </li>
                );
              })}
            </ul>
            <div className="total">
              <span>{t("Total, VAT included")}</span>
              <strong className="tnum">{fresh ? aed(quote.total) : t("Checking prices…")}</strong>
            </div>
            {quoteError && <Problem text={quoteError} />}
            <label className="field">
              <span>{kind === "kiosk" ? t("Your name (optional, to call you)") : t("Your name (optional)")}</span>
              <input autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </label>
            <label className="field">
              <span>{t("Note for the kitchen (optional)")}</span>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
            </label>
            {problem && <Problem text={problem} />}
            <button type="button" className="btn primary wide" disabled={placing || !fresh} onClick={() => void send()}>
              {placing ? t("Sending…") : kind === "kiosk" ? t("Order and pay at the counter") : t("Send order")}
              {fresh && !placing && <span className="tnum"> · {aed(quote.total)}</span>}
            </button>
            <p className="muted small center-text">
              {kind === "kiosk" ? t("Take your number to the counter to pay.") : t("The staff check your order and add it to your table's bill. You pay at the end.")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function KioskDone({ placed, onNext }: { placed: Placed; onNext: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onNext, KIOSK_DONE_MS);
    return () => clearTimeout(timer);
  }, [onNext]);
  return (
    <main className="page center kiosk-done">
      <p className="muted">{t("Your number")}</p>
      <p className="big-number tnum" aria-live="polite">
        {placed.short}
      </p>
      <p className="lead">{t("Please pay at the counter. We'll call your number.")}</p>
      <button type="button" className="btn primary wide" onClick={onNext}>
        {t("New order")}
      </button>
    </main>
  );
}

/** After a table order: waiting for the staff, then on the bill (or not taken). */
function TableStatus({ placed, menu, onMore }: { placed: Placed; menu: Menu; onMore: () => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    shopApi<Status>(`dine-in/orders/${encodeURIComponent(placed.token)}`)
      .then((x) => live && setS(x))
      .catch(() => {});
    const timer = setTimeout(() => setTick((n) => n + 1), 6000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [placed.token, tick]);
  const status = s?.status ?? "new";
  return (
    <main className="page">
      <Header title={menu.business} sub={menu.table ? t("Table {name}", { name: menu.table.name }) : undefined} />
      <section className="card" aria-live="polite">
        {status === "cancelled" ? (
          <>
            <h2>{t("The staff could not take this order")}</h2>
            {s?.cancelReason && <p dir="auto">{s.cancelReason}</p>}
            <p className="muted">{t("Ask the staff, or order again.")}</p>
          </>
        ) : status === "new" ? (
          <>
            <h2>{t("Order sent")}</h2>
            <p className="muted">{t("The staff will check it and send it to the kitchen.")}</p>
          </>
        ) : (
          <>
            <h2>{t("On its way to the kitchen")}</h2>
            <p className="muted">{t("It is on your table's bill. You pay at the end.")}</p>
          </>
        )}
        {s && (
          <ul className="lines">
            {s.lines.map((l, i) => (
              <li key={i}>
                {l.qty} × {l.name}
                {l.modifiers.length > 0 && <small className="muted"> · {l.modifiers.join(", ")}</small>}
              </li>
            ))}
          </ul>
        )}
        {s && (
          <p className="total">
            <span>{t("Total, VAT included")}</span>
            <strong className="tnum">{aed(s.total)}</strong>
          </p>
        )}
      </section>
      <button type="button" className="btn primary wide" onClick={onMore}>
        {t("Order more")}
      </button>
    </main>
  );
}
