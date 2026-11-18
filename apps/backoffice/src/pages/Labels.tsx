import { makeScaleBarcode, scaleRuleProblem, type ScaleBarcodeRule } from "@pos/core";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { barsFor, type Bars } from "../lib/barcode.js";
import { money } from "../lib/format.js";
import type { Category, Me, Product } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

/** Label stock the page prints on: a sheet of 24 on A4, or one label at a time on a label printer. */
const TEMPLATES = {
  a4: { name: "A4 sheet, 24 shelf labels (63.5 × 33.9 mm)", page: "A4", margin: "15.1mm 7.2mm 0" },
  roll: { name: "Label printer, 50 × 30 mm", page: "50mm 30mm", margin: "0" },
} as const;
type Template = keyof typeof TEMPLATES;

interface Picked {
  product: Product;
  copies: number;
}

/** #/labels: how the shop's scales print barcodes, and printing shelf and barcode labels. */
export function Labels({ me }: { me: Me }) {
  return (
    <div className="page">
      <header className="page-head noprint">
        <div>
          <h1>Scales &amp; labels</h1>
          <p className="muted">Set how your scales print barcodes so the tills read them, and print shelf and barcode labels for products.</p>
        </div>
      </header>
      <ScaleRules canEdit={me.user.role === "owner" || me.user.role === "manager"} />
      <LabelPrinting />
    </div>
  );
}

const KIND_LABEL: Record<ScaleBarcodeRule["kind"], string> = { weight: "Weight (g)", price: "Price (fils)" };

function example(rule: ScaleBarcodeRule): string | null {
  if (scaleRuleProblem(rule)) return null;
  const code = makeScaleBarcode(rule, "42", rule.kind === "weight" ? 1250 : 1999);
  const p = rule.prefix.length;
  const parts = [code.slice(0, p), code.slice(p, p + rule.pluLength), code.slice(p + rule.pluLength, 12), code.slice(12)];
  return `${parts.join(" ")} = item 42, ${rule.kind === "weight" ? "1.250 kg" : "AED 19.99"}`;
}

