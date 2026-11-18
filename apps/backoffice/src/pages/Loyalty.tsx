import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { aed, dateTime, money, tryParseMoney } from "../lib/format.js";
import type { GiftCard, GiftCardDetail, LoyaltyOverview, LoyaltySettings, Me } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

const PAGE = 50;

/** Points programme and gift cards. #/loyalty, and #/loyalty/cards/<id> for one card. */
export function Loyalty({ me, cardId }: { me: Me; cardId?: string }) {
  return cardId ? <CardDetail me={me} id={cardId} /> : <LoyaltyHome me={me} />;
}

export const MOVE_LABEL: Record<string, string> = {
  sale: "Sold at the till",
  topup: "Topped up at the till",
  issue: "Issued",
  redeem: "Spent",
  redeem_void: "Given back",
  refund: "Refund (store credit)",
  adjust: "Changed by hand",
  earn: "Earned",
  refund_earn: "Taken back by a refund",
  refund_redeem: "Given back by a refund",
};

const signed = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const signedPts = (n: number) => (n > 0 ? `+${n.toLocaleString("en-AE")}` : n.toLocaleString("en-AE"));

function LoyaltyHome({ me }: { me: Me }) {
  const overview = useLoad(() => api<LoyaltyOverview>("/loyalty"), []);
  const owner = me.user.role === "owner";
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Loyalty &amp; gift cards</h1>
          <p className="muted">Customers earn points on what they spend and pay with them later. Gift cards are sold at the till and spent like money.</p>
        </div>
      </header>
      {overview.error ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : !overview.data ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <div className="kpis loyalty-kpis">
            <div className="kpi">
              <span className="kpi-label">Points customers hold</span>
              <span className="kpi-value">{overview.data.stats.pointsOutstanding.toLocaleString("en-AE")}</span>
              <span className="kpi-note">worth {aed(overview.data.stats.pointsValue)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Customers with points</span>
              <span className="kpi-value">{overview.data.stats.members}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Earned, last 30 days</span>
              <span className="kpi-value">{overview.data.stats.earned30.toLocaleString("en-AE")}</span>
              <span className="kpi-note">{overview.data.stats.redeemed30.toLocaleString("en-AE")} spent</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Left on gift cards</span>
              <span className="kpi-value">{aed(overview.data.stats.giftCardBalance)}</span>
              <span className="kpi-note">{overview.data.stats.giftCardsLive} cards with money on them</span>
            </div>
          </div>
          <SettingsPanel settings={overview.data.settings} owner={owner} onSaved={overview.reload} />
        </>
      )}
      <GiftCards owner={owner} />
    </div>
  );
}

