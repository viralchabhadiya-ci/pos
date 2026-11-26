import { useMemo, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, download, errorText } from "../lib/api.js";
import { aed, ago, bp, dateTime, time } from "../lib/format.js";
import type { Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface Channel {
  id: string;
  storeId: string;
  storeName: string | null;
  provider: string;
  name: string;
  externalStoreId: string;
  callbackUrl: string | null;
  active: boolean;
  autoAccept: boolean;
  prepMinutes: number;
  commissionBp: number;
  markupBp: number;
  pausedUntil: string | null;
  menuSyncedAt: string | null;
  lastOrderAt: string | null;
  webhookUrl: string;
  secret: string;
}
interface Overview {
  channels: Channel[];
  soldOut: { storeId: string; variantId: string; name: string; until: string | null }[];
  events: { id: string; channelName: string; direction: "in" | "out"; kind: string; outcome: string; detail: string | null; createdAt: string }[];
  menuItems: { variantId: string; name: string }[];
  providers: { id: string; name: string }[];
  publicUrl: boolean;
}
interface ReportRow {
  id: string;
  name: string;
  storeName: string;
  orders: number;
  delivered: number;
  cancelled: number;
  sales: number;
  commission: number;
  payout: number;
  acceptSeconds: number | null;
}

const KIND: Record<string, string> = {
  "order.created": "New order",
  "order.cancelled": "Cancelled by platform",
  "order.rider": "Rider",
  "order.accepted": "Accepted",
  "order.rejected": "Turned down",
  "order.ready": "Ready for rider",
  "menu.updated": "Menu sent",
  "items.availability": "Sold out / back on",
  "store.status": "Busy / open",
  signature: "Signature",
};
const OUTCOME: Record<string, string> = { sent: "Sent", simulated: "Not sent (no address yet)", failed: "Failed", received: "Received", refused: "Refused" };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

/** Delivery platforms: which ones each store is on, the menu sent to them, sold-out items, activity and payouts. */
export function Delivery({ me, tab }: { me: Me; tab?: string }) {
  const hq = me.user.storeIds === null;
  const current = tab === "sold-out" || tab === "activity" || tab === "payouts" ? tab : "platforms";
  const data = useLoad(() => api<Overview>("/delivery"), []);
  const o = data.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Delivery</h1>
          <p className="muted">Orders from Talabat, Deliveroo, Careem and Noon Food come to the tills and the kitchen. The menu and sold-out items go back to them.</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Delivery">
        {(
          [
            ["platforms", `Platforms${o ? ` (${o.channels.length})` : ""}`, "#/delivery"],
            ["sold-out", `Sold out${o?.soldOut.length ? ` (${o.soldOut.length})` : ""}`, "#/delivery/sold-out"],
            ["activity", "Activity", "#/delivery/activity"],
            ["payouts", "Payouts", "#/delivery/payouts"],
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
      ) : current === "platforms" ? (
        <Platforms o={o} me={me} hq={hq} onChanged={data.reload} />
      ) : current === "sold-out" ? (
        <SoldOut o={o} me={me} onChanged={data.reload} />
      ) : current === "activity" ? (
        <Activity o={o} onRefresh={data.reload} />
      ) : (
        <Payouts me={me} />
      )}
    </div>
  );
}

function Platforms({ o, me, hq, onChanged }: { o: Overview; me: Me; hq: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [showing, setShowing] = useState<Channel | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerName = (id: string) => o.providers.find((p) => p.id === id)?.name ?? id;

  const run = async (id: string, fn: () => Promise<string>) => {
    setBusy(id);
    setError(null);
    try {
      toast(await fn());
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const said = (outcome: string, what: string) =>
    outcome === "simulated" ? `${what}. Not sent yet: add the platform's address to send it for real.` : outcome === "failed" ? `${what}, but the platform could not be reached. See Activity.` : `${what} and sent.`;

  return (
    <>
      {!o.publicUrl && (
        <p className="notice warn">
          <Icon name="alert" /> Set PUBLIC_URL on the server, so the order address below is a full web address the platform can reach.
        </p>
      )}
      {o.menuItems.length === 0 && (
        <p className="notice warn">
          <Icon name="alert" /> No products are on the online menu yet. The platforms get the products ticked under <a href="#/online-store/products">Online store → Products</a>.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      <section className="panel" aria-labelledby="platforms-title">
        <div className="panel-head">
          <h2 id="platforms-title">Platforms</h2>
          {hq && (
            <button type="button" className="btn primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> Connect a platform
            </button>
          )}
        </div>
        {!o.channels.length ? (
          <EmptyState icon="truck" title="No delivery platforms yet">
            Connect each branch's Talabat, Deliveroo, Careem or Noon Food account. You'll get an address and a secret to give the platform (or your integration partner), and
            can send a test order to try the tills and the kitchen first.
          </EmptyState>
        ) : (
          <ul className="channel-list">
            {o.channels.map((c) => (
              <li key={c.id} className={c.active ? "" : "off"}>
                <div className="channel-main">
                  <strong>
                    {c.name}
                    {c.name !== providerName(c.provider) && <span className="muted small"> · {providerName(c.provider)}</span>}
                  </strong>
                  <span className="muted small">
                    {[
                      me.stores.length > 1 ? c.storeName : null,
                      `Branch ${c.externalStoreId}`,
                      c.active ? null : "Off",
                      c.autoAccept ? "Accepts on its own" : `Ready in ${c.prepMinutes} min`,
                      c.commissionBp ? `${bp(c.commissionBp)} commission` : null,
                      c.markupBp ? `prices +${bp(c.markupBp)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="small">
                    {c.pausedUntil ? <span className="badge warn">Busy until {time(c.pausedUntil)}</span> : c.active ? <span className="badge good">Taking orders</span> : null}{" "}
                    <span className="muted">
                      {c.lastOrderAt ? `Last order ${ago(c.lastOrderAt)}` : "No orders yet"} · {c.menuSyncedAt ? `menu sent ${ago(c.menuSyncedAt)}` : "menu not sent"}
                      {c.callbackUrl ? "" : " · not linked yet (simulated)"}
                    </span>
                  </span>
                </div>
                {hq && (
                  <div className="row-actions wrap">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy === c.id}
                      onClick={() => void run(c.id, async () => said((await api<{ outcome: string; items: number }>(`/delivery-channels/${c.id}/menu`, { body: {} })).outcome, "Menu updated"))}
                    >
                      <Icon name="refresh" /> Send menu
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy === c.id}
                      onClick={() =>
                        void run(c.id, async () => {
                          const r = await api<{ code: string }>(`/delivery-channels/${c.id}/test-order`, { body: {} });
                          return `Test order ${r.code} sent to the tills. Turn it down there when done.`;
                        })
                      }
                    >
                      Test order
                    </button>
                    <button type="button" className="btn sm" onClick={() => setShowing(c)}>
                      <Icon name="key" /> Link details
                    </button>
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(c)}>
                      <Icon name="edit" /> Edit
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="how-title">
        <h2 id="how-title">How it works on the till</h2>
        <ol className="steps">
          <li>A new order beeps on the till under Online orders. Accept it within the time shown, with how long it takes, or turn it down.</li>
          <li>The kitchen screen gets the ticket. When the kitchen marks it Ready, the platform sends the rider.</li>
          <li>When the rider collects, press Rider collected: the sale is recorded as paid by the platform, with VAT, stock and the receipt as usual.</li>
          <li>Busy stops new orders for a while; Sold out hides an item until it's back.</li>
        </ol>
      </section>
      {editing && (
        <ChannelDialog
          me={me}
          channel={editing === "new" ? null : editing}
          providers={o.providers}
          onClose={() => setEditing(null)}
          onSaved={(c, isNew) => {
            setEditing(null);
            onChanged();
            if (isNew) setShowing(c);
          }}
        />
      )}
      {showing && (
        <LinkDialog
          channel={o.channels.find((c) => c.id === showing.id) ?? showing}
          onClose={() => setShowing(null)}
          onNewSecret={async () => {
            const c = await api<Channel>(`/delivery-channels/${showing.id}/new-secret`, { body: {} });
            setShowing(c);
            onChanged();
            toast("New secret made. Give it to the platform; the old one stops working now.");
          }}
        />
      )}
    </>
  );
}

function ChannelDialog({
  me,
  channel,
  providers,
  onClose,
  onSaved,
}: {
  me: Me;
  channel: Channel | null;
  providers: Overview["providers"];
  onClose: () => void;
  onSaved: (c: Channel, isNew: boolean) => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    storeId: channel?.storeId ?? me.stores[0]?.id ?? "",
    provider: channel?.provider ?? "talabat",
    name: channel?.name ?? "Talabat",
    externalStoreId: channel?.externalStoreId ?? "",
    callbackUrl: channel?.callbackUrl ?? "",
    autoAccept: channel?.autoAccept ?? false,
    prepMinutes: String(channel?.prepMinutes ?? 20),
    commission: channel ? String(channel.commissionBp / 100) : "",
    markup: channel ? String(channel.markupBp / 100) : "",
    active: channel?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pct = (s: string) => Math.round((Number(s.replace(",", ".")) || 0) * 100);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      storeId: f.storeId,
      provider: f.provider,
      name: f.name.trim(),
      externalStoreId: f.externalStoreId.trim(),
      callbackUrl: f.callbackUrl.trim() || null,
      autoAccept: f.autoAccept,
      prepMinutes: Number(f.prepMinutes) || 20,
      commissionBp: pct(f.commission),
      markupBp: pct(f.markup),
      active: f.active,
    };
    try {
      const saved = channel ? await api<Channel>(`/delivery-channels/${channel.id}`, { method: "PUT", body }) : await api<Channel>("/delivery-channels", { body });
      toast(channel ? `${saved.name} saved` : `${saved.name} connected. Give the platform the address and secret next.`);
      onSaved(saved, !channel);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={channel ? channel.name : "Connect a platform"} wide>
      <h2>{channel ? `Edit ${channel.name}` : "Connect a platform"}</h2>
      <form onSubmit={submit} noValidate className="form-grid">
        <Field label="Platform" required>
          {(p) => (
            <select
              {...p}
              value={f.provider}
              onChange={(e) => {
                const name = providers.find((x) => x.id === e.target.value)?.name ?? "";
                setF({ ...f, provider: e.target.value, name: !f.name || providers.some((x) => x.name === f.name) ? name : f.name });
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Name on the till" required hint="What staff see, e.g. Talabat or Deliveroo JBR">
          {(p) => <input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} />}
        </Field>
        {me.stores.length > 1 && (
          <Field label="Store" required>
            {(p) => (
              <select {...p} value={f.storeId} onChange={(e) => setF({ ...f, storeId: e.target.value })}>
                {me.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Platform's branch id" required hint="As the platform's portal shows it for this branch">
          {(p) => <input {...p} value={f.externalStoreId} onChange={(e) => setF({ ...f, externalStoreId: e.target.value })} maxLength={100} />}
        </Field>
        <Field label="Commission (%)" hint="What the platform keeps of each order, for the payout report">
          {(p) => <input {...p} inputMode="decimal" value={f.commission} onChange={(e) => setF({ ...f, commission: e.target.value })} placeholder="0" />}
        </Field>
        <Field label="Menu prices higher by (%)" hint="Many stores charge more on platforms to cover commission. Rounded up to 0.50.">
          {(p) => <input {...p} inputMode="decimal" value={f.markup} onChange={(e) => setF({ ...f, markup: e.target.value })} placeholder="0" />}
        </Field>
        <Field label="Usual time to prepare" hint="Told to the platform on accepting; the cashier can change it per order">
          {(p) => (
            <select {...p} value={f.prepMinutes} onChange={(e) => setF({ ...f, prepMinutes: e.target.value })}>
              {[10, 15, 20, 25, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Platform's address for our updates" hint="Given by the platform or your integration partner. Leave empty to try it out: updates are only logged.">
          {(p) => <input {...p} type="url" value={f.callbackUrl} onChange={(e) => setF({ ...f, callbackUrl: e.target.value })} placeholder="https://" maxLength={500} />}
        </Field>
        <label className="check full">
          <input type="checkbox" checked={f.autoAccept} onChange={(e) => setF({ ...f, autoAccept: e.target.checked })} />
          <span>Accept orders on their own and send them straight to the kitchen</span>
        </label>
        {channel && (
          <label className="check full">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            <span>On (when off, orders from this platform are refused)</span>
          </label>
        )}
        {error && (
          <p className="form-error full" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions full">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !f.name.trim() || !f.externalStoreId.trim()}>
            {channel ? "Save" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LinkDialog({ channel, onClose, onNewSecret }: { channel: Channel; onClose: () => void; onNewSecret: () => Promise<void> }) {
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast("Copy did not work", "error"));
  return (
    <Modal onClose={onClose} label={`${channel.name} link details`} wide>
      <h2>{channel.name}: link details</h2>
      <p className="muted">
        Give these to the platform or your integration partner. They send new orders, cancellations and rider updates to the address, signed with the secret. The
        format is in the developer guide.
      </p>
      <dl className="link-details">
        <dt>Order address</dt>
        <dd>
          <code>{channel.webhookUrl}</code>
          <button type="button" className="btn sm" onClick={() => copy(channel.webhookUrl, "Address")}>
            <Icon name="copy" /> Copy
          </button>
        </dd>
        <dt>Signing secret</dt>
        <dd>
          <code>{reveal ? channel.secret : "whsec_••••••••••••"}</code>
          <button type="button" className="btn sm" onClick={() => setReveal((x) => !x)}>
            {reveal ? "Hide" : "Show"}
          </button>
          <button type="button" className="btn sm" onClick={() => copy(channel.secret, "Secret")}>
            <Icon name="copy" /> Copy
          </button>
        </dd>
      </dl>
      <div className="dialog-actions">
        <button type="button" className="btn ghost danger" onClick={() => void onNewSecret()}>
          Make a new secret
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function SoldOut({ o, me, onChanged }: { o: Overview; me: Me; onChanged: () => void }) {
  const toast = useToast();
  const [storeId, setStoreId] = useState(me.stores[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = o.soldOut.filter((s) => s.storeId === storeId);
  const out = new Set(here.map((s) => s.variantId));
  const q = search.trim().toLowerCase();
  const matches = useMemo(() => (q ? o.menuItems.filter((i) => i.name.toLowerCase().includes(q) && !out.has(i.variantId)).slice(0, 8) : []), [q, o.menuItems, out]);
  const set = async (variantIds: string[], soldOut: boolean, minutes: number | null = null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ channels: number; failed: number }>("/delivery/sold-out", { body: { storeId, variantIds, soldOut, minutes } });
      toast(r.failed ? "Saved, but a platform could not be reached. See Activity." : soldOut ? "Marked sold out on the platforms" : "Back on the platforms");
      setSearch("");
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-labelledby="sold-title">
      <div className="panel-head">
        <h2 id="sold-title">Sold out for delivery</h2>
        {me.stores.length > 1 && (
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
      </div>
      <p className="muted">Customers on the platforms can't order these. Cashiers can do the same on the till, under Online orders.</p>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      {here.length ? (
        <ul className="sold-out-list">
          {here.map((s) => (
            <li key={s.variantId}>
              <span>
                <strong>{s.name}</strong> <span className="muted small">{s.until ? `until ${dateTime(s.until)}` : "until turned back on"}</span>
              </span>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void set([s.variantId], false)}>
                Back on
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing is sold out.</p>
      )}
      <Field label="Mark an item sold out">
        {(p) => <input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the menu" />}
      </Field>
      {matches.length > 0 && (
        <ul className="sold-out-list">
          {matches.map((i) => (
            <li key={i.variantId}>
              <span>{i.name}</span>
              <span className="row-actions">
                <button type="button" className="btn sm" disabled={busy} onClick={() => void set([i.variantId], true, 60)}>
                  For 1 hour
                </button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => void set([i.variantId], true, null)}>
                  Until turned back on
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Activity({ o, onRefresh }: { o: Overview; onRefresh: () => void }) {
  return (
    <section className="panel" aria-labelledby="activity-title">
      <div className="panel-head">
        <h2 id="activity-title">What went to and came from the platforms</h2>
        <button type="button" className="btn sm" onClick={onRefresh}>
          <Icon name="refresh" /> Refresh
        </button>
      </div>
      {!o.events.length ? (
        <p className="muted">Nothing yet. Send a test order or the menu from Platforms.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Platform</th>
                <th scope="col">What</th>
                <th scope="col">Result</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {o.events.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{dateTime(e.createdAt)}</td>
                  <td>{e.channelName}</td>
                  <td>
                    {e.direction === "in" ? "← " : "→ "}
                    {KIND[e.kind] ?? e.kind}
                  </td>
                  <td>
                    <span className={`badge ${e.outcome === "failed" || e.outcome === "refused" ? "bad" : e.outcome === "simulated" ? "" : "good"}`}>{OUTCOME[e.outcome] ?? e.outcome}</span>
                  </td>
                  <td className="small">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Payouts({ me }: { me: Me }) {
  const [range, setRange] = useState({ from: today(), to: today() });
  const [storeId, setStoreId] = useState("");
  const qs = `from=${range.from}&to=${range.to}${storeId ? `&storeId=${storeId}` : ""}`;
  const data = useLoad(() => api<{ rows: ReportRow[]; totals: Omit<ReportRow, "id" | "name" | "storeName" | "acceptSeconds"> }>(`/delivery/report?${qs}`), [qs]);
  const toast = useToast();
  return (
    <section className="panel" aria-labelledby="payout-title">
      <div className="panel-head wrap">
        <h2 id="payout-title">Orders and payouts</h2>
        <div className="row-actions wrap">
          <button type="button" className="btn sm" onClick={() => download(`/delivery/report?${qs}&format=csv`, `delivery-${range.from}-to-${range.to}.csv`).catch((err) => toast(errorText(err)))}>
            <Icon name="download" /> CSV
          </button>
          <label className="inline-label">
            <span>From</span>
            <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="inline-label">
            <span>To</span>
            <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
          </label>
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
        </div>
      </div>
      <p className="muted">Sales are orders the rider collected, at what the customer paid for the food. Payout is what the platform should pay you after its commission.</p>
      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <SkeletonRows rows={3} />
      ) : !data.data.rows.length ? (
        <p className="muted">No platforms connected.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Platform</th>
                <th scope="col" className="num">Orders</th>
                <th scope="col" className="num">Cancelled</th>
                <th scope="col" className="num">Sales</th>
                <th scope="col" className="num">Commission</th>
                <th scope="col" className="num">Payout</th>
                <th scope="col" className="num">Avg. time to accept</th>
              </tr>
            </thead>
            <tbody>
              {data.data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {me.stores.length > 1 && <span className="muted small"> · {r.storeName}</span>}
                  </td>
                  <td className="num">{r.delivered}</td>
                  <td className="num">{r.cancelled}</td>
                  <td className="num">{aed(r.sales)}</td>
                  <td className="num">{aed(r.commission)}</td>
                  <td className="num">
                    <strong>{aed(r.payout)}</strong>
                  </td>
                  <td className="num">{r.acceptSeconds === null ? "–" : r.acceptSeconds < 60 ? `${r.acceptSeconds} s` : `${Math.round(r.acceptSeconds / 60)} min`}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td className="num">{data.data.totals.delivered}</td>
                <td className="num">{data.data.totals.cancelled}</td>
                <td className="num">{aed(data.data.totals.sales)}</td>
                <td className="num">{aed(data.data.totals.commission)}</td>
                <td className="num">
                  <strong>{aed(data.data.totals.payout)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
