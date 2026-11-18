import { useState } from "react";
import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/States.js";
import { useToast } from "../../components/Toast.js";
import { api, errorText } from "../../lib/api.js";
import { aed, money } from "../../lib/format.js";
import { dateOnly, parseQty, qtyUnit, type ExpiryLot } from "../../lib/inventory.js";
import type { Me } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";
import { StoreSelect } from "./Inventory.js";

/** Batches expiring soon, with a one-step write-off for what has to be thrown away. */
export function Expiry({ me }: { me: Me }) {
  const [storeId, setStoreId] = useState("");
  const [days, setDays] = useState(30);
  const [writing, setWriting] = useState<ExpiryLot | null>(null);
  const list = useLoad(() => api<{ lots: ExpiryLot[] }>(`/inventory/expiry?days=${days}${storeId ? `&storeId=${storeId}` : ""}`), [storeId, days]);
  const lots = list.data?.lots ?? [];
  const value = lots.reduce((s, l) => s + l.value, 0);

  return (
    <>
      <div className="filters">
        <StoreSelect me={me} value={storeId} onChange={setStoreId} all />
        <select aria-label="Expiring within" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 60, 90, 180].map((d) => (
            <option key={d} value={d}>
              Expiring within {d} days
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">
        Only products set to track expiry dates appear here. Sales do not say which batch was sold, so the oldest delivery is assumed to sell
        first. Writing off a batch here counts exactly.
      </p>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <SkeletonRows />
      ) : lots.length === 0 ? (
        <EmptyState icon="calendar" title={`Nothing expires in the next ${days} days`}>
          <p className="muted">Turn on expiry tracking for a product on the Stock tab; its expiry date is then asked for when goods arrive.</p>
        </EmptyState>
      ) : (
        <>
          <p className="notice warn">
            <Icon name="alert" /> {lots.length} batch{lots.length === 1 ? "" : "es"} worth about {aed(value)} at cost
          </p>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Batches expiring soon</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Expires</th>
                  <th scope="col" className="num">Probably left</th>
                  <th scope="col" className="num hide-xs">Value (AED)</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => (
                  <tr key={`${l.lotId}:${l.storeId}`}>
                    <td>
                      {l.name}
                      <span className="cell-sub">
                        Batch {l.code}
                        {me.stores.length > 1 ? ` · ${l.storeName}` : ""}
                      </span>
                    </td>
                    <td>
                      {dateOnly(l.expiresOn)}
                      <span className="cell-sub">
                        {l.expired ? (
                          <span className="badge bad">Expired</span>
                        ) : l.daysLeft <= 7 ? (
                          <span className="badge warn">{l.daysLeft === 0 ? "Today" : `${l.daysLeft} day${l.daysLeft === 1 ? "" : "s"}`}</span>
                        ) : (
                          `${l.daysLeft} days`
                        )}
                      </span>
                    </td>
                    <td className="num strong">{qtyUnit(l.remaining, l.uom)}</td>
                    <td className="num hide-xs">{money(l.value)}</td>
                    <td className="actions">
                      <button type="button" className="btn ghost sm" onClick={() => setWriting(l)}>
                        <Icon name="trash" size={18} /> <span className="hide-xs">Write off</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {writing && (
        <WriteOff
          lot={writing}
          onClose={() => setWriting(null)}
          onDone={() => {
            setWriting(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function WriteOff({ lot, onClose, onDone }: { lot: ExpiryLot; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState(String(lot.remaining));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = parseQty(qty, lot.uom);
    if (n === null) return setError(lot.uom === "unit" ? "Enter a whole number above zero." : "Enter a quantity above zero.");
    setBusy(true);
    try {
      await api("/inventory/adjustments", {
        body: { storeId: lot.storeId, reason: "waste", note: lot.expired ? "Expired" : "Near expiry", lines: [{ variantId: lot.variantId, qty: n, lotId: lot.lotId }] },
      });
      toast(`${qtyUnit(n, lot.uom)} of ${lot.name} written off`);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Write off batch">
      <h2>Write off {lot.name}</h2>
      <p className="muted">
        Batch {lot.code}, expires {dateOnly(lot.expiresOn)}. Enter how many are being thrown away.
      </p>
      <div className="field">
        <label htmlFor="wo-qty">Quantity</label>
        <input id="wo-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus aria-invalid={error ? true : undefined} />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Write off
        </button>
      </div>
    </Modal>
  );
}
