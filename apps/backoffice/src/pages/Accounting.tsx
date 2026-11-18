import { useState, type FormEvent } from "react";
import "../accounting.css";
import { Icon } from "../components/Icon.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import {
  ACCOUNT_FIELDS,
  FILE_PREFIX,
  FORMAT_LABEL,
  type Account,
  type AccountingConfig,
  type AccountingSettings,
  type ExportFormat,
  type Journal,
  type JournalsResponse,
  type Vat201,
} from "../lib/accounting.js";
import { api, download, errorText } from "../lib/api.js";
import { EMIRATES, type Emirate } from "../lib/einvoice.js";
import { aed, dateTime, dayLabel, money, tryParseMoney } from "../lib/format.js";
import { go } from "../lib/router.js";
import type { Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

type Tab = "journals" | "vat" | "settings";
const TABS: { id: Tab; label: string; path: string }[] = [
  { id: "journals", label: "Daily journals", path: "accounting" },
  { id: "vat", label: "VAT return", path: "accounting/vat" },
  { id: "settings", label: "Accounts", path: "accounting/settings" },
];

/** Dates in Dubai time, since the shops count their days there. */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function monthPresets() {
  const today = ymd(new Date());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const yesterday = ymd(new Date(Date.now() - 86_400_000));
  return [
    { label: "Yesterday", from: yesterday, to: yesterday },
    { label: "This month", from: `${today.slice(0, 7)}-01`, to: today },
    { label: "Last month", from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) },
  ];
}

/** Calendar quarters. Many businesses file quarterly; the FTA sets each one's exact periods. */
function quarterPresets() {
  const today = ymd(new Date());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3);
  const quarter = (year: number, qi: number) => ({
    from: iso(new Date(Date.UTC(year, qi * 3, 1))),
    to: iso(new Date(Date.UTC(year, qi * 3 + 3, 0))),
  });
  const last = q === 0 ? quarter(y - 1, 3) : quarter(y, q - 1);
  return [
    { label: "This quarter", ...quarter(y, q) },
    { label: "Last quarter", ...last },
    { label: "Last month", from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) },
  ];
}

/** The books: daily journals to import into the accounting tool, the VAT return, and the account mapping. */
export function Accounting({ me, tab }: { me: Me; tab?: string }) {
  const current: Tab = tab === "vat" ? "vat" : tab === "settings" ? "settings" : "journals";
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Accounting</h1>
          <p className="muted">
            Each store day as one balanced journal, ready to import into Xero, QuickBooks or Zoho Books, and the figures for your VAT return.
          </p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Accounting">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={current === t.id} onClick={() => go(t.path)}>
            {t.label}
          </button>
        ))}
      </div>
      {current === "settings" ? <SettingsForm owner={me.user.role === "owner"} /> : current === "vat" ? <VatReturn /> : <Journals me={me} />}
    </div>
  );
}

