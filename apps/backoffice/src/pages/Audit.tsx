import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { api } from "../lib/api.js";
import { dateTime, money } from "../lib/format.js";
import type { AuditEntry } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const PAGE = 50;

const ENTITIES = [
  { value: "", label: "Everything" },
  { value: "product", label: "Products and stock" },
  { value: "category", label: "Categories" },
  { value: "tax", label: "VAT rates" },
  { value: "user", label: "Staff" },
  { value: "customer", label: "Customers" },
  { value: "register", label: "Registers" },
  { value: "device", label: "Devices" },
  { value: "store", label: "Store settings" },
  { value: "order", label: "Bills" },
  { value: "session", label: "Shifts" },
  { value: "till_event", label: "Till: voids, drawer, overrides" },
  { value: "approval", label: "Approvals from the owner app" },
];

/** What happened at a till, said the way an owner would. */
const TILL_EVENTS: Record<string, string> = {
  "till.void": "Sale voided at the till",
  "till.no_sale": "Cash drawer opened with no sale",
  "till.price_override": "Price changed at the till",
  "till.discount": "Big discount allowed at the till",
  "till.refund": "Refund allowed at the till",
  "receipt.email": "Receipt emailed to the customer",
  "approval.request": "Till asked the owner for approval",
  "approval.approved": "Approved from the owner app",
  "approval.denied": "Denied from the owner app",
};

/** "product.update" → "Product updated", readable for owners. */
function describe(e: AuditEntry): string {
  const known = TILL_EVENTS[e.action];
  if (known) return known;
  const [entity = "", verb = ""] = e.action.split(".");
  const nouns: Record<string, string> = { session: "shift", cash: "cash", staff: "staff member", tax: "VAT rate", order: "bill" };
  const noun = nouns[entity] ?? entity.replace(/_/g, " ");
  const verbs: Record<string, string> = {
    create: "added",
    update: "changed",
    revoke: "removed",
    receive: "goods received",
    adjust: "corrected",
    import: "imported from CSV",
    pairing_code: "pairing code made",
    login: "signed in",
    open: "opened",
    close: "closed",
    in: "paid in",
    out: "paid out",
    discount: "discount given",
    totals_mismatch: "total did not match the server",
  };
  const text = verbs[verb] ?? verb.replace(/_/g, " ");
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${text}`.trim();
}

/** The interesting part of the change, kept short. Prices are shown in AED. */
function details(e: AuditEntry): string {
  const d = e.data ?? {};
  const parts: string[] = [];
  if (typeof d.summary === "string" && e.entity === "till_event") parts.push(d.summary);
  if (typeof d.name === "string") parts.push(d.name);
  if (typeof d.priceFrom === "number" && typeof d.priceTo === "number") parts.push(`price ${money(d.priceFrom)} → ${money(d.priceTo)}`);
  else if (typeof d.price === "number") parts.push(`price ${money(d.price)}`);
  // A till event's summary already says the amount.
  if (typeof d.amount === "number" && e.entity !== "till_event") parts.push(`AED ${money(d.amount)}`);
  if (typeof d.discount === "number") parts.push(`AED ${money(d.discount)} off`);
  if (typeof d.qty === "number") parts.push(`qty ${d.qty > 0 ? "+" : ""}${d.qty}`);
  if (typeof d.active === "boolean") parts.push(d.active ? "switched on" : "switched off");
  if (typeof d.create === "number") parts.push(`${d.create} added, ${d.update} updated`);
  if (typeof d.role === "string" && !d.name) parts.push(d.role);
  if (d.source === "import") parts.push("from CSV");
  if (typeof d.approvedByName === "string") parts.push(`approved by ${d.approvedByName}${d.approvalId ? " from the owner app" : ""}`);
  else if (e.entity === "till_event" && d.approvalId) parts.push("approved from the owner app");
  if (typeof d.domain === "string") parts.push(`to an address at ${d.domain}`);
  return parts.join(" · ");
}

export function Audit() {
  const [entity, setEntity] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useLoad(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (entity) p.set("entity", entity);
    if (search) p.set("q", search);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return api<{ entries: AuditEntry[]; count: number }>(`/audit?${p}`);
  }, [entity, search, from, to, offset]);
  const data = list.data;
  const filtered = entity || search || from || to;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted">Who changed what, from the back office and the tills. Entries cannot be edited or deleted.</p>
        </div>
      </header>

      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search the log" placeholder="Search, e.g. a product name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Area" value={entity} onChange={(e) => (setEntity(e.target.value), setOffset(0))}>
          {ENTITIES.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
        <label className="inline-label">
          <span>From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => (setFrom(e.target.value), setOffset(0))} />
        </label>
        <label className="inline-label">
          <span>To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => (setTo(e.target.value), setOffset(0))} />
        </label>
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="history" title={filtered ? "Nothing matches" : "Nothing logged yet"} />
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Audit log</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col" className="hide-sm">Who</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap-md">{dateTime(e.at)}</td>
                    <td>
                      <span className="cell-main">{describe(e)}</span>
                      {details(e) && <span className="cell-sub">{details(e)}</span>}
                      <span className="cell-sub show-xs">{e.userName ?? e.deviceName ?? "System"}</span>
                    </td>
                    <td className="hide-sm">
                      {e.userName ?? "System"}
                      {e.deviceName && <span className="cell-sub">on {e.deviceName}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.count > PAGE && (
            <nav className="pager" aria-label="Pages">
              <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <Icon name="chevronLeft" /> Newer
              </button>
              <span className="muted">
                {offset + 1}–{Math.min(offset + PAGE, data.count)} of {data.count}
              </span>
              <button type="button" className="btn" disabled={offset + PAGE >= data.count} onClick={() => setOffset(offset + PAGE)}>
                Older <Icon name="chevronRight" />
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
