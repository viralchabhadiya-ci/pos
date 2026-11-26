import { useEffect, useMemo, useState } from "react";
import { CodeInput, Scanner } from "../components/Scanner.js";
import { Sheet, Stepper } from "../components/Sheet.js";
import { Empty, ErrorState, Skeleton } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import { qty } from "../lib/format.js";
import { findByCode, searchByName } from "../lib/match.js";
import type { Scannable } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface CountSummary {
  id: string;
  number: string;
  name: string;
  lines: number;
  counted: number;
}
interface CountLine extends Scannable {
  counted: number | null;
}
interface CountSheet {
  id: string;
  number: string;
  name: string;
  status: string;
  lines: CountLine[];
}

export function Counts({ id }: { id?: string }) {
  return id ? <CountSheetView id={id} /> : <CountList />;
}

function CountList() {
  const list = useLoad(() => api<{ counts: CountSummary[] }>("/staff/counts"), []);
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Skeleton />;
  if (!list.data.counts.length) return <Empty title="No count open" text="A manager starts a stock count in the back office (Inventory → Stock counts). It shows here for this store." />;
  return (
    <>
      {list.data.counts.map((c) => (
        <a key={c.id} className="card" href={`#/count/${c.id}`} style={{ display: "block", textDecoration: "none" }}>
          <h2 style={{ marginBottom: 4 }}>{c.name}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {c.number} · {c.counted} of {c.lines} counted
          </p>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${c.lines ? (c.counted / c.lines) * 100 : 0}%` }} />
          </div>
        </a>
      ))}
    </>
  );
}

function CountSheetView({ id }: { id: string }) {
  const sheet = useLoad(() => api<CountSheet>(`/staff/counts/${id}`), [id]);
  const toast = useToast();
  const [lines, setLines] = useState<CountLine[]>([]);
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<CountLine | null>(null);
  const [value, setValue] = useState("");
  const [addPerScan, setAddPerScan] = useState(false);
  const [filter, setFilter] = useState<"todo" | "done">("todo");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (sheet.data) setLines(sheet.data.lines);
  }, [sheet.data]);

  const save = async (line: CountLine, counted: number) => {
    setSaving(true);
    try {
      await api(`/staff/counts/${id}/lines`, { method: "PUT", body: { lines: [{ variantId: line.variantId, counted }] } });
      setLines((ls) => ls.map((l) => (l.variantId === line.variantId ? { ...l, counted } : l)));
      return true;
    } catch (err) {
      toast(errorText(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const open = (line: CountLine) => {
    setEditing(line);
    setValue(String(line.counted ?? 0));
  };

  const onCode = async (c: string) => {
    const line = findByCode(lines, c);
    if (!line) {
      toast(`${c} is not on this count`);
      return;
    }
    if (addPerScan) {
      const next = (line.counted ?? 0) + 1;
      if (await save(line, next)) toast(`${line.name}: ${qty(next, line.uom)}`);
    } else {
      setScanning(false);
      open(line);
    }
  };

  const matches = useMemo(() => (code && !/^\d{6,}$/.test(code) ? searchByName(lines, code) : []), [code, lines]);
  if (sheet.error) return <ErrorState message={sheet.error} onRetry={sheet.reload} />;
  if (!sheet.data) return <Skeleton />;
  const done = lines.filter((l) => l.counted !== null).length;
  const shown = lines.filter((l) => (filter === "done" ? l.counted !== null : l.counted === null));

  return (
    <>
      <a href="#/count" className="btn ghost sm">
        ← Counts
      </a>
      <h2 style={{ margin: "8px 0 0" }}>{sheet.data.name}</h2>
      <p className="muted small">
        {sheet.data.number} · {done} of {lines.length} counted
      </p>
      {sheet.data.status !== "open" ? (
        <p className="offline">This count is {sheet.data.status}. Nothing more can be saved.</p>
      ) : (
        <>
          <CodeInput
            value={code}
            onChange={setCode}
            onSubmit={() => {
              const line = findByCode(lines, code) ?? (matches.length === 1 ? matches[0] : undefined);
              if (line) {
                open(line);
                setCode("");
              } else if (!matches.length) toast("Not on this count");
            }}
            scanning={scanning}
            onScanToggle={() => setScanning(!scanning)}
            label="Find a product on this count"
          />
          <label className="switch">
            <span>
              Add 1 for each scan
              <span className="hint">For counting item by item. Off: each scan opens the number to type.</span>
            </span>
            <input type="checkbox" checked={addPerScan} onChange={(e) => setAddPerScan(e.target.checked)} />
          </label>
          {scanning && <Scanner onCode={onCode} onClose={() => setScanning(false)} />}
          {matches.length > 0 && (
            <div className="card">
              <ul className="list">
                {matches.map((l) => (
                  <li key={l.variantId}>
                    <button type="button" className="btn ghost block" style={{ justifyContent: "flex-start" }} onClick={() => open(l)}>
                      {l.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="seg" role="group" aria-label="Show">
        <button type="button" aria-pressed={filter === "todo"} onClick={() => setFilter("todo")}>
          To count ({lines.length - done})
        </button>
        <button type="button" aria-pressed={filter === "done"} onClick={() => setFilter("done")}>
          Counted ({done})
        </button>
      </div>
      <div className="card">
        {shown.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {filter === "todo" ? "Everything is counted. A manager completes the count in the back office." : "Nothing counted yet."}
          </p>
        ) : (
          <ul className="list">
            {shown.slice(0, 200).map((l) => (
              <li key={l.variantId}>
                <span className="grow">
                  <span className="title">{l.name}</span>
                  <span className="line-meta">{l.barcode ?? l.sku ?? ""}</span>
                </span>
                {l.counted !== null && <span className="amount done-row">{qty(l.counted, l.uom)}</span>}
                {sheet.data!.status === "open" && (
                  <button type="button" className="btn sm" onClick={() => open(l)}>
                    {l.counted === null ? "Count" : "Change"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {shown.length > 200 && <p className="muted small">Showing 200 of {shown.length}. Scan or search to find the rest.</p>}
      </div>
      {editing && (
        <Sheet title={editing.name} onClose={() => setEditing(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const n = Number(value);
              if (!Number.isFinite(n) || n < 0) return toast("Enter how many are on the shelf");
              if (editing.uom !== "kg" && !Number.isInteger(n)) return toast(`${editing.name} is counted in whole pieces`);
              if (await save(editing, n)) {
                toast(`${editing.name}: ${qty(n, editing.uom)}`);
                setEditing(null);
              }
            }}
          >
            <div className="field">
              <label htmlFor="counted">How many on the shelf{editing.uom === "kg" ? " (kg)" : ""}</label>
              <Stepper id="counted" value={value} onChange={setValue} label="counted" step={editing.uom === "kg" ? 0.1 : 1} />
            </div>
            <button type="submit" className="btn primary block" disabled={saving}>
              {saving && <span className="spinner" aria-hidden />}
              Save
            </button>
          </form>
        </Sheet>
      )}
    </>
  );
}