function RangePicker({
  presets,
  range,
  onChange,
  children,
}: {
  presets: { label: string; from: string; to: string }[];
  range: { from: string; to: string };
  onChange: (r: { from: string; to: string }) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="filters">
      <div className="chips" role="group" aria-label="Quick dates">
        {presets.map((p) => (
          <button key={p.label} type="button" className="chip" aria-pressed={p.from === range.from && p.to === range.to} onClick={() => onChange(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <label className="inline-label">
        <span>From</span>
        <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && onChange({ ...range, from: e.target.value })} />
      </label>
      <label className="inline-label">
        <span>To</span>
        <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && onChange({ ...range, to: e.target.value })} />
      </label>
      {children}
    </div>
  );
}

const TOOLS: { format: ExportFormat; hint: string }[] = [
  { format: "xero", hint: "Manual journals import" },
  { format: "quickbooks", hint: "Journal entries import" },
  { format: "zoho", hint: "Manual journals import" },
  { format: "generic", hint: "Debit and credit, any tool" },
];
const LISTINGS: ExportFormat[] = ["sales", "vat", "payments"];

function Journals({ me }: { me: Me }) {
  const toast = useToast();
  const [range, setRange] = useState(() => monthPresets()[0]!);
  const [storeId, setStoreId] = useState("");
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const q = `from=${range.from}&to=${range.to}${storeId ? `&storeId=${storeId}` : ""}`;
  const data = useLoad(() => api<JournalsResponse>(`/accounting/journals?${q}`), [q]);

  const exportAs = async (format: ExportFormat) => {
    setBusy(format);
    try {
      await download(`/accounting/export?${q}&format=${format}`, `${FILE_PREFIX[format]}-${range.from}-to-${range.to}.csv`);
      if (!LISTINGS.includes(format)) await data.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const d = data.data;
  const warnings = d?.journals.reduce((n, j) => n + j.warnings.length, 0) ?? 0;
  const empty = d && d.journals.length === 0;

  return (
    <>
      <RangePicker presets={monthPresets()} range={range} onChange={(r) => setRange({ ...r, label: "" })}>
        {me.stores.length > 1 && (
          <label className="inline-label">
            <span>Store</span>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">All stores</option>
              {me.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </RangePicker>

      {d && !d.configured && (
        <p className="notice warn">
          <Icon name="alert" />
          <span>
            These journals use the standard account names. Match them to your chart of accounts before the first import.{" "}
            <a className="link" href="#/accounting/settings">
              Set up accounts
            </a>
          </span>
        </p>
      )}
      {d && d.overlapping.length > 0 && (
        <p className="notice warn" role="status">
          <Icon name="alert" />
          <span>
            Some of these days were already exported ({FORMAT_LABEL[d.overlapping[0]!.format]}, {d.overlapping[0]!.from} to {d.overlapping[0]!.to},{" "}
            {dateTime(d.overlapping[0]!.at)}
            {d.overlapping[0]!.by ? ` by ${d.overlapping[0]!.by}` : ""}). Importing them again would count those sales twice.
          </span>
        </p>
      )}

      <section className="panel" aria-labelledby="acc-export">
        <h2 id="acc-export">Export for your accounting tool</h2>
        <div className="acc-tools">
          {TOOLS.map((t) => (
            <button key={t.format} type="button" className="acc-tool" onClick={() => exportAs(t.format)} disabled={!!busy || !d || !!empty}>
              {busy === t.format ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
              <span>
                <strong>{FORMAT_LABEL[t.format]}</strong>
                <span className="muted small">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="muted small">
          Import as drafts and check the first one against your bank and card statements before posting. Day listings for your accountant:{" "}
          {LISTINGS.map((f, i) => (
            <span key={f}>
              {i > 0 && " · "}
              <button type="button" className="linkish" onClick={() => exportAs(f)} disabled={!!busy || !d || !!empty}>
                {FORMAT_LABEL[f]}
              </button>
            </span>
          ))}
        </p>
      </section>

      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !d ? (
        <SkeletonRows />
      ) : empty ? (
        <EmptyState icon="receipt" title="No sales in these dates">
          <p className="muted">Pick other dates, or check that the tills have synced.</p>
        </EmptyState>
      ) : (
        <section aria-labelledby="acc-preview" aria-busy={data.loading}>
          <div className="acc-summary">
            <h2 id="acc-preview">
              {d.journals.length} journal{d.journals.length === 1 ? "" : "s"}
            </h2>
            <span className="muted">
              Debits {aed(d.totals.debit)} · Credits {aed(d.totals.credit)}
            </span>
            {d.totals.debit === d.totals.credit ? (
              <span className="badge good">
                <Icon name="check" size={14} /> Balanced
              </span>
            ) : (
              <span className="badge bad">Not balanced</span>
            )}
            {warnings > 0 && (
              <span className="badge warn">
                {warnings} to check
              </span>
            )}
          </div>
          {d.journals.map((j, i) => (
            <JournalCard key={j.reference} journal={j} open={i === 0 || j.warnings.length > 0} />
          ))}
        </section>
      )}
    </>
  );
}

function JournalCard({ journal: j, open }: { journal: Journal; open: boolean }) {
  return (
    <details className="panel acc-journal" open={open}>
      <summary>
        <span>
          <strong>{dayLabel(j.date)}</strong> · {j.storeName}
          <span className="cell-sub">
            {j.reference} · {j.sales} bill{j.sales === 1 ? "" : "s"}
            {j.refunds ? `, ${j.refunds} refund${j.refunds === 1 ? "" : "s"}` : ""}
          </span>
        </span>
        {j.warnings.length > 0 && <span className="badge warn">Check</span>}
      </summary>
      {j.warnings.map((w) => (
        <p key={w} className="notice warn">
          <Icon name="alert" /> <span>{w}</span>
        </p>
      ))}
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">
            Journal {j.reference}
          </caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="hide-sm">Description</th>
              <th scope="col" className="num">Debit</th>
              <th scope="col" className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {j.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.account.code && <span className="num muted">{l.account.code} </span>}
                  {l.account.name}
                  <span className="cell-sub show-sm">{l.description}</span>
                </td>
                <td className="hide-sm">{l.description}</td>
                <td className="num">{l.amount > 0 ? money(l.amount) : ""}</td>
                <td className="num">{l.amount < 0 ? money(-l.amount) : ""}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="strong">Total</td>
              <td className="hide-sm" />
              <td className="num strong">{money(j.lines.reduce((n, l) => n + Math.max(0, l.amount), 0))}</td>
              <td className="num strong">{money(j.lines.reduce((n, l) => n + Math.max(0, -l.amount), 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  );
}

function VatReturn() {
  const toast = useToast();
  const [range, setRange] = useState(() => quarterPresets()[1]!);
  const [otherAmount, setOtherAmount] = useState("");
  const [otherVat, setOtherVat] = useState("");
  const q = `from=${range.from}&to=${range.to}`;
  const data = useLoad(() => api<Vat201>(`/accounting/vat-return?${q}`), [q]);
  const extraAmount = tryParseMoney(otherAmount) ?? 0;
  const extraVat = tryParseMoney(otherVat) ?? 0;
  const badExtra = (otherAmount.trim() !== "" && tryParseMoney(otherAmount) === null) || (otherVat.trim() !== "" && tryParseMoney(otherVat) === null);

  const save = () => download(`/accounting/vat-return?${q}&format=csv`, `vat-return-${range.from}-to-${range.to}.csv`).catch((err) => toast(errorText(err), "error"));

  const v = data.data;
  const inputs = v ? { amount: v.box9Purchases.amount + extraAmount, vat: v.box9Purchases.vat + extraVat } : null;
  const payable = v && inputs ? v.box12TotalDue - inputs.vat : 0;

  return (
    <>
      <RangePicker presets={quarterPresets()} range={range} onChange={(r) => setRange({ ...r, label: "" })}>
        <button type="button" className="btn" onClick={save} disabled={!v}>
          <Icon name="download" /> Download CSV
        </button>
      </RangePicker>
      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !v || !inputs ? (
        <SkeletonRows rows={8} />
      ) : (
        <div aria-busy={data.loading}>
          {v.unassigned.length > 0 && (
            <p className="notice warn">
              <Icon name="alert" />
              <span>
                {v.unassigned.map((u) => u.storeName).join(", ")} {v.unassigned.length === 1 ? "has" : "have"} no emirate, so{" "}
                {aed(v.unassigned.reduce((n, u) => n + u.amount, 0))} of sales are not in boxes 1a to 1g.{" "}
                <a className="link" href="#/accounting/settings">
                  Set the emirate
                </a>
              </span>
            </p>
          )}
          {v.noVatType !== 0 && (
            <p className="notice warn">
              <Icon name="alert" />
              <span>
                {aed(v.noVatType)} of sales were for products with no VAT type, and are not on this return. Give those products a VAT type.
              </span>
            </p>
          )}

          <div className="kpis acc-kpis">
            <div className="kpi">
              <span className="kpi-label">VAT on sales</span>
              <span className="kpi-value num">{aed(v.box12TotalDue)}</span>
              <span className="kpi-note">Box 12</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">VAT you can recover</span>
              <span className="kpi-value num">{aed(inputs.vat)}</span>
              <span className="kpi-note">Box 13</span>
            </div>
            <div className={payable >= 0 ? "kpi hero" : "kpi"}>
              <span className="kpi-label">{payable >= 0 ? "VAT to pay" : "VAT to reclaim"}</span>
              <span className="kpi-value num">{aed(Math.abs(payable))}</span>
              <span className="kpi-note">Box 14</span>
            </div>
          </div>

          <section className="panel" aria-labelledby="vat-out">
            <h2 id="vat-out">VAT on sales and all other outputs</h2>
            <BoxTable
              rows={[
                ...v.emirates.map((e) => ({ box: e.box, label: `Standard rated supplies in ${e.name}`, amount: e.amount, vat: e.vat })),
                ...v.unassigned.map((u) => ({ box: "?", label: `${u.storeName}, emirate not set`, amount: u.amount, vat: u.vat, warn: true })),
                { box: "2", label: "Tax refunds provided to tourists", amount: 0, vat: 0, muted: true },
                { box: "3", label: "Supplies subject to the reverse charge", amount: 0, vat: 0, muted: true },
                { box: "4", label: "Zero rated supplies", amount: v.box4ZeroRated },
                { box: "5", label: "Exempt supplies", amount: v.box5Exempt },
                { box: "6", label: "Goods imported into the UAE", amount: 0, vat: 0, muted: true },
                { box: "7", label: "Adjustments to goods imported", amount: 0, vat: 0, muted: true },
                { box: "8", label: "Totals", amount: v.box8Total.amount, vat: v.box8Total.vat, total: true },
              ]}
            />
            <p className="muted small">
              Amounts are before VAT and after discounts. Refunds in these dates are credit notes and are already taken off (
              {aed(v.creditNotes.amount)}, VAT {aed(v.creditNotes.vat)}). The POS does not record tourist refunds, reverse charge or imports;
              add those from your own records.
            </p>
          </section>

          <section className="panel" aria-labelledby="vat-in">
            <h2 id="vat-in">VAT on expenses and all other inputs</h2>
            <BoxTable
              rows={[
                {
                  box: "9",
                  label: `Stock received in the POS (${v.box9Purchases.receipts} receipt${v.box9Purchases.receipts === 1 ? "" : "s"})`,
                  amount: v.box9Purchases.amount,
                  vat: v.box9Purchases.vat,
                },
                ...(extraAmount || extraVat ? [{ box: "9", label: "Other expenses you entered", amount: extraAmount, vat: extraVat }] : []),
                { box: "10", label: "Supplies subject to the reverse charge", amount: 0, vat: 0, muted: true },
                { box: "11", label: "Totals", amount: inputs.amount, vat: inputs.vat, total: true },
              ]}
            />
            <div className="form-grid acc-extra">
              <label className="field">
                <span>Other expenses before VAT (AED)</span>
                <input inputMode="decimal" value={otherAmount} onChange={(e) => setOtherAmount(e.target.value)} placeholder="0.00" />
              </label>
              <label className="field">
                <span>VAT on them (AED)</span>
                <input inputMode="decimal" value={otherVat} onChange={(e) => setOtherVat(e.target.value)} placeholder="0.00" />
              </label>
            </div>
            {badExtra && (
              <p className="field-error" role="alert">
                Enter amounts like 1250.00
              </p>
            )}
            <p className="muted small">
              Stock VAT uses the cost and VAT rate on each purchase order (5% when goods came without one). Claim only VAT you hold a valid tax
              invoice for. Rent, utilities and other bills are not in the POS; add their totals above to see the full return.
            </p>
          </section>

          <section className="panel" aria-labelledby="vat-net">
            <h2 id="vat-net">Net VAT due</h2>
            <BoxTable
              rows={[
                { box: "12", label: "Total value of due tax for the period", vat: v.box12TotalDue },
                { box: "13", label: "Total value of recoverable tax for the period", vat: inputs.vat },
                { box: "14", label: "Payable tax for the period", vat: payable, total: true },
              ]}
            />
          </section>
        </div>
      )}
    </>
  );
}

function BoxTable({
  rows,
}: {
  rows: { box: string; label: string; amount?: number; vat?: number; total?: boolean; muted?: boolean; warn?: boolean }[];
}) {
  return (
    <div className="table-wrap">
      <table className="table acc-boxes">
        <thead>
          <tr>
            <th scope="col">Box</th>
            <th scope="col">Description</th>
            <th scope="col" className="num">
              Amount (AED)
            </th>
            <th scope="col" className="num">
              VAT (AED)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={[r.total ? "total" : "", r.muted ? "muted" : "", r.warn ? "warn" : ""].join(" ")}>
              <td className="num">{r.box}</td>
              <td>{r.label}</td>
              <td className="num">{r.amount === undefined ? "" : money(r.amount)}</td>
              <td className="num">{r.vat === undefined ? "" : money(r.vat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsForm({ owner }: { owner: boolean }) {
  const { data, error, reload } = useLoad(() => api<AccountingSettings>("/accounting/settings"), []);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <SkeletonRows rows={8} />;
  return <SettingsFields data={data} owner={owner} onSaved={reload} />;
}

const KIND_DEFAULT: Record<string, "cash" | "card" | "otherPayments"> = { cash: "cash", card: "card", card_manual: "card" };

function SettingsFields({ data, owner, onSaved }: { data: AccountingSettings; owner: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<AccountingConfig>(data.config);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  const setAccount = (key: keyof AccountingConfig["accounts"], patch: Partial<Account>) =>
    setForm((f) => ({ ...f, accounts: { ...f.accounts, [key]: { ...f.accounts[key], ...patch } } }));
  const setMethod = (id: string, patch: Partial<Account>) =>
    setForm((f) => ({ ...f, methodAccounts: { ...f.methodAccounts, [id]: { code: "", name: "", ...f.methodAccounts[id], ...patch } } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const empty = ACCOUNT_FIELDS.filter((a) => !form.accounts[a.key].name.trim()).map((a) => a.key);
    setMissing(empty);
    if (empty.length) {
      document.getElementById(`acc-${empty[0]}-name`)?.focus();
      return;
    }
    // A method with no name of its own uses the default account for its kind.
    const methodAccounts = Object.fromEntries(
      Object.entries(form.methodAccounts)
        .filter(([, a]) => a.name.trim())
        .map(([id, a]) => [id, { code: a.code.trim(), name: a.name.trim() }]),
    );
    setBusy(true);
    setFormError(null);
    try {
      await api("/accounting/settings", { method: "PUT", body: { ...form, methodAccounts } });
      toast("Accounts saved");
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const group = (g: "sales" | "money") =>
    ACCOUNT_FIELDS.filter((a) => a.group === g).map((a) => (
      <div className="acc-row" key={a.key}>
        <span className="acc-row-label" id={`acc-${a.key}-label`}>
          {a.label}
        </span>
        <input
          aria-label={`${a.label}: code`}
          className="acc-code"
          value={form.accounts[a.key].code}
          onChange={(e) => setAccount(a.key, { code: e.target.value })}
          maxLength={40}
          placeholder="Code"
        />
        <input
          id={`acc-${a.key}-name`}
          aria-label={`${a.label}: account name`}
          aria-invalid={missing.includes(a.key) || undefined}
          value={form.accounts[a.key].name}
          onChange={(e) => setAccount(a.key, { name: e.target.value })}
          maxLength={150}
          placeholder="Account name"
        />
      </div>
    ));

  return (
    <form className="panel" onSubmit={submit} noValidate>
      {!owner && <p className="muted">Only the owner can change the accounts.</p>}
      {!data.saved && (
        <p className="notice">
          <Icon name="alert" />
          <span>These are standard names. Change them to match the accounts in your Xero, QuickBooks or Zoho Books before the first import.</span>
        </p>
      )}
      <fieldset disabled={!owner} className="plain-fieldset">
        <p className="muted small">
          Xero matches accounts by code; QuickBooks and Zoho Books match by name, so type them exactly as they appear in your chart of accounts.
        </p>
        <h3>Sales and VAT</h3>
        {group("sales")}
        <h3>Money taken</h3>
        {group("money")}
        {missing.length > 0 && (
          <p className="field-error" role="alert">
            Every account needs a name.
          </p>
        )}

        <h3>Payment methods</h3>
        <p className="muted small">Give a method its own account, for example one clearing account per card acquirer. Leave empty to use the account above.</p>
        {data.methods.map((m) => {
          const fallback = form.accounts[KIND_DEFAULT[m.kind] ?? "otherPayments"];
          const own = form.methodAccounts[m.id];
          return (
            <div className="acc-row" key={m.id}>
              <span className="acc-row-label">
                {m.name}
                {!m.active && <span className="muted small"> (not in use)</span>}
              </span>
              <input
                aria-label={`${m.name}: code`}
                className="acc-code"
                value={own?.code ?? ""}
                onChange={(e) => setMethod(m.id, { code: e.target.value })}
                maxLength={40}
                placeholder={fallback.code || "Code"}
              />
              <input
                aria-label={`${m.name}: account name`}
                value={own?.name ?? ""}
                onChange={(e) => setMethod(m.id, { name: e.target.value })}
                maxLength={150}
                placeholder={fallback.name}
              />
            </div>
          );
        })}

        <h3>Stores</h3>
        <p className="muted small">
          The VAT return splits standard rated sales by emirate (boxes 1a to 1g).
          {data.einvoicingEmirate ? ` Stores left on "Same as business" use ${EMIRATES.find((e) => e.value === data.einvoicingEmirate)?.label}.` : ""}
        </p>
        {data.stores.map((s) => (
          <div className="acc-row two" key={s.id}>
            <label className="acc-row-label" htmlFor={`acc-emirate-${s.id}`}>
              {s.name}
            </label>
            <select
              id={`acc-emirate-${s.id}`}
              value={form.storeEmirates[s.id] ?? ""}
              onChange={(e) => {
                const value = e.target.value as Emirate | "";
                setForm((f) => {
                  const next = { ...f.storeEmirates };
                  if (value) next[s.id] = value;
                  else delete next[s.id];
                  return { ...f, storeEmirates: next };
                });
              }}
            >
              <option value="">{data.einvoicingEmirate ? "Same as business" : "Choose…"}</option>
              {EMIRATES.map((em) => (
                <option key={em.value} value={em.value}>
                  {em.label}
                </option>
              ))}
            </select>
          </div>
        ))}

        <h3>Import files</h3>
        <div className="acc-row two">
          <label className="acc-row-label" htmlFor="acc-date">
            Date format
          </label>
          <select id="acc-date" value={form.dateFormat} onChange={(e) => setForm({ ...form, dateFormat: e.target.value as AccountingConfig["dateFormat"] })}>
            <option value="dd/mm/yyyy">31/12/2026 (UAE)</option>
            <option value="mm/dd/yyyy">12/31/2026 (US)</option>
            <option value="yyyy-mm-dd">2026-12-31</option>
          </select>
        </div>
        <p className="muted small">Xero tax rate names, exactly as in Xero under Settings, Tax rates. Xero works out the VAT from these.</p>
        {(
          [
            ["standard", "Standard rated sales"],
            ["zero", "Zero rated sales"],
            ["exempt", "Exempt sales"],
            ["none", "Lines with no VAT (payments, cash)"],
          ] as const
        ).map(([k, label]) => (
          <div className="acc-row two" key={k}>
            <label className="acc-row-label" htmlFor={`acc-xero-${k}`}>
              {label}
            </label>
            <input
              id={`acc-xero-${k}`}
              value={form.xeroTaxRates[k]}
              onChange={(e) => setForm({ ...form, xeroTaxRates: { ...form.xeroTaxRates, [k]: e.target.value } })}
              maxLength={60}
            />
          </div>
        ))}

        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        {owner && (
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => setForm(data.defaults)} disabled={busy}>
              Use standard names
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
