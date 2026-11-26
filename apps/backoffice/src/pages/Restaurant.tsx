import { useMemo, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, ago, money, tryParseMoney } from "../lib/format.js";
import type { Me, Product } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface DiningTable {
  id: string;
  area: string;
  name: string;
  seats: number;
  sort: number;
}
interface OpenTab {
  id: string;
  tableId: string | null;
  tableName: string | null;
  name: string | null;
  guests: number | null;
  total: number;
  openedAt: string;
  updatedAt: string;
  openedBy: string | null;
  lines: number;
}
interface Option {
  id?: string;
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
  productIds: string[];
}
interface KitchenToday {
  tickets: number;
  open: number;
  ready: number;
  avgSeconds: number | null;
  maxSeconds: number | null;
  oldestOpenSeconds: number | null;
}
interface Overview {
  kitchen: KitchenToday;
  storeId: string;
  tables: DiningTable[];
  openTabs: OpenTab[];
  modifierGroups: Group[];
}

function rule(g: Pick<Group, "minChoices" | "maxChoices">): string {
  if (g.maxChoices === 1) return g.minChoices ? "Pick 1" : "Optional, pick 1";
  if (g.maxChoices === 0) return g.minChoices ? `Pick at least ${g.minChoices}` : "Optional, pick any";
  return g.minChoices ? `Pick ${g.minChoices} to ${g.maxChoices}` : `Optional, up to ${g.maxChoices}`;
}