function ScaleRules({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const loaded = useLoad(() => api<{ rules: ScaleBarcodeRule[]; productsWithCode: number }>("/scales"), []);
  const [rules, setRules] = useState<ScaleBarcodeRule[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (loaded.data) setRules(loaded.data.rules);
  }, [loaded.data]);

  if (loaded.error) return <ErrorState message={loaded.error} onRetry={loaded.reload} />;
  if (!rules || !loaded.data) return <SkeletonRows rows={2} />;

  const problems = rules.map(scaleRuleProblem);
  const change = (i: number, patch: Partial<ScaleBarcodeRule>) => setRules(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.some(Boolean)) return;
    setBusy(true);
    try {
      await api("/scales", { method: "PUT", body: { rules } });
      toast("Scale barcodes saved. Tills pick them up within a minute.");
      loaded.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel noprint" onSubmit={save} noValidate aria-labelledby="scale-head">
      <h2 id="scale-head">Scale barcodes</h2>
      <p className="muted">
        A scale prints a barcode starting with 2, then the product&apos;s item code, then the weight or the price. Give each product its scale
        item code on the Products page ({loaded.data.productsWithCode} {loaded.data.productsWithCode === 1 ? "has one" : "have one"} now).
      </p>
      <fieldset disabled={!canEdit || busy} className="plain-fieldset">
        <div className="table-wrap">
          <table className="table scale-rules">
            <caption className="sr-only">Barcode rules</caption>
            <thead>
              <tr>
                <th scope="col">Starts with</th>
                <th scope="col">Then</th>
                <th scope="col">Item code digits</th>
                <th scope="col" className="hide-sm">
                  Example
                </th>
                <th scope="col" className="actions">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={i}>
                  <td data-label="Starts with">
                    <input
                      aria-label={`Rule ${i + 1} prefix`}
                      className="narrow"
                      inputMode="numeric"
                      value={r.prefix}
                      maxLength={3}
                      onChange={(e) => change(i, { prefix: e.target.value.replace(/\D/g, "") })}
                    />
                  </td>
                  <td data-label="Then">
                    <select aria-label={`Rule ${i + 1} value`} value={r.kind} onChange={(e) => change(i, { kind: e.target.value as ScaleBarcodeRule["kind"] })}>
                      {(["weight", "price"] as const).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Code digits">
                    <select aria-label={`Rule ${i + 1} item code digits`} value={r.pluLength} onChange={(e) => change(i, { pluLength: Number(e.target.value) })}>
                      {[4, 5, 6].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="hide-sm">
                    {problems[i] ? <span className="field-error">{problems[i]}</span> : <code className="tnum">{example(r)}</code>}
                  </td>
                  <td className="actions">
                    <button type="button" className="btn ghost sm" onClick={() => setRules(rules.filter((_, k) => k !== i))} aria-label={`Remove rule ${i + 1}`}>
                      <Icon name="trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problems.map((p, i) => p && <p key={i} className="field-error show-sm">{`Rule ${i + 1}: ${p}`}</p>)}
        <div className="dialog-actions">
          {rules.length < 6 && (
            <button type="button" className="btn" onClick={() => setRules([...rules, { prefix: "2", kind: "weight", pluLength: 5 }])}>
              <Icon name="plus" /> Add a rule
            </button>
          )}
          <button type="submit" className="btn primary" disabled={problems.some(Boolean)}>
            Save scale barcodes
          </button>
        </div>
      </fieldset>
      {!canEdit && <p className="muted">Only a manager or the owner can change these.</p>}
    </form>
  );
}

/** A product's barcode for its label: its own code, else its SKU; a scale item has its code instead. */
function labelBars(p: Product): Bars | null {
  for (const code of [p.barcode, p.sku]) {
    if (!code) continue;
    try {
      return barsFor(code);
    } catch {
      // A code that cannot be drawn (e.g. Arabic letters in a SKU): try the next.
    }
  }
  return null;
}

function BarcodeSvg({ bars }: { bars: Bars }) {
  const quiet = bars.kind === "ean13" ? 9 : 10;
  const width = bars.modules.length + quiet * 2;
  const rects: { x: number; w: number }[] = [];
  bars.modules.forEach((on, i) => {
    if (!on) return;
    const last = rects.at(-1);
    if (last && last.x + last.w === i + quiet) last.w += 1;
    else rects.push({ x: i + quiet, w: 1 });
  });
  return (
    <svg className="bars" viewBox={`0 0 ${width} 40`} preserveAspectRatio="none" role="img" aria-label={`Barcode ${bars.text}`}>
      <rect width={width} height={40} fill="#fff" />
      {rects.map((r) => (
        <rect key={r.x} x={r.x} y={0} width={r.w} height={40} fill="#000" />
      ))}
    </svg>
  );
}

function Label({ product }: { product: Product }) {
  const bars = labelBars(product);
  const perKg = product.uom === "kg";
  return (
    <div className="label">
      <div className="label-name">{product.name}</div>
      {product.nameAr && (
        <div className="label-name-ar" dir="rtl" lang="ar">
          {product.nameAr}
        </div>
      )}
      <div className="label-price">
        <span className="label-cur">AED</span> {money(product.price)}
        {perKg && <span className="label-unit"> / kg</span>}
      </div>
      {perKg && product.plu ? (
        <div className="label-plu">Scale code {product.plu}</div>
      ) : bars ? (
        <div className="label-code">
          <BarcodeSvg bars={bars} />
          <span className="tnum">{bars.text}</span>
        </div>
      ) : null}
    </div>
  );
}

function LabelPrinting() {
  const categories = useLoad(() => api<{ categories: Category[] }>("/categories"), []);
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [found, setFound] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [template, setTemplate] = useState<Template>("a4");

  useEffect(() => {
    if (!q.trim() && !categoryId) {
      setFound(null);
      return;
    }
    const t = setTimeout(() => {
      const p = new URLSearchParams({ status: "active" });
      if (q.trim()) p.set("q", q.trim());
      if (categoryId) p.set("categoryId", categoryId);
      api<{ products: Product[] }>(`/products?${p}`)
        .then((r) => {
          setFound(r.products);
          setError(null);
        })
        .catch((err) => setError(errorText(err)));
    }, 200);
    return () => clearTimeout(t);
  }, [q, categoryId]);

  const add = (products: Product[]) =>
    setPicked((cur) => [...cur, ...products.filter((p) => !cur.some((c) => c.product.id === p.id)).map((product) => ({ product, copies: 1 }))]);
  const labels = useMemo(() => picked.flatMap((p) => Array.from({ length: p.copies }, () => p.product)), [picked]);
  const tpl = TEMPLATES[template];

  return (
    <section className="panel" aria-labelledby="labels-head">
      <h2 id="labels-head" className="noprint">
        Print labels
      </h2>
      <div className="noprint">
        <div className="form-grid">
          <Field label="Find products">
            {(p) => <input {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, barcode or SKU" />}
          </Field>
          <Field label="Or a whole category">
            {(p) => (
              <select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose a category</option>
                {(categories.data?.categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {error && <p className="field-error">{error}</p>}
        {found && (
          <div className="label-found">
            {found.length === 0 ? (
              <p className="muted">No products found.</p>
            ) : (
              <>
                <ul className="plain-list">
                  {found.slice(0, 20).map((p) => (
                    <li key={p.id}>
                      <span>
                        {p.name} <span className="muted tnum">AED {money(p.price)}</span>
                      </span>
                      <button type="button" className="btn sm" onClick={() => add([p])} disabled={picked.some((x) => x.product.id === p.id)}>
                        <Icon name="plus" /> Add
                      </button>
                    </li>
                  ))}
                </ul>
                {found.length > 1 && (
                  <button type="button" className="btn ghost sm" onClick={() => add(found)}>
                    Add all {found.length}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {picked.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Labels to print</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="num hide-sm">
                      Price (AED)
                    </th>
                    <th scope="col">Copies</th>
                    <th scope="col" className="actions">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {picked.map((x) => (
                    <tr key={x.product.id}>
                      <td>
                        <span className="cell-main">{x.product.name}</span>
                        {!labelBars(x.product) && !(x.product.uom === "kg" && x.product.plu) && <span className="cell-sub">No barcode or SKU: name and price only</span>}
                      </td>
                      <td className="num tnum hide-sm">
                        {money(x.product.price)}
                        {x.product.uom === "kg" ? " / kg" : ""}
                      </td>
                      <td>
                        <input
                          className="narrow"
                          type="number"
                          min={1}
                          max={500}
                          aria-label={`Copies of ${x.product.name}`}
                          value={x.copies}
                          onChange={(e) =>
                            setPicked(picked.map((p) => (p === x ? { ...p, copies: Math.max(1, Math.min(500, Math.floor(Number(e.target.value)) || 1)) } : p)))
                          }
                        />
                      </td>
                      <td className="actions">
                        <button type="button" className="btn ghost sm" aria-label={`Remove ${x.product.name}`} onClick={() => setPicked(picked.filter((p) => p !== x))}>
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dialog-actions label-actions">
              <Field label="Label stock">
                {(p) => (
                  <select {...p} value={template} onChange={(e) => setTemplate(e.target.value as Template)}>
                    {(Object.keys(TEMPLATES) as Template[]).map((k) => (
                      <option key={k} value={k}>
                        {TEMPLATES[k].name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <button type="button" className="btn ghost" onClick={() => setPicked([])}>
                Clear
              </button>
              <button type="button" className="btn primary" onClick={() => window.print()}>
                <Icon name="printer" /> Print {labels.length} {labels.length === 1 ? "label" : "labels"}
              </button>
            </div>
            <h3 className="noprint">Preview</h3>
          </>
        )}
      </div>
      {labels.length > 0 && (
        <>
          <style>{`@media print { @page { size: ${tpl.page}; margin: ${tpl.margin}; } }`}</style>
          <div className="labels-scroll">
            <div className={`labels-sheet ${template}`}>
              {labels.map((p, i) => (
                <Label key={i} product={p} />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
