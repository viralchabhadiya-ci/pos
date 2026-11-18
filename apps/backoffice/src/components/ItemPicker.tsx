import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../lib/api.js";
import { money } from "../lib/format.js";
import { qtyUnit, type PickItem } from "../lib/inventory.js";
import { Icon } from "./Icon.js";

/**
 * Finds a product to add to a document: type a name, or scan a barcode (a scanner types the
 * code and presses Enter, which adds the exact match straight away).
 */
export function ItemPicker({
  storeId,
  supplierId,
  onPick,
  exclude = [],
  label = "Add a product",
}: {
  storeId?: string;
  supplierId?: string;
  onPick: (item: PickItem) => void;
  exclude?: string[];
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const search = async (text: string) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const p = new URLSearchParams({ q: text });
      if (storeId) p.set("storeId", storeId);
      if (supplierId) p.set("supplierId", supplierId);
      const res = await api<{ items: PickItem[] }>(`/inventory/items?${p}`);
      if (mine !== seq.current) return null;
      setItems(res.items);
      setActive(0);
      return res.items;
    } catch {
      if (mine === seq.current) setItems([]);
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!q.trim()) {
      setItems([]);
      return;
    }
    const t = setTimeout(() => void search(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q, storeId, supplierId]);

  const pick = (item: PickItem) => {
    if (exclude.includes(item.variantId)) {
      setNote(`${item.name} is already on the list`);
    } else {
      onPick(item);
      setNote(null);
    }
    setQ("");
    setItems([]);
    setOpen(false);
    input.current?.focus();
  };

  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const text = q.trim();
      if (!text) return;
      // A scan arrives faster than the search pause, so look it up now.
      const list = items.length && open ? items : await search(text);
      const exact = list?.find((i) => i.barcode === text || i.sku === text || i.supplierSku === text);
      const chosen = exact ?? (open ? list?.[active] : list?.length === 1 ? list[0] : undefined);
      if (chosen) pick(chosen);
      else {
        setOpen(true);
        if (list && !list.length) setNote(`Nothing matches “${text}”`);
      }
    }
  };

  const show = open && q.trim() !== "";
  return (
    <div className="picker">
      <label className="sr-only" htmlFor={`${listId}-in`}>
        {label}
      </label>
      <div className="search">
        <Icon name="search" />
        <input
          ref={input}
          id={`${listId}-in`}
          type="search"
          role="combobox"
          aria-expanded={show}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={show && items[active] ? `${listId}-${active}` : undefined}
          placeholder={`${label}: name, barcode or SKU`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setNote(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => void onKeyDown(e)}
          autoComplete="off"
        />
      </div>
      {show && (
        <ul className="picker-list" id={listId} role="listbox" aria-busy={loading}>
          {items.length === 0 ? (
            <li className="picker-empty muted">{loading ? "Searching…" : "No products match"}</li>
          ) : (
            items.map((it, i) => (
              <li
                key={it.variantId}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={exclude.includes(it.variantId) ? "picker-item dim" : "picker-item"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(it)}
                onMouseEnter={() => setActive(i)}
              >
                <span className="cell-main">{it.name}</span>
                <span className="cell-sub">
                  {[it.barcode, it.supplierSku && `Supplier code ${it.supplierSku}`].filter(Boolean).join(" · ") || "No barcode"}
                  {" · "}In stock {qtyUnit(it.onHand, it.uom)}
                  {(it.supplierCost ?? it.cost) !== null && <> · Cost {money((it.supplierCost ?? it.cost)!)}</>}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
