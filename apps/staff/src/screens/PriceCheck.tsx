import { useState } from "react";
import { CodeInput, Scanner } from "../components/Scanner.js";
import { Empty } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, qty, shortDate } from "../lib/format.js";
import type { LookupItem } from "../lib/types.js";

interface Result {
  items: LookupItem[];
  scale: { kind: "weight" | "price"; value: number } | null;
}

/** Scan or type a code to see the price on the till, VAT and stock here and in other stores. */
export function PriceCheck() {
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [picked, setPicked] = useState<LookupItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Result>(`/staff/lookup?q=${encodeURIComponent(q.trim())}`);
      setResult(r);
      setPicked(r.items.length === 1 ? r.items[0]! : null);
      if (r.items.length === 1) setScanning(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <CodeInput value={code} onChange={setCode} onSubmit={() => look(code)} scanning={scanning} onScanToggle={() => setScanning(!scanning)} />
      {scanning && (
        <Scanner
          onCode={(c) => {
            setCode(c);
            void look(c);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      {busy && <span className="skeleton" aria-label="Looking up" />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!busy && picked ? (
        <ItemCard item={picked} scale={result?.scale ?? null} onBack={result && result.items.length > 1 ? () => setPicked(null) : undefined} />
      ) : !busy && result ? (
        result.items.length === 0 ? (
          <Empty title="Not found" text="No product has that barcode, SKU or name. Check the label, or ask the manager to add it." />
        ) : (
          <div className="card">
            <h2>{result.items.length} products</h2>
            <ul className="list">
              {result.items.map((i) => (
                <li key={i.variantId}>
                  <button type="button" className="btn ghost block" style={{ justifyContent: "space-between", textAlign: "left" }} onClick={() => setPicked(i)}>
                    <span className="grow">
                      <span className="title">{i.name}</span>
                      <span className="sub">{i.barcode ?? i.sku ?? ""}</span>
                    </span>
                    <span className="amount">{aed(i.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : (
        !busy &&
        !scanning && <p className="muted center-text">Scan a shelf label or a product, or type its barcode, SKU or name.</p>
      )}
    </>
  );
}

function ItemCard({ item, scale, onBack }: { item: LookupItem; scale: Result["scale"]; onBack?: () => void }) {
  const toast = useToast();
  const [copies, setCopies] = useState(1);
  const [asking, setAsking] = useState(false);
  const low = item.reorderLevel !== null && item.onHand <= item.reorderLevel;
  const ask = async () => {
    setAsking(true);
    try {
      await api("/staff/labels", { body: { variantId: item.variantId, copies } });
      toast(`${copies} ${copies === 1 ? "label" : "labels"} for ${item.name} sent to the back office`);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setAsking(false);
    }
  };
  return (
    <article className="card" aria-live="polite">
      {onBack && (
        <button type="button" className="btn ghost sm" onClick={onBack} style={{ marginBottom: 8 }}>
          ← All results
        </button>
      )}
      <h2 style={{ marginBottom: 0 }}>
        {item.name} {!item.active && <span className="badge warn">Off the tills</span>}
      </h2>
      {item.nameAr && (
        <p className="muted" dir="rtl" lang="ar" style={{ margin: 0 }}>
          {item.nameAr}
        </p>
      )}
      <p className="price">
        {aed(item.price)}
        {item.uom === "kg" && <span className="muted small"> per kg</span>}
      </p>
      {scale && (
        <p className="badge" style={{ marginBottom: 8 }}>
          {scale.kind === "weight" ? `This label: ${(scale.value / 1000).toFixed(3)} kg = ${aed(Math.round((item.price * scale.value) / 1000))}` : `This label: ${aed(scale.value)}`}
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>In this store</dt>
          <dd className={low ? "low" : ""}>
            {qty(item.onHand, item.uom)}
            {low && " · low"}
          </dd>
        </div>
        <div>
          <dt>Last delivery</dt>
          <dd>{shortDate(item.lastReceivedAt)}</dd>
        </div>
        <div>
          <dt>VAT</dt>
          <dd>{item.taxName ?? "None set"}</dd>
        </div>
        <div>
          <dt>Barcode</dt>
          <dd>{item.barcode ?? "—"}</dd>
        </div>
        {item.categoryName && (
          <div>
            <dt>Category</dt>
            <dd>{item.categoryName}</dd>
          </div>
        )}
        {item.otherStores.map((s) => (
          <div key={s.name}>
            <dt>{s.name}</dt>
            <dd>{qty(s.qty, item.uom)}</dd>
          </div>
        ))}
      </dl>
      <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
        <label htmlFor="copies">Shelf labels</label>
        <div className="row-input">
          <input id="copies" type="number" inputMode="numeric" min={1} max={100} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(100, Math.floor(Number(e.target.value)) || 1)))} style={{ maxWidth: 96 }} />
          <button type="button" className="btn" onClick={ask} disabled={asking}>
            {asking && <span className="spinner" aria-hidden />}
            Ask for labels
          </button>
        </div>
        <span className="hint">The back office prints them from Scales &amp; labels.</span>
      </div>
    </article>
  );
}
