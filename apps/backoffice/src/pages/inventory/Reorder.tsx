import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, errorText } from "../../lib/api.js";
import { aed, money } from "../../lib/format.js";
import { parseQty, qtyUnit, type ReorderLine, type Supplier } from "../../lib/inventory.js";
import { go } from "../../lib/router.js";
import type { Me } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";
import { StoreSelect } from "./Inventory.js";

/** Suggested orders; tick, adjust and turn them into one draft order per supplier. */
export function Reorder({ me }: { me: Me }) {
  const toast = useToast();
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const [coverDays, setCoverDays] = useState(14);
  const sug = useLoad(
    () => api<{ lines: ReorderLine[]; salesDays: number }>(`/inventory/reorder?storeId=${storeId}&coverDays=${coverDays}`),
    [storeId, coverDays],
  );
  const suppliers = useLoad(() => api<{ suppliers: Supplier[] }>("/suppliers?status=active"), []);
  const [picked, setPicked] = useState<Record<string, { on: boolean; qty: string; supplierId: string }>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sug.data) return;
    setPicked(Object.fromEntries(sug.data.lines.map((l) => [l.variantId, { on: !!l.supplierId, qty: String(l.qty), supplierId: l.supplierId ?? "" }])));
  }, [sug.data]);

  const lines = sug.data?.lines ?? [];
  const chosen = lines.filter((l) => picked[l.variantId]?.on);
  const value = chosen.reduce((s, l) => s + Math.round((Number(picked[l.variantId]!.qty) || 0) * l.unitCost), 0);
  const groups = new Set(chosen.map((l) => picked[l.variantId]!.supplierId));

  const create = async () => {
    const body = [];
    for (const l of chosen) {
      const p = picked[l.variantId]!;
      if (!p.supplierId) return toast(`Pick a supplier for ${l.name}`, "error");
      const qty = parseQty(p.qty, l.uom);
      if (qty === null) return toast(`Check the quantity for ${l.name}`, "error");
      body.push({ variantId: l.variantId, supplierId: p.supplierId, qty });
    }
    setBusy(true);
    try {
      const res = await api<{ orders: { id: string; number: string }[] }>("/inventory/reorder/purchase-orders", { body: { storeId, lines: body } });
      toast(`${res.orders.length} draft order${res.orders.length === 1 ? "" : "s"} created: ${res.orders.map((o) => o.number).join(", ")}`);
      go(res.orders.length === 1 ? `inventory/purchases/${res.orders[0]!.id}` : "inventory/purchases");
    } catch (err) {
      toast(errorText(err), "error");
      setBusy(false);
    }
  };

  const set = (id: string, patch: Partial<{ on: boolean; qty: string; supplierId: string }>) => setPicked({ ...picked, [id]: { ...picked[id]!, ...patch } });

  return (
    <>
      <div className="filters">
        <StoreSelect me={me} value={storeId} onChange={setStoreId} />
        <label className="inline-label">
          <span>Order enough for</span>
          <select aria-label="Days of stock to order" value={coverDays} onChange={(e) => setCoverDays(Number(e.target.value))}>
            {[7, 14, 21, 30, 45, 60].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        Products with a reorder level use it. The rest use the last {sug.data?.salesDays ?? 28} days of sales and the supplier's delivery time.
        Stock already ordered or on its way from another store counts. Set levels and suppliers per product on the Stock tab.
      </p>

      {sug.error ? (
        <ErrorState message={sug.error} onRetry={sug.reload} />
      ) : !sug.data ? (
        <SkeletonRows />
      ) : lines.length === 0 ? (
        <EmptyState icon="check" title="Nothing needs ordering">
          <p className="muted">Everything is above its reorder level, counting what is already on order.</p>
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={sug.loading}>
            <table className="table lines-table">
              <caption className="sr-only">Suggested orders</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Order</span>
                  </th>
                  <th scope="col">Product</th>
                  <th scope="col" className="num hide-xs">In stock</th>
                  <th scope="col" className="num hide-sm">Sells a day</th>
                  <th scope="col">Supplier</th>
                  <th scope="col" className="num">Order</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const p = picked[l.variantId];
                  if (!p) return null;
                  return (
                    <tr key={l.variantId} className={p.on ? undefined : "dim"}>
                      <td>
                        <input type="checkbox" aria-label={`Order ${l.name}`} checked={p.on} onChange={(e) => set(l.variantId, { on: e.target.checked })} />
                      </td>
                      <td>
                        {l.name}
                        <span className="cell-sub">
                          Reorder at {qtyUnit(l.reorderAt, l.uom)}
                          {l.auto ? " (from sales)" : ""} · up to {qtyUnit(l.orderUpTo, l.uom)}
                          {l.incoming > 0 ? ` · ${qtyUnit(l.incoming, l.uom)} on its way` : ""}
                        </span>
                      </td>
                      <td className={l.onHand <= 0 ? "num bad hide-xs" : "num hide-xs"}>{qtyUnit(l.onHand, l.uom)}</td>
                      <td className="num hide-sm">{l.dailySales || <span className="muted">0</span>}</td>
                      <td>
                        <select aria-label={`Supplier for ${l.name}`} value={p.supplierId} onChange={(e) => set(l.variantId, { supplierId: e.target.value, on: !!e.target.value || p.on })}>
                          <option value="">Pick…</option>
                          {suppliers.data?.suppliers.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="num">
                        <input aria-label={`Quantity of ${l.name}`} inputMode="decimal" value={p.qty} onChange={(e) => set(l.variantId, { qty: e.target.value })} />
                        <span className="cell-sub">@ {money(l.unitCost)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="sticky-actions">
            <span className="muted" style={{ marginRight: "auto", alignSelf: "center" }}>
              {chosen.length} product{chosen.length === 1 ? "" : "s"} · about {aed(value)} before VAT
            </span>
            <button type="button" className="btn primary" disabled={!chosen.length || busy} onClick={() => void create()}>
              {busy && <span className="spinner" aria-hidden="true" />}
              <Icon name="plus" /> Create {groups.size > 1 ? `${groups.size} draft orders` : "draft order"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
