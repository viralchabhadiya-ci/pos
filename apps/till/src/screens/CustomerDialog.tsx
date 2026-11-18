import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { OfflineError, request } from "../lib/api.js";
import type { CartCustomer } from "../lib/cart.js";
import { t } from "../lib/i18n.js";

interface Found {
  id: string;
  name: string;
  phone: string | null;
  priceListId?: string | null;
}

const toCustomer = (c: Found): CartCustomer => ({ id: c.id, name: c.name, phone: c.phone ?? null, priceListId: c.priceListId ?? null });

/**
 * Puts a customer on the sale: found by name or the last digits of their phone, or added
 * on the spot. Through a store hub this keeps working offline for customers added here.
 */
export function CustomerDialog({
  current,
  onPick,
  onCancel,
}: {
  current: CartCustomer | null;
  onPick: (c: CartCustomer | null) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      request<{ customers: Found[] }>(`/customers?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (!live) return;
          setFound(r.customers);
          setError(null);
        })
        .catch((err) => live && setError(err instanceof OfflineError ? t("Finding customers needs the connection.") : (err as Error).message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const c = { id: crypto.randomUUID(), name: name.trim(), phone: phone.trim() || null };
    try {
      await request("/customers", { body: { id: c.id, name: c.name, ...(c.phone ? { phone: c.phone } : {}) } });
      onPick({ ...c, priceListId: null });
    } catch (err) {
      setError(err instanceof OfflineError ? t("Adding a customer needs the connection.") : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} label={t("Customer")} wide>
      <h2>{t("Customer")}</h2>
      {current && (
        <div className="picked-customer">
          <span>
            <strong>{current.name}</strong>
            {current.phone && <small className="muted"> · <bdi>{current.phone}</bdi></small>}
          </span>
          <button type="button" className="btn ghost danger" onClick={() => onPick(null)}>
            {t("Remove from sale")}
          </button>
        </div>
      )}
      {!adding ? (
        <>
          <label htmlFor="cust-q">{t("Name or phone")}</label>
          <input id="cust-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("e.g. Ahmed or 4567")} autoComplete="off" autoFocus />
          <ul className="pick-list" aria-live="polite">
            {found?.map((c) => (
              <li key={c.id}>
                <button type="button" className="pick" onClick={() => onPick(toCustomer(c))}>
                  <strong>{c.name}</strong>
                  {c.phone && (
                    <small className="muted">
                      <bdi>{c.phone}</bdi>
                    </small>
                  )}
                </button>
              </li>
            ))}
            {found && found.length === 0 && <li className="muted">{t("No customer found.")}</li>}
          </ul>
        </>
      ) : (
        <form id="cust-add" onSubmit={add}>
          <label htmlFor="cust-name">{t("Name")}</label>
          <input id="cust-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
          <label htmlFor="cust-phone">{t("Mobile")}</label>
          <input id="cust-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} placeholder="+971 50 123 4567" />
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      )}
      <div className="actions">
        {adding ? (
          <>
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
              {t("Back")}
            </button>
            <button type="submit" form="cust-add" className="btn primary" disabled={busy || !name.trim()}>
              {t("Add customer")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={onCancel}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="btn outline"
              onClick={() => {
                setAdding(true);
                setError(null);
                // A typed number or name carries over to the new customer.
                if (/^[+\d\s]+$/.test(q.trim())) setPhone(q.trim());
                else setName(q.trim());
              }}
            >
              <Icon name="plus" size={18} />
              {t("New customer")}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
