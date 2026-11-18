import "../../inventory.css";
import { go } from "../../lib/router.js";
import type { Me } from "../../lib/types.js";
import { Counts } from "./Counts.js";
import { Expiry } from "./Expiry.js";
import { Purchases } from "./Purchases.js";
import { Reorder } from "./Reorder.js";
import { Stock } from "./Stock.js";
import { Suppliers } from "./Suppliers.js";
import { Transfers } from "./Transfers.js";

const TABS = [
  { id: "stock", label: "Stock" },
  { id: "purchases", label: "Purchase orders" },
  { id: "reorder", label: "Reorder" },
  { id: "transfers", label: "Transfers" },
  { id: "counts", label: "Stock counts" },
  { id: "expiry", label: "Expiry" },
  { id: "suppliers", label: "Suppliers" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const INTRO: Record<Tab, string> = {
  stock: "What is on the shelf in each store, what it is worth at cost and what is on its way.",
  purchases: "Order from suppliers and book deliveries in. Receiving updates stock and the average cost.",
  reorder: "Products at or below their reorder level, with how much to order to last until the next delivery.",
  transfers: "Send stock from one store to another. It leaves when sent and arrives when the other store receives it.",
  counts: "Count the shelves and correct the stock. Sales made while counting are allowed for.",
  expiry: "Batches that expire soon and are probably still on the shelf.",
  suppliers: "Who you buy from, their contact details, payment terms and delivery time.",
};

/** Inventory: #/inventory/<tab>/<id>. Each tab is its own page with its own detail views. */
export function Inventory({ me, route }: { me: Me; route: string[] }) {
  const tab = (TABS.some((t) => t.id === route[0]) ? route[0] : "stock") as Tab;
  const id = route[1];
  return (
    <div className="page">
      {!id && (
        <>
          <header className="page-head">
            <div>
              <h1>Inventory</h1>
              <p className="muted">{INTRO[tab]}</p>
            </div>
          </header>
          <div className="tabs" role="tablist" aria-label="Inventory">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => go(`inventory/${t.id}`)}>
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}
      {tab === "stock" && <Stock me={me} />}
      {tab === "purchases" && <Purchases me={me} id={id} />}
      {tab === "reorder" && <Reorder me={me} />}
      {tab === "transfers" && <Transfers me={me} id={id} />}
      {tab === "counts" && <Counts me={me} id={id} />}
      {tab === "expiry" && <Expiry me={me} />}
      {tab === "suppliers" && <Suppliers />}
    </div>
  );
}

/** Store picker shared by the tabs; hidden when the business has one store. */
export function StoreSelect({
  me,
  value,
  onChange,
  all,
  label = "Store",
}: {
  me: Me;
  value: string;
  onChange: (id: string) => void;
  all?: boolean;
  label?: string;
}) {
  if (me.stores.length < 2) return null;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {all && <option value="">All stores</option>}
      {me.stores.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

export function StatusBadge({ tone, label }: { tone?: string; label: string }) {
  return <span className={tone ? `badge ${tone}` : "badge"}>{label}</span>;
}