function SettingsPanel({ settings, owner, onSaved }: { settings: LoyaltySettings; owner: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    enabled: settings.enabled,
    pointsPerAed: String(settings.pointsPerAed),
    pointsPerAedValue: String(Math.round(100 / settings.pointValueFils)),
    minRedeemPoints: String(settings.minRedeemPoints),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const perAed = Number(form.pointsPerAed);
  const perValue = Number(form.pointsPerAedValue);
  // "How many points pay AED 1" is easier to think about than fils per point.
  const pointValueFils = perValue > 0 && 100 % perValue === 0 ? 100 / perValue : null;
  const returnPct = perAed > 0 && pointValueFils ? (perAed * pointValueFils) : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!Number.isInteger(perAed) || perAed < 1 || perAed > 1000) errs.pointsPerAed = "A whole number from 1 to 1000.";
    if (!pointValueFils) errs.pointsPerAedValue = "Use 1, 2, 4, 5, 10, 20, 25, 50 or 100 so a point is a whole number of fils.";
    const min = Number(form.minRedeemPoints);
    if (!Number.isInteger(min) || min < 0) errs.minRedeemPoints = "A whole number, 0 or more.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("/loyalty", { method: "PUT", body: { enabled: form.enabled, pointsPerAed: perAed, pointValueFils, minRedeemPoints: min } });
      toast("Points programme saved. Tills pick it up within a minute.");
      onSaved();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={save} noValidate>
      <h2>Points programme</h2>
      {!owner && <p className="muted">Only the owner can change the programme.</p>}
      <fieldset disabled={!owner || busy} className="plain-fieldset">
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>
            Customers earn points
            <span className="hint">Points are earned on sales with a customer on them. Switched off, customers keep their points and can still spend them.</span>
          </span>
        </label>
        <div className="form-grid">
          <Field label="Points for each AED 1 spent" error={errors.pointsPerAed}>
            {(p) => <input {...p} inputMode="numeric" value={form.pointsPerAed} onChange={(e) => set("pointsPerAed", e.target.value.replace(/\D/g, ""))} />}
          </Field>
          <Field label="Points that pay AED 1" error={errors.pointsPerAedValue}>
            {(p) => <input {...p} inputMode="numeric" value={form.pointsPerAedValue} onChange={(e) => set("pointsPerAedValue", e.target.value.replace(/\D/g, ""))} />}
          </Field>
          <Field label="Fewest points spent at once" error={errors.minRedeemPoints}>
            {(p) => <input {...p} inputMode="numeric" value={form.minRedeemPoints} onChange={(e) => set("minRedeemPoints", e.target.value.replace(/\D/g, ""))} />}
          </Field>
        </div>
        {returnPct !== null && (
          <p className="muted">
            A customer who spends AED 100 earns {(perAed * 100).toLocaleString("en-AE")} points, worth {aed(returnPct * 100)} next time: {returnPct}% back.
          </p>
        )}
        <p className="hint">
          Points pay like money, so VAT is charged on the full price of what they buy. What points paid for earns no points; gift cards bought earn none either.
        </p>
        {owner && (
          <div className="dialog-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Saving…" : "Save programme"}
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

function GiftCards({ owner }: { owner: boolean }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [issuing, setIssuing] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), status });
    if (search) p.set("q", search);
    return api<{ giftCards: GiftCard[]; count: number }>(`/gift-cards?${p}`);
  }, [search, status, offset]);
  const data = list.data;

  return (
    <section className="panel" aria-labelledby="gc-head">
      <div className="panel-head">
        <h2 id="gc-head">Gift cards</h2>
        {owner && (
          <button type="button" className="btn primary" onClick={() => setIssuing(true)}>
            <Icon name="plus" /> Issue a gift card
          </button>
        )}
      </div>
      <div className="filters" role="search">
        <div className="search">
          <Icon name="search" />
          <input type="search" aria-label="Search gift cards" placeholder="Card number or customer" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
          <option value="all">All cards</option>
          <option value="active">On</option>
          <option value="disabled">Switched off</option>
        </select>
      </div>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !data ? (
        <SkeletonRows rows={4} />
      ) : data.count === 0 ? (
        <EmptyState icon="gift" title={search ? "No gift cards match" : "No gift cards yet"}>
          <p className="muted">{search ? "Try the last digits of the number." : "Sell one at the till (Gift card button), or issue one here as a prize or a goodwill gesture."}</p>
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Gift cards</caption>
              <thead>
                <tr>
                  <th scope="col">Card</th>
                  <th scope="col" className="hide-sm">Customer</th>
                  <th scope="col" className="num">Balance (AED)</th>
                  <th scope="col" className="num hide-xs">Loaded</th>
                  <th scope="col" className="hide-sm">Last used</th>
                </tr>
              </thead>
              <tbody>
                {data.giftCards.map((g) => (
                  <tr key={g.id} className={g.status === "active" ? "clickable" : "clickable dim"}>
                    <td>
                      <a className="row-link tnum" href={`#/loyalty/cards/${g.id}`}>
                        {g.code}
                      </a>
                      {g.status !== "active" && <span className="badge">Off</span>}
                      {g.expiresAt && Date.parse(g.expiresAt) < Date.now() && <span className="badge warn">Expired</span>}
                      {g.customerName && <span className="cell-sub show-xs">{g.customerName}</span>}
                    </td>
                    <td className="hide-sm">{g.customerName ?? <span className="muted">None</span>}</td>
                    <td className="num strong">{money(g.balance)}</td>
                    <td className="num hide-xs">{money(g.loaded)}</td>
                    <td className="hide-sm">{g.lastUsed ? dateTime(g.lastUsed) : <span className="muted">Never</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.count > PAGE && (
            <nav className="pager" aria-label="Pages">
              <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <Icon name="chevronLeft" /> Previous
              </button>
              <span className="muted">
                {offset + 1}–{Math.min(offset + PAGE, data.count)} of {data.count}
              </span>
              <button type="button" className="btn" disabled={offset + PAGE >= data.count} onClick={() => setOffset(offset + PAGE)}>
                Next <Icon name="chevronRight" />
              </button>
            </nav>
          )}
        </>
      )}
      {issuing && (
        <IssueDialog
          onClose={() => setIssuing(false)}
          onIssued={(id) => {
            setIssuing(false);
            window.location.hash = `#/loyalty/cards/${id}`;
          }}
        />
      )}
    </section>
  );
}

function IssueDialog({ onClose, onIssued }: { onClose: () => void; onIssued: (id: string) => void }) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const fils = tryParseMoney(amount);
    if (!fils || fils <= 0) errs.amount = "Enter the amount, like 100";
    const c = code.trim().toUpperCase();
    if (c && !/^[A-Z0-9-]{6,40}$/.test(c)) errs.code = "6 to 40 letters, digits or dashes. Leave empty for a new number.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await api<{ id: string; code: string }>("/gift-cards", {
        body: { code: c || null, amount: fils, note: note.trim() || null, expiresAt: expires ? new Date(`${expires}T23:59:59+04:00`).toISOString() : null },
      });
      toast(`Gift card ${res.code} issued with ${aed(fils!)}`);
      onIssued(res.id);
    } catch (err) {
      const msg = errorText(err);
      if (msg.toLowerCase().includes("number")) setErrors({ code: msg });
      else toast(msg, "error");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Issue a gift card">
      <h2>Issue a gift card</h2>
      <p className="muted">For a prize, a gift to a customer, or to replace a lost card. Selling one is done at the till.</p>
      <form onSubmit={submit} noValidate>
        <Field label="Amount (AED)" required error={errors.amount}>
          {(p) => <input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus placeholder="100.00" />}
        </Field>
        <Field label="Card number" error={errors.code} hint="The barcode on a printed card. Leave empty to make a new 16-digit number.">
          {(p) => <input {...p} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={40} autoComplete="off" />}
        </Field>
        <Field label="Valid until" hint="Leave empty for no end date.">
          {(p) => <input {...p} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        <Field label="Note" hint="Why it was given. Shown on the card's page and in the audit log.">
          {(p) => <input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}
        </Field>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Issuing…" : "Issue card"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CardDetail({ me, id }: { me: Me; id: string }) {
  const toast = useToast();
  const detail = useLoad(() => api<GiftCardDetail>(`/gift-cards/${id}`), [id]);
  const [adjusting, setAdjusting] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = me.user.role === "owner";

  const patch = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    try {
      await api(`/gift-cards/${id}`, { method: "PATCH", body });
      toast(message);
      await detail.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const release = async (moveId: string) => {
    setBusy(true);
    try {
      const res = await api<{ balance: number }>(`/gift-cards/${id}/release/${moveId}`, { method: "POST" });
      toast(`Given back. The card now has ${aed(res.balance)}.`);
      await detail.reload();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (detail.error) return <div className="page"><ErrorState message={detail.error} onRetry={detail.reload} /></div>;
  if (!detail.data) return <div className="page"><SkeletonRows rows={5} /></div>;
  const g = detail.data;
  const expired = !!g.expiresAt && Date.parse(g.expiresAt) < Date.now();
  return (
    <div className="page">
      <a className="back-link" href="#/loyalty">
        ← Loyalty &amp; gift cards
      </a>
      <header className="page-head">
        <div>
          <h1 className="tnum">
            {g.code}
            {g.status !== "active" && <span className="badge">Off</span>}
            {expired && <span className="badge warn">Expired</span>}
          </h1>
          <p className="muted">
            {[g.customerName && `For ${g.customerName}`, `Created ${dateTime(g.createdAt)}`, g.expiresAt && `valid until ${dateTime(g.expiresAt)}`, g.note]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="head-actions">
          {owner && (
            <button type="button" className="btn" onClick={() => setAdjusting(true)} disabled={busy}>
              <Icon name="edit" /> Change balance
            </button>
          )}
          {g.status === "active" ? (
            <button type="button" className="btn danger" disabled={busy} onClick={() => void patch({ status: "disabled" }, "Card switched off. Tills can no longer spend it.")}>
              Switch off
            </button>
          ) : (
            owner && (
              <button type="button" className="btn" disabled={busy} onClick={() => void patch({ status: "active" }, "Card switched back on")}>
                Switch on
              </button>
            )
          )}
        </div>
      </header>
      <div className="kpis loyalty-kpis">
        <div className="kpi hero">
          <span className="kpi-label">Balance</span>
          <span className="kpi-value">{aed(g.balance)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Loaded in all</span>
          <span className="kpi-value">{aed(g.loaded)}</span>
        </div>
      </div>
      <section className="panel" aria-labelledby="moves-head">
        <h2 id="moves-head">History</h2>
        {g.moves.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Card history</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col" className="hide-sm">Where</th>
                  <th scope="col" className="num">Amount (AED)</th>
                </tr>
              </thead>
              <tbody>
                {g.moves.map((m) => (
                  <tr key={m.id}>
                    <td>{dateTime(m.at)}</td>
                    <td>
                      {MOVE_LABEL[m.kind] ?? m.kind}
                      {m.orderNumber && (
                        <span className="cell-sub">
                          <a className="row-link tnum" href={`#/sales/${m.orderId}`}>
                            {m.orderNumber}
                          </a>
                        </span>
                      )}
                      {m.note && <span className="cell-sub">{m.note}</span>}
                      {m.unclaimed && (
                        <span className="cell-sub warn-text">
                          Taken at a till but not on a sale yet.{" "}
                          {m.releasable ? (
                            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void release(m.id)}>
                              Give it back
                            </button>
                          ) : (
                            "If the sale did not go ahead, you can give it back after 15 minutes."
                          )}
                        </span>
                      )}
                    </td>
                    <td className="hide-sm">{[m.storeName, m.userName].filter(Boolean).join(" · ") || <span className="muted">Back office</span>}</td>
                    <td className={m.amount < 0 ? "num strong bad" : "num strong"}>{signed(m.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adjusting && (
        <AdjustDialog
          title={`Change the balance of ${g.code}`}
          unit="AED"
          current={aed(g.balance)}
          onClose={() => setAdjusting(false)}
          onSave={async (value, note) => {
            const fils = tryParseMoney(value.replace(/^\+/, ""));
            if (fils === null || fils === 0) throw new Error("Enter an amount, like 25 to add or -25 to take off");
            const res = await api<{ balance: number }>(`/gift-cards/${id}/adjust`, { body: { amount: fils, note } });
            toast(`Balance now ${aed(res.balance)}`);
            setAdjusting(false);
            await detail.reload();
          }}
        />
      )}
    </div>
  );
}

/** Adds to or takes off a balance by hand, with the reason that goes in the audit log. */
export function AdjustDialog({
  title,
  unit,
  current,
  onClose,
  onSave,
}: {
  title: string;
  unit: string;
  current: string;
  onClose: () => void;
  onSave: (value: string, note: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return setError("Say why, for the audit log");
    setBusy(true);
    setError(null);
    try {
      await onSave(value.trim(), note.trim());
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={title}>
      <h2>{title}</h2>
      <p className="muted">Now {current}. Use a minus sign to take off.</p>
      <form onSubmit={submit} noValidate>
        <Field label={`Change (${unit})`} required>
          {(p) => <input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus placeholder={unit === "AED" ? "25.00 or -25.00" : "500 or -500"} />}
        </Field>
        <Field label="Reason" required>
          {(p) => <input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Card damaged, balance moved" />}
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
          <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export { signedPts };