/** Restaurants: each store's tables, the bills open on them now, and the choices items are made with. */
export function Restaurant({ me, tab }: { me: Me; tab?: string }) {
  const hq = me.user.storeIds === null;
  const current = tab === "bills" || tab === "modifiers" ? tab : "tables";
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const data = useLoad(() => api<Overview>(`/restaurant?storeId=${encodeURIComponent(storeId)}`), [storeId]);
  const o = data.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Restaurant</h1>
          <p className="muted">Tables on the till's floor plan, bills open on them, and choices like size, extras or “no onion”.</p>
        </div>
        {me.stores.length > 1 && current !== "modifiers" && (
          <label className="inline-label">
            <span>Store</span>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {me.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <div className="tabs" role="tablist" aria-label="Restaurant">
        {(
          [
            ["tables", `Tables${o ? ` (${o.tables.length})` : ""}`, "#/restaurant"],
            ["bills", `Open bills${o ? ` (${o.openTabs.length})` : ""}`, "#/restaurant/bills"],
            ["modifiers", "Choices", "#/restaurant/modifiers"],
          ] as const
        ).map(([id, label, href]) => (
          <a key={id} role="tab" className="tab tab-link" aria-selected={current === id} href={href}>
            {label}
          </a>
        ))}
      </div>
      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !o ? (
        <SkeletonRows rows={4} />
      ) : current === "tables" ? (
        <Tables o={o} onChanged={data.reload} />
      ) : current === "bills" ? (
        <Bills o={o} onChanged={data.reload} />
      ) : (
        <Groups o={o} hq={hq} onChanged={data.reload} />
      )}
    </div>
  );
}

// Tables

function Tables({ o, onChanged }: { o: Overview; onChanged: () => void }) {
  const [editing, setEditing] = useState<DiningTable | "new" | null>(null);
  const [bulk, setBulk] = useState(false);
  const busy = new Set(o.openTabs.map((t) => t.tableId));
  const areas = [...new Set(o.tables.map((t) => t.area))];
  const done = () => {
    setEditing(null);
    setBulk(false);
    onChanged();
  };

  return (
    <>
      <div className="section-head">
        <button type="button" className="btn primary" onClick={() => setBulk(true)}>
          <Icon name="plus" /> Add tables
        </button>
        <button type="button" className="btn" onClick={() => setEditing("new")}>
          Add one table
        </button>
      </div>
      {!o.tables.length ? (
        <EmptyState icon="table" title="No tables in this store yet">
          <p>Add tables and the till shows a Tables button with the floor. Cashiers and waiters open a bill on a table, send orders to the kitchen and pay when guests leave.</p>
        </EmptyState>
      ) : (
        areas.map((area) => (
          <section key={area} className="panel">
            <h2>{area}</h2>
            <ul className="table-grid">
              {o.tables
                .filter((t) => t.area === area)
                .map((t) => (
                  <li key={t.id}>
                    <button type="button" className={busy.has(t.id) ? "table-card busy" : "table-card"} onClick={() => setEditing(t)}>
                      <strong>{t.name}</strong>
                      <span className="muted small">
                        {t.seats} seats{busy.has(t.id) ? " · open bill" : ""}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
      {editing && <TableDialog o={o} table={editing === "new" ? undefined : editing} areas={areas} onClose={() => setEditing(null)} onSaved={done} />}
      {bulk && <BulkDialog o={o} areas={areas} onClose={() => setBulk(false)} onSaved={done} />}
    </>
  );
}

function TableDialog({ o, table, areas, onClose, onSaved }: { o: Overview; table?: DiningTable; areas: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ area: table?.area ?? areas[0] ?? "Main", name: table?.name ?? "", seats: String(table?.seats ?? 4) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const listId = "areas-list";

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { area: form.area.trim() || "Main", name: form.name.trim(), seats: Number(form.seats) || 1 };
    void run(
      () => api(table ? `/dining-tables/${table.id}` : "/dining-tables", { method: table ? "PUT" : "POST", body: table ? body : { ...body, storeId: o.storeId } }),
      table ? `Table ${body.name} saved` : `Table ${body.name} added`,
    );
  };

  return (
    <Modal onClose={onClose} label={table ? `Table ${table.name}` : "Add a table"}>
      <h2>{table ? `Table ${table.name}` : "Add a table"}</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Name" required hint="Short, as staff say it: 12, T4, Terrace 2">
            {(p) => <input {...p} value={form.name} onChange={set("name")} maxLength={30} autoFocus />}
          </Field>
          <Field label="Seats">
            {(p) => <input {...p} type="number" inputMode="numeric" min={1} max={100} value={form.seats} onChange={set("seats")} />}
          </Field>
          <Field label="Area" hint="Inside, Terrace, Upstairs… The till shows one area at a time.">
            {(p) => <input {...p} value={form.area} onChange={set("area")} maxLength={40} list={listId} />}
          </Field>
        </div>
        <datalist id={listId}>
          {areas.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          {table && (
            <>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => api(`/dining-tables/${table.id}`, { method: "DELETE" }), `Table ${table.name} removed`)}>
                Remove
              </button>
              <span className="spacer-x" />
            </>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !form.name.trim()}>
            {table ? "Save" : "Add table"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BulkDialog({ o, areas, onClose, onSaved }: { o: Overview; areas: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ area: areas[0] ?? "Main", prefix: "", from: "1", to: "10", seats: "4" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const from = Number(form.from);
  const to = Number(form.to);
  const valid = Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to - from < 200;
  const prefix = form.prefix.trim();
  const example = valid ? `${prefix}${from}${to > from ? ` to ${prefix}${to}` : ""}` : "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return setError("Numbers run from the first to the last, up to 200 tables at a time.");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ added: number; skipped: number }>("/dining-tables/bulk", {
        body: { storeId: o.storeId, area: form.area.trim() || "Main", prefix, from, to, seats: Number(form.seats) || 1 },
      });
      toast(`${r.added} tables added${r.skipped ? `, ${r.skipped} already there` : ""}`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Add tables">
      <h2>Add tables</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Area">
            {(p) => <input {...p} value={form.area} onChange={set("area")} maxLength={40} list="bulk-areas" autoFocus />}
          </Field>
          <Field label="Before the number" hint="Optional, e.g. T or Terrace ">
            {(p) => <input {...p} value={form.prefix} onChange={set("prefix")} maxLength={10} />}
          </Field>
          <Field label="From">
            {(p) => <input {...p} type="number" inputMode="numeric" min={0} value={form.from} onChange={set("from")} />}
          </Field>
          <Field label="To">
            {(p) => <input {...p} type="number" inputMode="numeric" min={0} value={form.to} onChange={set("to")} />}
          </Field>
          <Field label="Seats each">
            {(p) => <input {...p} type="number" inputMode="numeric" min={1} max={100} value={form.seats} onChange={set("seats")} />}
          </Field>
        </div>
        <datalist id="bulk-areas">
          {areas.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        {example && <p className="hint">Adds tables {example}. Names this store already has are skipped.</p>}
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Add tables
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Open bills

const minutes = (s: number | null) => (s === null ? "–" : s < 60 ? "under 1 min" : `${Math.round(s / 60)} min`);

function Kitchen({ k }: { k: KitchenToday }) {
  if (!k.tickets) return null;
  return (
    <section className="panel" aria-labelledby="kitchen-today">
      <h2 id="kitchen-today">Kitchen today</h2>
      <dl className="stat-row">
        <div>
          <dt>Tickets</dt>
          <dd className="tnum">{k.tickets}</dd>
        </div>
        <div>
          <dt>Being made</dt>
          <dd className="tnum">{k.open - k.ready}</dd>
        </div>
        <div>
          <dt>Waiting to be picked up</dt>
          <dd className="tnum">{k.ready}</dd>
        </div>
        <div>
          <dt>Average time to ready</dt>
          <dd className="tnum">{minutes(k.avgSeconds)}</dd>
        </div>
        <div>
          <dt>Longest</dt>
          <dd className="tnum">{minutes(k.maxSeconds)}</dd>
        </div>
      </dl>
      {k.oldestOpenSeconds !== null && k.oldestOpenSeconds > 20 * 60 && (
        <p className="notice warn">
          <Icon name="alert" /> One ticket has waited {minutes(k.oldestOpenSeconds)}.
        </p>
      )}
    </section>
  );
}

function Bills({ o, onChanged }: { o: Overview; onChanged: () => void }) {
  if (!o.openTabs.length)
    return (
      <>
        <Kitchen k={o.kitchen} />
        <EmptyState icon="receipt" title="No open bills">
          <p>Bills opened on the till show here until they are paid.</p>
        </EmptyState>
      </>
    );
  const total = o.openTabs.reduce((s, t) => s + t.total, 0);
  return (
    <>
      <Kitchen k={o.kitchen} />
      <div className="section-head">
        <p className="muted">
          {o.openTabs.length} open · {aed(total)} not paid yet
        </p>
        <button type="button" className="btn" onClick={onChanged}>
          <Icon name="refresh" /> Refresh
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Open bills</caption>
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Opened</th>
              <th scope="col" className="num">
                Items
              </th>
              <th scope="col" className="num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {o.openTabs.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.tableName ? `Table ${t.tableName}` : (t.name ?? "Tab")}</strong>
                  {t.guests ? <span className="cell-sub">{t.guests} guests</span> : null}
                </td>
                <td>
                  {ago(t.openedAt)}
                  {t.openedBy && <span className="cell-sub">by {t.openedBy}</span>}
                </td>
                <td className="num tnum">{t.lines}</td>
                <td className="num tnum">{money(t.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Bills are paid, moved or voided on the till. Voiding a bill needs a manager and goes in the audit log.</p>
    </>
  );
}

// Modifier groups

function Groups({ o, hq, onChanged }: { o: Overview; hq: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const products = useLoad(() => api<{ products: Product[] }>("/products"), []);
  const productName = useMemo(() => new Map((products.data?.products ?? []).map((p) => [p.id, p.name])), [products.data]);

  return (
    <>
      <div className="section-head">
        <p className="muted">The till asks for these when an item that has them is added, and the price of each choice is added to the item.</p>
        {hq && (
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> New group
          </button>
        )}
      </div>
      {!o.modifierGroups.length ? (
        <EmptyState icon="list" title="No choices yet">
          <p>
            For example a group “Size” with Small, Medium (+2.00) and Large (+4.00) where one must be picked, or “Extras” with cheese and egg where any can be
            picked.
          </p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Choice groups</caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Options</th>
                <th scope="col">Used on</th>
              </tr>
            </thead>
            <tbody>
              {o.modifierGroups.map((g) => (
                <tr key={g.id}>
                  <td>
                    {hq ? (
                      <button type="button" className="row-link plain" onClick={() => setEditing(g)}>
                        {g.name}
                      </button>
                    ) : (
                      <strong>{g.name}</strong>
                    )}
                    <span className="cell-sub">{rule(g)}</span>
                  </td>
                  <td>
                    {g.options
                      .slice(0, 6)
                      .map((x) => (x.price ? `${x.name} +${money(x.price)}` : x.name))
                      .join(", ")}
                    {g.options.length > 6 ? ` and ${g.options.length - 6} more` : ""}
                  </td>
                  <td>
                    {g.productIds.length ? (
                      `${g.productIds.length} product${g.productIds.length === 1 ? "" : "s"}`
                    ) : (
                      <span className="muted">No products yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <GroupDialog
          group={editing === "new" ? undefined : editing}
          products={products.data?.products ?? []}
          productName={productName}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

interface OptionRow {
  id?: string;
  name: string;
  nameAr: string;
  price: string;
}

function GroupDialog({
  group,
  products,
  productName,
  onClose,
  onSaved,
}: {
  group?: Group;
  products: Product[];
  productName: Map<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? "");
  const [nameAr, setNameAr] = useState(group?.nameAr ?? "");
  const [kind, setKind] = useState<"one" | "any" | "range">(group ? (group.maxChoices === 1 ? "one" : group.maxChoices === 0 ? "any" : "range") : "one");
  const [required, setRequired] = useState(group ? group.minChoices > 0 : true);
  const [min, setMin] = useState(String(group?.minChoices || 1));
  const [max, setMax] = useState(String(group && group.maxChoices > 1 ? group.maxChoices : 2));
  const [options, setOptions] = useState<OptionRow[]>(
    group?.options.map((x) => ({ id: x.id, name: x.name, nameAr: x.nameAr ?? "", price: x.price ? money(x.price) : "" })) ?? [{ name: "", nameAr: "", price: "" }],
  );
  const [productIds, setProductIds] = useState<string[]>(group?.productIds ?? []);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => !productIds.includes(p.id) && (p.name.toLowerCase().includes(q) || p.barcode === q || p.sku?.toLowerCase() === q)).slice(0, 8);
  }, [search, products, productIds]);

  const setOption = (i: number, patch: Partial<OptionRow>) => setOptions((xs) => xs.map((x, j) => (i === j ? { ...x, ...patch } : x)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const rows = options.filter((x) => x.name.trim() || x.price.trim());
    const parsed = rows.map((x) => ({ id: x.id, name: x.name.trim(), nameAr: x.nameAr.trim() || null, price: x.price.trim() ? tryParseMoney(x.price) : 0 }));
    if (!name.trim()) return setError("Give the group a name.");
    if (!parsed.length) return setError("Add at least one option.");
    if (parsed.some((x) => !x.name)) return setError("Name every option.");
    if (parsed.some((x) => x.price === null || x.price < 0)) return setError("Write extra prices like 2.50, or leave them empty.");
    const maxN = kind === "one" ? 1 : kind === "any" ? 0 : Number(max);
    const minN = !required ? 0 : kind === "one" ? 1 : Number(min);
    if (kind === "range" && (!Number.isInteger(maxN) || maxN < 2 || maxN > 20)) return setError("The most that can be picked is 2 to 20.");
    if (!Number.isInteger(minN) || minN < 0 || (maxN && minN > maxN)) return setError("The fewest to pick can't be more than the most.");
    if (minN > parsed.length) return setError("There are fewer options than must be picked.");
    setBusy(true);
    try {
      await api(group ? `/modifier-groups/${group.id}` : "/modifier-groups", {
        method: group ? "PUT" : "POST",
        body: { name: name.trim(), nameAr: nameAr.trim() || null, minChoices: minN, maxChoices: maxN, options: parsed, productIds },
      });
      toast(`${name.trim()} saved. Tills get it with the next sync.`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!group) return;
    setBusy(true);
    try {
      await api(`/modifier-groups/${group.id}`, { method: "DELETE" });
      toast(`${group.name} deleted`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={group ? group.name : "New choice group"} wide>
      <h2>{group ? group.name : "New choice group"}</h2>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Name" required hint="What the till asks: Size, Extras, Cooking">
            {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus={!group} />}
          </Field>
          <Field label="Name in Arabic">
            {(p) => <input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={60} />}
          </Field>
          <Field label="How many can be picked">
            {(p) => (
              <select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="one">One</option>
                <option value="any">Any number</option>
                <option value="range">Up to a number</option>
              </select>
            )}
          </Field>
          {kind === "range" && (
            <Field label="At most">
              {(p) => <input {...p} type="number" inputMode="numeric" min={2} max={20} value={max} onChange={(e) => setMax(e.target.value)} />}
            </Field>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <span>The cashier must pick {kind === "one" ? "one" : "before adding the item"}</span>
        </label>
        {kind !== "one" && required && (
          <div className="form-grid">
            <Field label="At least">
              {(p) => <input {...p} type="number" inputMode="numeric" min={1} max={20} value={min} onChange={(e) => setMin(e.target.value)} />}
            </Field>
          </div>
        )}

        <fieldset className="options-edit">
          <legend>Options</legend>
          <div className="option-row head" aria-hidden="true">
            <span>Name</span>
            <span>Arabic</span>
            <span>Extra price</span>
            <span />
          </div>
          {options.map((x, i) => (
            <div key={i} className="option-row">
              <input aria-label={`Option ${i + 1} name`} value={x.name} onChange={(e) => setOption(i, { name: e.target.value })} maxLength={60} placeholder="e.g. Large" />
              <input aria-label={`Option ${i + 1} Arabic name`} dir="rtl" lang="ar" value={x.nameAr} onChange={(e) => setOption(i, { nameAr: e.target.value })} maxLength={60} placeholder="بالعربية" />
              <input
                aria-label={`Option ${i + 1} extra price`}
                className="tnum"
                inputMode="decimal"
                value={x.price}
                onChange={(e) => setOption(i, { price: e.target.value })}
                placeholder="0.00"
              />
              <button
                type="button"
                className="icon-btn"
                disabled={options.length === 1}
                onClick={() => setOptions((xs) => xs.filter((_, j) => j !== i))}
                aria-label={`Remove option ${x.name || i + 1}`}
              >
                <Icon name="trash" size={18} />
              </button>
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => setOptions((xs) => [...xs, { name: "", nameAr: "", price: "" }])} disabled={options.length >= 40}>
            <Icon name="plus" size={16} /> Add option
          </button>
        </fieldset>

        <Field label="Products that ask for it" hint="Search by name, barcode or SKU.">
          {(p) => <input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" autoComplete="off" />}
        </Field>
        {matches.length > 0 && (
          <ul className="pick-results">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setProductIds((ids) => [...ids, m.id]);
                    setSearch("");
                  }}
                >
                  <Icon name="plus" size={16} /> {m.name} <span className="muted">{aed(m.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {productIds.length > 0 && (
          <ul className="picked">
            {productIds.map((id) => (
              <li key={id}>
                {productName.get(id) ?? "Product"}
                <button type="button" className="icon-btn" onClick={() => setProductIds((ids) => ids.filter((x) => x !== id))} aria-label={`Remove ${productName.get(id) ?? "product"}`}>
                  <Icon name="close" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        {confirmDelete ? (
          <div className="dialog-actions">
            <span className="muted">Delete {group?.name}? Products stop asking for it.</span>
            <span className="spacer-x" />
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button type="button" className="btn danger-solid" disabled={busy} onClick={() => void remove()}>
              Delete group
            </button>
          </div>
        ) : (
          <div className="dialog-actions">
            {group && (
              <>
                <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
                <span className="spacer-x" />
              </>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              Save
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
