import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { errorText, platformApi, setToken } from "../lib/api.js";
import { aed, ago, dateTime, money, tryParseMoney } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";
import type { PlatformMe } from "./PlatformApp.js";

type Status = "trial" | "active" | "past_due" | "suspended" | "cancelled";

export const STATUS: Record<Status, { label: string; tone: string }> = {
  trial: { label: "Trial", tone: "warn" },
  active: { label: "Active", tone: "good" },
  past_due: { label: "Overdue", tone: "warn" },
  suspended: { label: "Paused", tone: "" },
  cancelled: { label: "Closed", tone: "" },
};
const StatusBadge = ({ status }: { status: Status }) => <span className={`badge ${STATUS[status].tone}`}>{STATUS[status].label}</span>;

const BUSINESS_TYPE: Record<string, string> = {
  grocery: "Grocery",
  fashion: "Fashion",
  electronics: "Electronics",
  cosmetics: "Cosmetics",
  pharmacy: "Pharmacy",
  other: "Other retail",
};

interface Plan {
  id: string;
  name: string;
  priceMonthly: number;
  maxStores: number | null;
  maxRegisters: number | null;
  active: boolean;
  tenants: number;
}

// Overview

interface OverviewData {
  tenants: { byStatus: Partial<Record<Status, number>>; signups7d: number; signups30d: number; trialsEnding: number };
  mrr: number;
  devices: { online: number; total: number };
  orders24h: number;
  sales24h: number;
  checks: { id: string; label: string; ok: boolean; detail: string }[];
  server: { uptimeSeconds: number; node: string; migrations: string[] };
}

