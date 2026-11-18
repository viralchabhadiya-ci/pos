import { useMemo, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, bp, dateTime, money, tryParseMoney } from "../lib/format.js";
import type { Category, Product, Promotion, PromotionKind, Store } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const KINDS: { id: PromotionKind; label: string; hint: string }[] = [
  { id: "percent_off", label: "Percent off items", hint: "e.g. 20% off all drinks" },
  { id: "buy_x_get_y", label: "Buy X, get Y", hint: "e.g. buy 2, get 1 free. The cheapest items are the free ones." },
  { id: "multi_buy", label: "Multi-buy price", hint: "e.g. 3 for AED 10" },
  { id: "order_percent_off", label: "Percent off the bill", hint: "e.g. 10% off when spending AED 200" },
  { id: "order_amount_off", label: "Amount off the bill", hint: "e.g. AED 20 off when spending AED 150" },
];
const ITEM_KINDS: PromotionKind[] = ["percent_off", "buy_x_get_y", "multi_buy"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** What the offer gives, in a few words. */
export function offerText(p: Pick<Promotion, "kind" | "percentBp" | "buyQty" | "getQty" | "bundleQty" | "bundlePrice" | "amount" | "minSubtotal" | "minQty">) {
  const min = p.minSubtotal ? ` over ${aed(p.minSubtotal)}` : "";
  switch (p.kind) {
    case "percent_off":
      return `${bp(p.percentBp ?? 0)} off${p.minQty ? ` when buying ${p.minQty} or more` : ""}`;
    case "buy_x_get_y":
      return `Buy ${p.buyQty}, get ${p.getQty} ${(p.percentBp ?? 10_000) >= 10_000 ? "free" : `at ${bp(p.percentBp ?? 0)} off`}`;
    case "multi_buy":
      return `${p.bundleQty} for ${aed(p.bundlePrice ?? 0)}`;
    case "order_percent_off":
      return `${bp(p.percentBp ?? 0)} off the bill${min}`;
    case "order_amount_off":
      return `${aed(p.amount ?? 0)} off the bill${min}`;
  }
}

function whenText(p: Promotion) {
  const parts: string[] = [];
  const day = (iso: string) => new Intl.DateTimeFormat("en-AE", { day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(new Date(iso));
  if (p.startsAt && p.endsAt) parts.push(`${day(p.startsAt)} to ${day(p.endsAt)}`);
  else if (p.startsAt) parts.push(`From ${day(p.startsAt)}`);
  else if (p.endsAt) parts.push(`Until ${day(p.endsAt)}`);
  if (p.days?.length) parts.push(p.days.map((d) => DAYS[d]).join(", "));
  if (p.startTime && p.endTime) parts.push(`${p.startTime}–${p.endTime}`);
  return parts.length ? parts.join(" · ") : "Always";
}

function status(p: Promotion): { label: string; tone: "good" | "warn" | "" } {
  const now = Date.now();
  if (!p.active) return { label: "Off", tone: "" };
  if (p.maxUses && p.uses >= p.maxUses) return { label: "Used up", tone: "warn" };
  if (p.endsAt && now >= Date.parse(p.endsAt)) return { label: "Ended", tone: "" };
  if (p.startsAt && now < Date.parse(p.startsAt)) return { label: "Scheduled", tone: "warn" };
  return { label: "Running", tone: "good" };
}

export function Promotions() {
  const list = useLoad(() => api<{ promotions: Promotion[] }>("/promotions"), []);
  const [editing, setEditing] = useState<Promotion | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toast = useToast();
  const promos = list.data?.promotions ?? [];

  const toggle = async (p: Promotion) => {
    setBusyId(p.id);
    try {
      await api(`/promotions/${p.id}`, { method: "PATCH", body: { active: !p.active } });
      toast(p.active ? `${p.name} switched off` : `${p.name} switched on`);
      await list.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Promotions</h1>
          <p className="muted">Offers and coupons. Tills apply them by themselves, offline too, within seconds of a change.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" /> New promotion
        </button>
      </header>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <SkeletonRows rows={4} />
      ) : promos.length === 0 ? (
        <EmptyState icon="percent" title="No promotions yet">
          <p className="muted">Try a buy 2 get 1 free on a slow seller, or a happy hour.</p>
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> Create a promotion
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Promotions</caption>
            <thead>
              <tr>
                <th scope="col">Promotion</th>
                <th scope="col" className="hide-sm">When</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Used</th>
                <th scope="col" className="num hide-xs">Given</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => {
                const st = status(p);
                return (
                  <tr key={p.id} className={p.active ? undefined : "dim"}>
                    <td>
                      <span className="cell-main">
                        {p.name}
                        {p.code && (
                          <span className="badge code">
                            <Icon name="ticket" size={14} />
                            {p.code}
                          </span>
                        )}
                      </span>
                      <span className="cell-sub">{offerText(p)}</span>
                    </td>
                    <td className="hide-sm">{whenText(p)}</td>
                    <td>
                      <span className={`badge ${st.tone}`}>{st.label}</span>
                    </td>
                    <td className="num">
                      {p.sales}
                      {p.maxUses ? <span className="muted"> / {p.maxUses}</span> : null}
                    </td>
                    <td className="num hide-xs">{money(p.discount)}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="btn ghost sm hide-xs"
                        disabled={busyId === p.id}
                        onClick={() => void toggle(p)}
                        aria-label={p.active ? `Switch off ${p.name}` : `Switch on ${p.name}`}
                      >
                        {p.active ? "Switch off" : "Switch on"}
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                        <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <PromotionDialog
          promotion={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

/** "2026-12-01T08:00" in the browser's time, for datetime-local inputs. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const pct = (n: number | null | undefined) => (n ? String(n / 100) : "");
const amt = (n: number | null | undefined) => (n === null || n === undefined ? "" : money(n).replace(/,/g, ""));

function PromotionDialog({ promotion, onClose, onSaved }: { promotion: Promotion | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const refs = useLoad(
    () =>
      Promise.all([
        api<{ categories: Category[] }>("/categories"),
        api<{ products: Product[] }>("/products"),
        api<{ stores: Store[] }>("/stores"),
      ]).then(([c, p, s]) => ({ categories: c.categories, products: p.products, stores: s.stores })),
    [],
  );
  const p = promotion;
  const [f, setF] = useState({
    name: p?.name ?? "",
    kind: p?.kind ?? ("percent_off" as PromotionKind),
    all: p?.target.all ?? false,
    categoryIds: p?.target.categoryIds ?? [],
    productIds: p?.target.productIds ?? [],
    percent: pct(p?.percentBp) || (p?.kind === "buy_x_get_y" ? "100" : ""),
    buyQty: p?.buyQty ? String(p.buyQty) : "2",
    getQty: p?.getQty ? String(p.getQty) : "1",
    getPercent: p?.kind === "buy_x_get_y" ? pct(p.percentBp) : "100",
    bundleQty: p?.bundleQty ? String(p.bundleQty) : "3",
    bundlePrice: amt(p?.bundlePrice),
    amount: amt(p?.amount),
    minSubtotal: amt(p?.minSubtotal),
    minQty: p?.minQty ? String(p.minQty) : "",
    code: p?.code ?? "",
    maxUses: p?.maxUses ? String(p.maxUses) : "",
    startsAt: toLocalInput(p?.startsAt ?? null),
    endsAt: toLocalInput(p?.endsAt ?? null),
    days: p?.days ?? [],
    startTime: p?.startTime ?? "",
    endTime: p?.endTime ?? "",
    storeIds: p?.storeIds ?? [],
    priority: String(p?.priority ?? 100),
    active: p?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const clear = (k: string) => setErrors((e) => (e[k] ? { ...e, [k]: "" } : e));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    clear(k === "all" ? "target" : k);
  };
  const toggleIn = (k: "categoryIds" | "productIds" | "storeIds", id: string) => {
    setF((x) => ({ ...x, [k]: x[k].includes(id) ? x[k].filter((v) => v !== id) : [...x[k], id] }));
    clear("target");
  };
  const toggleDay = (d: number) => setF((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((v) => v !== d) : [...x.days, d].sort() }));
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const item = ITEM_KINDS.includes(f.kind);
  const productName = useMemo(() => new Map((refs.data?.products ?? []).map((x) => [x.id, x.name])), [refs.data]);
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return (refs.data?.products ?? [])
      .filter((x) => !f.productIds.includes(x.id) && (x.name.toLowerCase().includes(q) || x.barcode === q || x.sku?.toLowerCase() === q))
      .slice(0, 8);
  }, [search, refs.data, f.productIds]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    const percentBp = (s: string) => {
      const n = num(s);
      return n === null || !Number.isFinite(n) ? null : Math.round(n * 100);
    };
    const parseAmount = (s: string, key: string, required: boolean) => {
      if (!s.trim()) {
        if (required) errs[key] = "Enter an amount";
        return null;
      }
      const v = tryParseMoney(s);
      if (v === null || v < 0) errs[key] = "Enter an amount like 10.00";
      return v;
    };
    if (!f.name.trim()) errs.name = "Give it a name the cashier and customer will see, like Weekend water deal";
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      kind: f.kind,
      target: { all: f.all, categoryIds: f.all ? [] : f.categoryIds, productIds: f.all ? [] : f.productIds },
      code: f.code.trim() || null,
      maxUses: num(f.maxUses),
      startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null,
      endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
      days: f.days.length && f.days.length < 7 ? f.days : null,
      startTime: f.startTime || null,
      endTime: f.endTime || null,
      storeIds: f.storeIds.length ? f.storeIds : null,
      priority: Math.max(0, Math.round(Number(f.priority) || 0)),
      active: f.active,
    };
    if (f.kind === "percent_off" || f.kind === "order_percent_off") {
      const v = percentBp(f.percent);
      if (v === null || v < 1 || v > 10_000) errs.percent = "Enter a percentage from 0.01 to 100";
      body.percentBp = v;
    }
    if (f.kind === "percent_off") body.minQty = num(f.minQty);
    if (f.kind === "buy_x_get_y") {
      body.buyQty = num(f.buyQty);
      body.getQty = num(f.getQty);
      if (!(Number(f.buyQty) >= 1)) errs.buyQty = "At least 1";
      if (!(Number(f.getQty) >= 1)) errs.getQty = "At least 1";
      const v = percentBp(f.getPercent || "100");
      if (v === null || v < 1 || v > 10_000) errs.getPercent = "From 0.01 to 100 (100 is free)";
      body.percentBp = v;
    }
    if (f.kind === "multi_buy") {
      body.bundleQty = num(f.bundleQty);
      if (!(Number(f.bundleQty) >= 2)) errs.bundleQty = "At least 2";
      body.bundlePrice = parseAmount(f.bundlePrice, "bundlePrice", true);
    }
    if (f.kind === "order_amount_off") body.amount = parseAmount(f.amount, "amount", true);
    if (!item) body.minSubtotal = parseAmount(f.minSubtotal, "minSubtotal", false);
    if (item && !f.all && !f.categoryIds.length && !f.productIds.length) errs.target = "Pick the categories or products it applies to, or all products";
    if (f.code.trim() && !/^[A-Za-z0-9_-]{3,30}$/.test(f.code.trim())) errs.code = "3 to 30 letters or numbers (- and _ allowed)";
    if (f.maxUses && !(Number(f.maxUses) >= 1)) errs.maxUses = "At least 1, or leave empty";
    if (f.startsAt && f.endsAt && f.endsAt <= f.startsAt) errs.endsAt = "The end must be after the start";
    if (!!f.startTime !== !!f.endTime) errs.endTime = "Give both times, or neither";
    else if (f.startTime && f.startTime === f.endTime) errs.endTime = "The end must differ from the start";
    setErrors(errs);
    const first = Object.keys(errs).find((k) => errs[k]);
    if (first) {
      document.getElementById(`pf-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (p) await api(`/promotions/${p.id}`, { method: "PUT", body });
      else await api("/promotions", { body });
      toast(p ? `${body.name} saved` : `${body.name} created`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  const stores = refs.data?.stores ?? [];
  return (
    <Modal onClose={onClose} wide label={p ? `Edit ${p.name}` : "New promotion"}>
      <h2>{p ? "Edit promotion" : "New promotion"}</h2>
      {refs.error ? (
        <ErrorState message={refs.error} onRetry={refs.reload} />
      ) : !refs.data ? (
        <SkeletonRows rows={5} />
      ) : (
        <form onSubmit={submit} noValidate>
          <Field id="pf-name" label="Name" required error={errors.name} hint="Shows on the till and the receipt.">
            {(a) => <input {...a} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} autoFocus={!p} />}
          </Field>

          <fieldset className="group">
            <legend>The offer</legend>
            <div className="kind-grid" role="radiogroup" aria-label="Kind of offer">
              {KINDS.map((k) => (
                <label key={k.id} className={f.kind === k.id ? "kind on" : "kind"}>
                  <input type="radio" name="kind" value={k.id} checked={f.kind === k.id} onChange={() => set("kind", k.id)} />
                  <span>
                    <strong>{k.label}</strong>
                    <span className="hint">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="form-grid">
              {(f.kind === "percent_off" || f.kind === "order_percent_off") && (
                <Field id="pf-percent" label="Percent off" required error={errors.percent}>
                  {(a) => <input {...a} inputMode="decimal" value={f.percent} onChange={(e) => set("percent", e.target.value)} placeholder="10" />}
                </Field>
              )}
              {f.kind === "percent_off" && (
                <Field id="pf-minQty" label="Minimum quantity" hint="Optional. Items that match, in one sale.">
                  {(a) => <input {...a} type="number" min={1} inputMode="numeric" value={f.minQty} onChange={(e) => set("minQty", e.target.value)} />}
                </Field>
              )}
              {f.kind === "buy_x_get_y" && (
                <>
                  <Field id="pf-buyQty" label="Customer buys" required error={errors.buyQty}>
                    {(a) => <input {...a} type="number" min={1} inputMode="numeric" value={f.buyQty} onChange={(e) => set("buyQty", e.target.value)} />}
                  </Field>
                  <Field id="pf-getQty" label="And gets" required error={errors.getQty}>
                    {(a) => <input {...a} type="number" min={1} inputMode="numeric" value={f.getQty} onChange={(e) => set("getQty", e.target.value)} />}
                  </Field>
                  <Field id="pf-getPercent" label="Percent off those (100 = free)" error={errors.getPercent}>
                    {(a) => <input {...a} inputMode="decimal" value={f.getPercent} onChange={(e) => set("getPercent", e.target.value)} />}
                  </Field>
                </>
              )}
              {f.kind === "multi_buy" && (
                <>
                  <Field id="pf-bundleQty" label="Number of items" required error={errors.bundleQty}>
                    {(a) => <input {...a} type="number" min={2} inputMode="numeric" value={f.bundleQty} onChange={(e) => set("bundleQty", e.target.value)} />}
                  </Field>
                  <Field id="pf-bundlePrice" label="For (AED)" required error={errors.bundlePrice} hint="VAT included, like shelf prices.">
                    {(a) => <input {...a} inputMode="decimal" value={f.bundlePrice} onChange={(e) => set("bundlePrice", e.target.value)} placeholder="10.00" />}
                  </Field>
                </>
              )}
              {f.kind === "order_amount_off" && (
                <Field id="pf-amount" label="Amount off (AED)" required error={errors.amount}>
                  {(a) => <input {...a} inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="20.00" />}
                </Field>
              )}
              {!item && (
                <Field id="pf-minSubtotal" label="Minimum spend (AED)" error={errors.minSubtotal} hint="Optional. After item offers.">
                  {(a) => <input {...a} inputMode="decimal" value={f.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value)} placeholder="100.00" />}
                </Field>
              )}
            </div>
          </fieldset>

          {item && (
            <fieldset className="group">
              <legend>Applies to</legend>
              <label className="check">
                <input type="checkbox" checked={f.all} onChange={(e) => set("all", e.target.checked)} />
                <span>All products</span>
              </label>
              {!f.all && (
                <>
                  <p className="field-label" id="pf-cats">Categories</p>
                  <div className="chips" role="group" aria-labelledby="pf-cats">
                    {refs.data.categories.map((c) => (
                      <button key={c.id} type="button" className="chip" aria-pressed={f.categoryIds.includes(c.id)} onClick={() => toggleIn("categoryIds", c.id)}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                  <Field id="pf-target" label="Products" error={errors.target} hint="Search by name, barcode or SKU.">
                    {(a) => <input {...a} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" autoComplete="off" />}
                  </Field>
                  {matches.length > 0 && (
                    <ul className="pick-results">
                      {matches.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => {
                              toggleIn("productIds", m.id);
                              setSearch("");
                            }}
                          >
                            <Icon name="plus" size={16} /> {m.name} <span className="muted">{aed(m.price)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {f.productIds.length > 0 && (
                    <ul className="picked">
                      {f.productIds.map((id) => (
                        <li key={id}>
                          {productName.get(id) ?? "Product"}
                          <button type="button" className="icon-btn" onClick={() => toggleIn("productIds", id)} aria-label={`Remove ${productName.get(id) ?? "product"}`}>
                            <Icon name="close" size={16} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </fieldset>
          )}

          <fieldset className="group">
            <legend>Coupon</legend>
            <div className="form-grid">
              <Field id="pf-code" label="Coupon code" error={errors.code} hint="Leave empty to apply by itself. With a code, the cashier enters it.">
                {(a) => (
                  <input {...a} value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} maxLength={30} autoCapitalize="characters" autoComplete="off" />
                )}
              </Field>
              <Field id="pf-maxUses" label="Use limit" error={errors.maxUses} hint="Optional. Sales it can be used on, in all.">
                {(a) => <input {...a} type="number" min={1} inputMode="numeric" value={f.maxUses} onChange={(e) => set("maxUses", e.target.value)} />}
              </Field>
            </div>
          </fieldset>

          <fieldset className="group">
            <legend>When</legend>
            <div className="form-grid">
              <Field id="pf-startsAt" label="Starts" hint="Optional.">
                {(a) => <input {...a} type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} />}
              </Field>
              <Field id="pf-endsAt" label="Ends" error={errors.endsAt} hint="Optional.">
                {(a) => <input {...a} type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />}
              </Field>
            </div>
            <p className="field-label" id="pf-days">Days</p>
            <div className="chips" role="group" aria-labelledby="pf-days">
              {DAYS.map((d, i) => (
                <button key={d} type="button" className="chip" aria-pressed={f.days.includes(i)} onClick={() => toggleDay(i)}>
                  {d}
                </button>
              ))}
            </div>
            <p className="hint">None picked: every day.</p>
            <div className="form-grid">
              <Field id="pf-startTime" label="From (time)" hint="Optional, for a happy hour. Store time.">
                {(a) => <input {...a} type="time" value={f.startTime} onChange={(e) => set("startTime", e.target.value)} />}
              </Field>
              <Field id="pf-endTime" label="To (time)" error={errors.endTime} hint="Before the start time runs past midnight.">
                {(a) => <input {...a} type="time" value={f.endTime} onChange={(e) => set("endTime", e.target.value)} />}
              </Field>
            </div>
            {stores.length > 1 && (
              <>
                <p className="field-label" id="pf-stores">Stores</p>
                <div className="chips" role="group" aria-labelledby="pf-stores">
                  {stores.map((s) => (
                    <button key={s.id} type="button" className="chip" aria-pressed={f.storeIds.includes(s.id)} onClick={() => toggleIn("storeIds", s.id)}>
                      {s.name}
                    </button>
                  ))}
                </div>
                <p className="hint">None picked: all stores.</p>
              </>
            )}
          </fieldset>

          <div className="form-grid">
            <Field id="pf-priority" label="Priority" hint="When two item offers fit the same item, the lower number wins.">
              {(a) => <input {...a} type="number" min={0} inputMode="numeric" value={f.priority} onChange={(e) => set("priority", e.target.value)} />}
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
            <span>
              On
              <span className="hint">Switch off to pause it without losing the settings.</span>
            </span>
          </label>
          {p && p.sales > 0 && (
            <p className="muted small">
              Used on {p.sales} sale{p.sales === 1 ? "" : "s"}, {aed(p.discount)} given{p.lastUsed ? `, last on ${dateTime(p.lastUsed)}` : ""}.
            </p>
          )}
          {formError && (
            <p className="form-error" role="alert">
              <Icon name="alert" /> {formError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Saving…" : p ? "Save changes" : "Create promotion"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