export function Overview() {
  const data = useLoad(() => platformApi<OverviewData>("/overview"), []);
  useEffect(() => {
    const t = setInterval(() => void data.reload(), 60_000);
    return () => clearInterval(t);
  }, [data.reload]);
  const d = data.data;
  const paying = d ? (d.tenants.byStatus.active ?? 0) + (d.tenants.byStatus.past_due ?? 0) : 0;
  const problems = d?.checks.filter((c) => !c.ok).length ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">Every business on the platform. Refreshes every minute.</p>
        </div>
      </header>
      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !d ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <section className="kpis" aria-label="Totals">
            <Kpi label="Monthly revenue" value={aed(d.mrr)} note={`${paying} paying`} hero />
            <Kpi label="On trial" value={String(d.tenants.byStatus.trial ?? 0)} note={`${d.tenants.trialsEnding} ending in 3 days`} />
            <Kpi label="New sign-ups" value={String(d.tenants.signups7d)} note={`${d.tenants.signups30d} in 30 days`} />
            <Kpi label="Tills online" value={String(d.devices.online)} note={`of ${d.devices.total} paired`} />
            <Kpi label="Sales, last 24 h" value={aed(d.sales24h)} note={`${d.orders24h} bills`} />
          </section>

          <section className="panel" aria-labelledby="h-health" style={{ marginTop: "var(--space-4)" }}>
            <div className="panel-head">
              <h2 id="h-health">System health</h2>
              <span className={problems ? "badge warn" : "badge good"}>{problems ? `${problems} to look at` : "All good"}</span>
            </div>
            <ul className="checks">
              {d.checks.map((c) => (
                <li key={c.id} className={c.ok ? "ok" : "bad"}>
                  <Icon name={c.ok ? "check" : "alert"} />
                  <span>{c.label}</span>
                  <strong className="num">{c.detail}</strong>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Server up {Math.floor(d.server.uptimeSeconds / 3600)} h {Math.floor((d.server.uptimeSeconds % 3600) / 60)} min · Node{" "}
              {d.server.node} · {d.server.migrations.length} migrations, latest {d.server.migrations.at(-1)}
            </p>
          </section>

          <section className="panel" aria-labelledby="h-status">
            <h2 id="h-status">Businesses by status</h2>
            <dl className="facts">
              {(Object.keys(STATUS) as Status[]).map((s) => (
                <div key={s}>
                  <dt>{STATUS[s].label}</dt>
                  <dd>
                    <a href="#/platform/businesses" onClick={() => sessionStorage.setItem("pf.status", s)}>
                      {d.tenants.byStatus[s] ?? 0}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note, hero }: { label: string; value: string; note?: string; hero?: boolean }) {
  return (
    <div className={hero ? "kpi hero" : "kpi"}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value num">{value}</span>
      {note && <span className="kpi-note muted">{note}</span>}
    </div>
  );
}

// Businesses

interface TenantRow {
  id: string;
  name: string;
  status: Status;
  planId: string;
  planName: string;
  trialEndsAt: string | null;
  businessType: string | null;
  createdAt: string;
  contactEmail: string | null;
  stores: number;
  registers: number;
  lastSaleAt: string | null;
  sales30d: number;
}

export function Tenants() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status | "">(() => {
    const s = sessionStorage.getItem("pf.status") as Status | null;
    sessionStorage.removeItem("pf.status");
    return s ?? "";
  });
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => {
    const p = new URLSearchParams({ limit: "50", offset: String(offset) });
    if (search) p.set("q", search);
    if (status) p.set("status", status);
    return platformApi<{ tenants: TenantRow[]; count: number }>(`/tenants?${p}`);
  }, [search, status, offset]);
  const data = list.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Businesses</h1>
          <p className="muted">Open a business to change its plan, extend a trial, pause it or sign in to help.</p>
        </div>
      </header>
      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search businesses" placeholder="Business name or owner email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as Status | "");
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </select>
      </div>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : data.count === 0 ? (
        <EmptyState icon="box" title={search || status ? "No businesses match" : "No businesses yet"} />
      ) : (
        <div className="table-wrap" aria-busy={list.loading}>
          <table className="table">
            <caption className="sr-only">Businesses, {data.count} in all</caption>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Status</th>
                <th scope="col" className="hide-sm">Plan</th>
                <th scope="col" className="num hide-sm">Stores · tills</th>
                <th scope="col" className="hide-xs">Last sale</th>
                <th scope="col" className="num">Sales 30 days</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((t) => (
                <tr key={t.id}>
                  <td>
                    <a className="row-link cell-main" href={`#/platform/businesses/${t.id}`}>
                      {t.name}
                    </a>
                    <span className="cell-sub">
                      {[t.businessType && BUSINESS_TYPE[t.businessType], t.contactEmail].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={t.status} />
                    {t.status === "trial" && t.trialEndsAt && <span className="cell-sub">ends {daysLeft(t.trialEndsAt)}</span>}
                  </td>
                  <td className="hide-sm">{t.planName}</td>
                  <td className="num hide-sm">
                    {t.stores} · {t.registers}
                  </td>
                  <td className="hide-xs">{t.lastSaleAt ? ago(t.lastSaleAt) : <span className="muted">No sales</span>}</td>
                  <td className="num strong">{money(t.sales30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.count > 50 && (
            <div className="pager">
              <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                Previous
              </button>
              <span className="muted small">
                {offset + 1}–{Math.min(offset + 50, data.count)} of {data.count}
              </span>
              <button type="button" className="btn sm" disabled={offset + 50 >= data.count} onClick={() => setOffset(offset + 50)}>
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function daysLeft(iso: string) {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  return days > 1 ? `in ${days} days` : days === 1 ? "tomorrow" : days === 0 ? "today" : `${-days} days ago`;
}

interface TenantDetailData {
  tenant: {
    id: string;
    name: string;
    status: Status;
    planId: string;
    trialEndsAt: string | null;
    businessType: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
    createdAt: string;
    statusChangedAt: string | null;
  };
  stores: { id: string; code: string; name: string; trn: string | null; registers: number; devices: number; devicesOnline: number }[];
  users: { id: string; name: string; email: string | null; role: string; active: boolean; lastLoginAt: string | null }[];
  activity: { orders30d: number; sales30d: number; lastSaleAt: string | null; products: number };
  audit: { id: number; action: string; data: Record<string, unknown>; at: string; by: string | null }[];
  supportSessions: { id: string; createdAt: string; endsAt: string; reason: string; by: string }[];
}

export function TenantDetail({ id, me }: { id: string; me: PlatformMe }) {
  const detail = useLoad(() => platformApi<TenantDetailData>(`/tenants/${id}`), [id]);
  const plans = useLoad(() => platformApi<{ plans: Plan[] }>("/plans"), []);
  const [dialog, setDialog] = useState<"account" | "support" | null>(null);
  const d = detail.data;
  const admin = me.user.role === "admin";

  return (
    <div className="page">
      <p className="back-link">
        <a href="#/platform/businesses">
          <Icon name="refund" size={16} /> Businesses
        </a>
      </p>
      {detail.error ? (
        <ErrorState message={detail.error} onRetry={detail.reload} />
      ) : !d ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>
                {d.tenant.name} <StatusBadge status={d.tenant.status} />
              </h1>
              <p className="muted">
                {[d.tenant.businessType && BUSINESS_TYPE[d.tenant.businessType], `joined ${dateTime(d.tenant.createdAt)}`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="head-actions">
              <button type="button" className="btn" onClick={() => setDialog("account")}>
                <Icon name="edit" /> {admin ? "Plan and status" : "Trial and notes"}
              </button>
              <button type="button" className="btn primary" onClick={() => setDialog("support")} disabled={d.tenant.status === "cancelled"}>
                <Icon name="key" /> Sign in to help
              </button>
            </div>
          </header>

          <section className="panel">
            <h2>Account</h2>
            <dl className="facts">
              <div>
                <dt>Plan</dt>
                <dd>{plans.data?.plans.find((p) => p.id === d.tenant.planId)?.name ?? d.tenant.planId}</dd>
              </div>
              {d.tenant.status === "trial" && d.tenant.trialEndsAt && (
                <div>
                  <dt>Trial ends</dt>
                  <dd>
                    {dateTime(d.tenant.trialEndsAt)} ({daysLeft(d.tenant.trialEndsAt)})
                  </dd>
                </div>
              )}
              <div>
                <dt>Contact</dt>
                <dd>{[d.tenant.contactEmail, d.tenant.contactPhone].filter(Boolean).join(" · ") || "—"}</dd>
              </div>
              <div>
                <dt>Sales, 30 days</dt>
                <dd>
                  {aed(d.activity.sales30d)} · {d.activity.orders30d} bills
                </dd>
              </div>
              <div>
                <dt>Last sale</dt>
                <dd>{ago(d.activity.lastSaleAt)}</dd>
              </div>
              <div>
                <dt>Products</dt>
                <dd>{d.activity.products}</dd>
              </div>
            </dl>
            {d.tenant.notes && (
              <p className="notes">
                <strong>Notes:</strong> {d.tenant.notes}
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Stores and tills</h2>
            <div className="table-wrap flat">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Store</th>
                    <th scope="col" className="hide-xs">TRN</th>
                    <th scope="col" className="num">Registers</th>
                    <th scope="col" className="num">Devices online</th>
                  </tr>
                </thead>
                <tbody>
                  {d.stores.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className="cell-main">{s.name}</span>
                        <span className="cell-sub">{s.code}</span>
                      </td>
                      <td className="hide-xs tnum">{s.trn ?? <span className="muted">—</span>}</td>
                      <td className="num">{s.registers}</td>
                      <td className="num">
                        {s.devicesOnline} of {s.devices}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>Owners and managers</h2>
            <ul className="plain-list">
              {d.users.map((u) => (
                <li key={u.id} className={u.active ? undefined : "dim"}>
                  <span>
                    <strong>{u.name}</strong> <span className="muted">{u.role === "owner" ? "Owner" : "Manager"}</span>
                    <span className="cell-sub">{u.email ?? "No email"}</span>
                  </span>
                  <span className="muted small">Last sign-in {ago(u.lastLoginAt)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2>History</h2>
            {d.audit.length === 0 && d.supportSessions.length === 0 ? (
              <p className="muted">Nothing yet.</p>
            ) : (
              <ul className="timeline">
                {d.audit.map((a) => (
                  <li key={a.id}>
                    <span className="muted small">{dateTime(a.at)}</span>
                    <span>
                      {describe(a.action, a.data)}
                      {a.by && <span className="muted"> · {a.by}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {dialog === "account" && plans.data && (
            <AccountDialog
              tenant={d.tenant}
              plans={plans.data.plans}
              admin={admin}
              onClose={() => setDialog(null)}
              onSaved={() => {
                setDialog(null);
                void detail.reload();
              }}
            />
          )}
          {dialog === "support" && <SupportDialog tenant={d.tenant} onClose={() => setDialog(null)} onDone={() => void detail.reload()} />}
        </>
      )}
    </div>
  );
}

function describe(action: string, data: Record<string, unknown>): string {
  switch (action) {
    case "tenant.signup":
      return `Signed up (${String(data.email ?? "")})`;
    case "support.sign_in":
      return `Support sign-in: ${String(data.reason ?? "")}`;
    case "tenant.update": {
      const parts: string[] = [];
      const st = data.status as { from: Status; to: Status } | undefined;
      const pl = data.plan as { from: string; to: string } | undefined;
      if (st) parts.push(`status ${STATUS[st.from]?.label ?? st.from} → ${STATUS[st.to]?.label ?? st.to}`);
      if (pl) parts.push(`plan ${pl.from} → ${pl.to}`);
      if (data.trialEndsAt) parts.push(`trial until ${dateTime(String(data.trialEndsAt))}`);
      if (data.notes) parts.push("notes edited");
      return `Changed ${parts.join(", ")}`;
    }
    default:
      return action;
  }
}

function AccountDialog({
  tenant,
  plans,
  admin,
  onClose,
  onSaved,
}: {
  tenant: TenantDetailData["tenant"];
  plans: Plan[];
  admin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [planId, setPlanId] = useState(tenant.planId);
  const [status, setStatus] = useState<Status>(tenant.status);
  const [trialEnds, setTrialEnds] = useState(tenant.trialEndsAt ? tenant.trialEndsAt.slice(0, 10) : "");
  const [notes, setNotes] = useState(tenant.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pausing = (status === "suspended" || status === "cancelled") && status !== tenant.status;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { notes: notes.trim() || null };
    if (trialEnds && trialEnds !== tenant.trialEndsAt?.slice(0, 10)) body.trialEndsAt = new Date(`${trialEnds}T23:59:59+04:00`).toISOString();
    if (admin) {
      if (planId !== tenant.planId) body.planId = planId;
      if (status !== tenant.status) body.status = status;
    }
    try {
      await platformApi(`/tenants/${tenant.id}`, { method: "PUT", body });
      toast(`${tenant.name} saved`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={`Account of ${tenant.name}`}>
      <h2>{tenant.name}</h2>
      <form onSubmit={submit} noValidate>
        {admin && (
          <div className="form-grid">
            <Field label="Plan">
              {(p) => (
                <select {...p} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  {plans.map((pl) => (
                    <option key={pl.id} value={pl.id} disabled={!pl.active && pl.id !== tenant.planId}>
                      {pl.name} · {aed(pl.priceMonthly)}/month
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Status">
              {(p) => (
                <select {...p} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
                  {(Object.keys(STATUS) as Status[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS[s].label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
        {pausing && (
          <p className="form-warn" role="status">
            <Icon name="alert" /> The owner and managers are signed out and cannot sign in. Tills already paired keep selling and syncing, so
            no sale is lost; new devices cannot be paired.
          </p>
        )}
        <Field label="Trial ends" hint="Extend a trial by moving this date.">
          {(p) => <input {...p} type="date" value={trialEnds} onChange={(e) => setTrialEnds(e.target.value)} />}
        </Field>
        <Field label="Notes" hint="Only platform staff see these.">
          {(p) => <textarea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />}
        </Field>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={pausing ? "btn danger" : "btn primary"} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : pausing ? `${STATUS[status].label === "Paused" ? "Pause" : "Close"} account` : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SupportDialog({ tenant, onClose, onDone }: { tenant: TenantDetailData["tenant"]; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 5) return setError("Say why, in a few words. The business sees this in its audit log.");
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi<{ token: string; minutes: number }>(`/tenants/${tenant.id}/support-session`, { body: { reason: reason.trim() } });
      // The back office in this browser now runs as this business, in a new tab.
      setToken(res.token);
      window.open(`${window.location.pathname}#/dashboard`, "_blank", "noopener");
      onDone();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Sign in to help">
      <h2>Sign in to {tenant.name}</h2>
      <p className="muted">
        Opens their back office as the owner for 60 minutes in a new tab. Everything you change is marked as support in their audit log,
        with the reason below.
      </p>
      <form onSubmit={submit} noValidate>
        <Field label="Reason" required error={error}>
          {(p) => <input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Owner asked for help with the VAT report" autoFocus maxLength={300} />}
        </Field>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Open their back office
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Plans

export function Plans({ me }: { me: PlatformMe }) {
  const plans = useLoad(() => platformApi<{ plans: Plan[] }>("/plans"), []);
  const [editing, setEditing] = useState<Plan | null>(null);
  const admin = me.user.role === "admin";
  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Plans</h1>
          <p className="muted">Prices are per business per month, before VAT. A limit applies when a business adds a store or register.</p>
        </div>
      </header>
      {plans.error ? (
        <ErrorState message={plans.error} onRetry={plans.reload} />
      ) : !plans.data ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Plans</caption>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col" className="num">Price (AED)</th>
                <th scope="col" className="num hide-xs">Stores</th>
                <th scope="col" className="num hide-xs">Registers</th>
                <th scope="col" className="num">Businesses</th>
                {admin && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {plans.data.plans.map((p) => (
                <tr key={p.id} className={p.active ? undefined : "dim"}>
                  <td>
                    <span className="cell-main">{p.name}</span>
                    {!p.active && <span className="badge">Not offered</span>}
                  </td>
                  <td className="num">{money(p.priceMonthly)}</td>
                  <td className="num hide-xs">{p.maxStores ?? "No limit"}</td>
                  <td className="num hide-xs">{p.maxRegisters ?? "No limit"}</td>
                  <td className="num">{p.tenants}</td>
                  {admin && (
                    <td className="actions">
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                        <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <PlanDialog
          plan={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void plans.reload();
          }}
        />
      )}
    </div>
  );
}

function PlanDialog({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: plan.name,
    price: money(plan.priceMonthly),
    maxStores: plan.maxStores?.toString() ?? "",
    maxRegisters: plan.maxRegisters?.toString() ?? "",
    active: plan.active,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const limit = (v: string) => (v.trim() === "" ? null : /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : NaN);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const price = tryParseMoney(form.price);
    const stores = limit(form.maxStores);
    const registers = limit(form.maxRegisters);
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Enter a name.";
    if (price === null || price < 0) errs.price = "Enter a price, e.g. 149.00.";
    if (Number.isNaN(stores)) errs.maxStores = "A whole number, or empty for no limit.";
    if (Number.isNaN(registers)) errs.maxRegisters = "A whole number, or empty for no limit.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError(null);
    try {
      await platformApi(`/plans/${plan.id}`, {
        method: "PUT",
        body: { name: form.name.trim(), priceMonthly: price, maxStores: stores, maxRegisters: registers, active: form.active },
      });
      toast(`${form.name} saved`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={`Edit ${plan.name}`}>
      <h2>Edit plan</h2>
      <p className="muted">Changes apply to every business on this plan right away. Limits never remove stores or registers a business already has.</p>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Name" required error={errors.name}>
            {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={60} />}
          </Field>
          <Field label="Price per month (AED)" required error={errors.price}>
            {(p) => <input {...p} inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} />}
          </Field>
          <Field label="Stores" error={errors.maxStores} hint="Empty for no limit.">
            {(p) => <input {...p} inputMode="numeric" value={form.maxStores} onChange={(e) => set("maxStores", e.target.value)} />}
          </Field>
          <Field label="Registers" error={errors.maxRegisters} hint="Empty for no limit.">
            {(p) => <input {...p} inputMode="numeric" value={form.maxRegisters} onChange={(e) => set("maxRegisters", e.target.value)} />}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          <span>
            Offered
            <span className="hint">Untick to stop offering it. Businesses already on it keep it.</span>
          </span>
        </label>
        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Team

interface PlatformUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "support";
  active: boolean;
  lastLoginAt: string | null;
}

export function Team({ me }: { me: PlatformMe }) {
  const users = useLoad(() => platformApi<{ users: PlatformUser[] }>("/users"), []);
  const [editing, setEditing] = useState<PlatformUser | "new" | null>(null);
  const admin = me.user.role === "admin";
  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted">Platform staff. Admins can change plans, account status and the team; support can look after businesses.</p>
        </div>
        {admin && (
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> Add person
          </button>
        )}
      </header>
      {users.error ? (
        <ErrorState message={users.error} onRetry={users.reload} />
      ) : !users.data ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Platform staff</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col" className="hide-xs">Last sign-in</th>
                {admin && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id} className={u.active ? undefined : "dim"}>
                  <td>
                    <span className="cell-main">
                      {u.name}
                      {u.id === me.user.id && <span className="muted"> (you)</span>}
                    </span>
                    <span className="cell-sub">{u.email}</span>
                  </td>
                  <td>
                    {u.role === "admin" ? "Admin" : "Support"}
                    {!u.active && <span className="badge">Off</span>}
                  </td>
                  <td className="hide-xs">{ago(u.lastLoginAt)}</td>
                  {admin && (
                    <td className="actions">
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
                        <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <UserDialog
          user={editing === "new" ? null : editing}
          self={editing !== "new" && editing.id === me.user.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void users.reload();
          }}
        />
      )}
    </div>
  );
}

function UserDialog({ user, self, onClose, onSaved }: { user: PlatformUser | null; self: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: user?.name ?? "", email: user?.email ?? "", role: user?.role ?? "support", password: "", active: user?.active ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!user && !form.name.trim()) errs.name = "Enter their name.";
    if (!user && !/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = "Enter their work email.";
    if ((!user || form.password) && form.password.length < 10) errs.password = "Use at least 10 characters.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError(null);
    try {
      if (user) {
        await platformApi(`/users/${user.id}`, {
          method: "PUT",
          body: { role: form.role, active: form.active, ...(form.password ? { password: form.password } : {}) },
        });
      } else {
        await platformApi("/users", { body: { name: form.name.trim(), email: form.email.trim(), role: form.role, password: form.password } });
      }
      toast(`${form.name} saved`);
      onSaved();
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={user ? `Edit ${user.name}` : "Add person"}>
      <h2>{user ? user.name : "Add person"}</h2>
      <form onSubmit={submit} noValidate>
        {!user && (
          <>
            <Field label="Name" required error={errors.name}>
              {(p) => <input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={80} />}
            </Field>
            <Field label="Email" required error={errors.email}>
              {(p) => <input {...p} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />}
            </Field>
          </>
        )}
        <Field label="Role" hint={self ? "You cannot remove your own admin access." : undefined}>
          {(p) => (
            <select {...p} value={form.role} disabled={self} onChange={(e) => set("role", e.target.value as "admin" | "support")}>
              <option value="support">Support</option>
              <option value="admin">Admin</option>
            </select>
          )}
        </Field>
        <Field
          label={user ? "New password" : "Password"}
          required={!user}
          error={errors.password}
          hint={user ? "Leave empty to keep it. Setting one signs them out everywhere." : "At least 10 characters. Share it privately."}
        >
          {(p) => <input {...p} type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password", e.target.value)} />}
        </Field>
        {user && !self && (
          <label className="check">
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
            <span>
              Can sign in
              <span className="hint">Untick when someone leaves; they are signed out at once.</span>
            </span>
          </label>
        )}
        {formError && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {formError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Activity

export function Activity() {
  const audit = useLoad(
    () =>
      platformApi<{ audit: { id: number; action: string; data: Record<string, unknown>; at: string; by: string | null; tenantId: string | null; tenantName: string | null }[] }>(
        "/audit?limit=100",
      ),
    [],
  );
  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Sign-ups and everything platform staff changed, newest first.</p>
        </div>
      </header>
      {audit.error ? (
        <ErrorState message={audit.error} onRetry={audit.reload} />
      ) : !audit.data ? (
        <SkeletonRows />
      ) : audit.data.audit.length === 0 ? (
        <EmptyState icon="history" title="Nothing yet" />
      ) : (
        <section className="panel">
          <ul className="timeline">
            {audit.data.audit.map((a) => (
              <li key={a.id}>
                <span className="muted small">{dateTime(a.at)}</span>
                <span>
                  {a.tenantId ? <a href={`#/platform/businesses/${a.tenantId}`}>{a.tenantName}</a> : "Platform"}: {describeAny(a.action, a.data)}
                  {a.by && <span className="muted"> · {a.by}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function describeAny(action: string, data: Record<string, unknown>) {
  if (action === "plan.update") return `plan ${String(data.plan)} edited`;
  if (action === "platform_user.create") return `${String(data.email)} added as ${String(data.role)}`;
  if (action === "platform_user.update") return "team member updated";
  return describe(action, data);
}
