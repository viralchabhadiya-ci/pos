import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon, type IconName } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, apiUrl, blobUrl, errorText } from "../lib/api.js";
import { ago, dateTime } from "../lib/format.js";
import type { Category, Me, Promotion } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

interface Screen {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  playlistId: string | null;
  playlistName: string | null;
  orientation: "landscape" | "portrait";
  lang: "en" | "ar" | "both";
  lastSeenAt: string | null;
  online: boolean;
  link: string | null;
  path: string;
}
interface PlaylistRow {
  id: string;
  name: string;
  updatedAt: string;
  slides: number;
  screens: number;
}
interface Media {
  id: string;
  name: string;
  contentType: string;
  size: number;
  uses: number;
}
interface Overview {
  screens: Screen[];
  playlists: PlaylistRow[];
  media: Media[];
  tvUrl: string | null;
  maxPicture: number;
}
type Kind = "image" | "prices" | "promo" | "message" | "video";
type Theme = "brand" | "dark" | "light" | "offer";
interface Slide {
  id?: string;
  kind: Kind;
  duration: number;
  mediaId: string | null;
  categoryId: string | null;
  promotionId: string | null;
  title: string | null;
  titleAr: string | null;
  body: string | null;
  bodyAr: string | null;
  videoUrl: string | null;
  theme: Theme;
  startsOn: string | null;
  endsOn: string | null;
  days: number[] | null;
  startTime: string | null;
  endTime: string | null;
  active: boolean;
}
interface Playlist {
  id: string;
  name: string;
  updatedAt: string;
  slides: Slide[];
}

const KINDS: Record<Kind, { label: string; icon: IconName; hint: string }> = {
  image: { label: "Picture", icon: "image", hint: "A poster or banner you uploaded." },
  prices: { label: "Price board", icon: "list", hint: "Products and this store's prices, VAT included. Pages through long lists." },
  promo: { label: "Offer", icon: "percent", hint: "One of your promotions. It shows only while the promotion is running at that store." },
  message: { label: "Message", icon: "megaphone", hint: "A title and a few lines, e.g. opening hours or delivery." },
  video: { label: "Video", icon: "tv", hint: "An MP4 or WebM video from an https:// address. It plays muted." },
};
const THEMES: [Theme, string][] = [
  ["brand", "Green"],
  ["dark", "Dark"],
  ["light", "Light"],
  ["offer", "Offer (orange)"],
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LANG: Record<Screen["lang"], string> = { en: "English", ar: "Arabic", both: "English and Arabic" };

const screenUrl = (s: Screen) => s.link ?? apiUrl(s.path);
const tvAddress = (o: Overview) => o.tvUrl ?? apiUrl("/tv");

/** TV screens in the stores: what each one shows, the playlists and the pictures they use. */
export function Signage({ me, tab, sub }: { me: Me; tab?: string; sub?: string }) {
  const hq = me.user.storeIds === null;
  const current = hq && (tab === "playlists" || tab === "pictures") ? tab : "screens";
  const data = useLoad(() => api<Overview>("/signage"), []);
  const [adding, setAdding] = useState(false);
  const o = data.data;

  if (current === "playlists" && sub) return <PlaylistEditor id={sub} media={o?.media ?? []} onChanged={data.reload} />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Screens</h1>
          <p className="muted">Show pictures, price boards, offers and messages on TVs in your stores. Any TV or stick with a web browser works.</p>
        </div>
        {current === "screens" && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Connect a TV
          </button>
        )}
      </header>
      {hq && (
        <div className="tabs" role="tablist" aria-label="Screens">
          {(
            [
              ["screens", `Screens${o ? ` (${o.screens.length})` : ""}`, "#/screens"],
              ["playlists", "Playlists", "#/screens/playlists"],
              ["pictures", "Pictures", "#/screens/pictures"],
            ] as const
          ).map(([id, label, href]) => (
            <a key={id} role="tab" className="tab tab-link" aria-selected={current === id} href={href}>
              {label}
            </a>
          ))}
        </div>
      )}
      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !o ? (
        <SkeletonRows rows={4} />
      ) : current === "screens" ? (
        <Screens o={o} me={me} onChanged={data.reload} />
      ) : current === "playlists" ? (
        <Playlists o={o} onChanged={data.reload} />
      ) : (
        <Pictures o={o} onChanged={data.reload} />
      )}
      {adding && o && (
        <ScreenDialog
          me={me}
          o={o}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            data.reload();
          }}
        />
      )}
    </div>
  );
}

// Screens

function Screens({ o, me, onChanged }: { o: Overview; me: Me; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Screen | null>(null);
  const [connecting, setConnecting] = useState<Screen | null>(null);
  const [asking, setAsking] = useState<{ s: Screen; what: "new-link" | "delete" } | null>(null);
  // "Online" goes stale while the page is open.
  useEffect(() => {
    const timer = setInterval(onChanged, 60_000);
    return () => clearInterval(timer);
  }, [onChanged]);

  const copy = async (s: Screen) => {
    try {
      await navigator.clipboard.writeText(screenUrl(s));
      toast("Link copied");
    } catch {
      toast("Copy did not work. Open the screen and copy the address.", "error");
    }
  };

  if (!o.screens.length)
    return (
      <EmptyState icon="tv" title="No screens yet">
        <ol className="steps">
          <li>
            On the TV, open the web browser and go to <strong className="tnum">{tvAddress(o)}</strong>. It shows a 6-digit code.
          </li>
          <li>Here, choose Connect a TV and enter the code.</li>
          <li>{o.playlists.length ? "Pick the playlist it shows." : "Make a playlist under Playlists and pick it for the screen."}</li>
        </ol>
      </EmptyState>
    );

  return (
    <>
      <p className="hint">
        To connect a TV, open <strong className="tnum">{tvAddress(o)}</strong> in its browser and enter the code it shows. A screen keeps playing what it has if the internet drops.
      </p>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Screens</caption>
          <thead>
            <tr>
              <th scope="col">Screen</th>
              <th scope="col">Shows</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {o.screens.map((s) => (
              <tr key={s.id}>
                <td>
                  <button type="button" className="row-link plain" onClick={() => setEditing(s)}>
                    {s.name}
                  </button>
                  <span className="cell-sub">
                    {s.storeName} · {s.orientation === "portrait" ? "Portrait" : "Landscape"} · {LANG[s.lang]}
                  </span>
                </td>
                <td>{s.playlistName ?? <span className="muted">Nothing (pick a playlist)</span>}</td>
                <td>
                  {s.online ? (
                    <span className="badge good">On</span>
                  ) : s.lastSeenAt ? (
                    <span className="badge warn" title={dateTime(s.lastSeenAt)}>
                      Off · {ago(s.lastSeenAt)}
                    </span>
                  ) : (
                    <span className="badge">Not connected</span>
                  )}
                </td>
                <td className="num">
                  <div className="row-actions">
                    <button type="button" className="btn sm" onClick={() => setConnecting(s)}>
                      <Icon name="tv" /> <span className="hide-sm">Connect a TV</span>
                    </button>
                    <a className="btn sm" href={screenUrl(s)} target="_blank" rel="noreferrer" aria-label={`Open ${s.name}`}>
                      <Icon name="send" />
                    </a>
                    <button type="button" className="btn sm hide-xs" onClick={() => void copy(s)} aria-label={`Copy the link of ${s.name}`}>
                      <Icon name="copy" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <ScreenDialog
          me={me}
          o={o}
          screen={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          onAsk={(what) => {
            setAsking({ s: editing, what });
            setEditing(null);
          }}
        />
      )}
      {connecting && (
        <ConnectDialog
          o={o}
          screen={connecting}
          onClose={() => setConnecting(null)}
          onDone={() => {
            setConnecting(null);
            toast(`${connecting.name} is connected. It starts within a few seconds.`);
            onChanged();
          }}
        />
      )}
      {asking && (
        <Confirm
          title={asking.what === "delete" ? `Delete ${asking.s.name}?` : `Make a new link for ${asking.s.name}?`}
          body={
            asking.what === "delete"
              ? "The TV goes back to showing a code. Playlists and pictures stay."
              : "Use this if the link was shared by mistake. The TV on the old link goes back to showing a code, and you connect it again."
          }
          action={asking.what === "delete" ? "Delete screen" : "Make a new link"}
          danger={asking.what === "delete"}
          onClose={() => setAsking(null)}
          onConfirm={async () => {
            await api(asking.what === "delete" ? `/signage/screens/${asking.s.id}` : `/signage/screens/${asking.s.id}/new-link`, {
              method: asking.what === "delete" ? "DELETE" : "POST",
              body: asking.what === "delete" ? undefined : {},
            });
            toast(asking.what === "delete" ? "Screen deleted" : "New link made. Connect the TV again.");
            setAsking(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function ScreenDialog({
  me,
  o,
  screen,
  onClose,
  onSaved,
  onAsk,
}: {
  me: Me;
  o: Overview;
  screen?: Screen;
  onClose: () => void;
  onSaved: () => void;
  onAsk?: (what: "new-link" | "delete") => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    code: "",
    name: screen?.name ?? "",
    storeId: screen?.storeId ?? me.stores[0]?.id ?? "",
    playlistId: screen?.playlistId ?? o.playlists[0]?.id ?? "",
    orientation: screen?.orientation ?? "landscape",
    lang: screen?.lang ?? "both",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { ...form, playlistId: form.playlistId || null, code: screen ? undefined : form.code || undefined };
    try {
      await api(screen ? `/signage/screens/${screen.id}` : "/signage/screens", { method: screen ? "PUT" : "POST", body });
      toast(screen ? `${form.name} saved` : form.code ? `${form.name} is connected. It starts within a few seconds.` : `${form.name} added`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={screen ? screen.name : "Connect a TV"}>
      <h2>{screen ? screen.name : "Connect a TV"}</h2>
      <form onSubmit={submit} noValidate>
        {!screen && (
          <Field label="Code on the TV" hint={`On the TV, open ${tvAddress(o)} in the browser. Leave empty to add the screen now and connect it later.`}>
            {(p) => <input {...p} className="code-input tnum" inputMode="numeric" autoComplete="off" placeholder="123 456" maxLength={7} value={form.code} onChange={set("code")} autoFocus />}
          </Field>
        )}
        <div className="form-grid">
          <Field label="Name" required hint="e.g. Window, Bakery, Till queue">
            {(p) => <input {...p} value={form.name} onChange={set("name")} maxLength={80} />}
          </Field>
          <Field label="Store" required>
            {(p) => (
              <select {...p} value={form.storeId} onChange={set("storeId")}>
                {me.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Playlist" hint={o.playlists.length ? undefined : "Head office makes playlists under Screens → Playlists."}>
            {(p) => (
              <select {...p} value={form.playlistId} onChange={set("playlistId")}>
                <option value="">Nothing yet</option>
                {o.playlists.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Language" hint="For price boards and offers.">
            {(p) => (
              <select {...p} value={form.lang} onChange={set("lang")}>
                <option value="both">English and Arabic</option>
                <option value="en">English</option>
                <option value="ar">Arabic</option>
              </select>
            )}
          </Field>
          <Field label="How the TV hangs" hint="Portrait turns the picture for a TV mounted on its side.">
            {(p) => (
              <select {...p} value={form.orientation} onChange={set("orientation")}>
                <option value="landscape">Landscape (wide)</option>
                <option value="portrait">Portrait (tall)</option>
              </select>
            )}
          </Field>
        </div>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          {screen && onAsk && (
            <>
              <button type="button" className="btn danger" onClick={() => onAsk("delete")}>
                Delete
              </button>
              <button type="button" className="btn" onClick={() => onAsk("new-link")}>
                New link
              </button>
              <span className="spacer-x" />
            </>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Saving…" : screen ? "Save" : form.code ? "Connect" : "Add screen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConnectDialog({ o, screen, onClose, onDone }: { o: Overview; screen: Screen; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/signage/screens/${screen.id}/connect`, { body: { code } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={`Connect a TV to ${screen.name}`}>
      <h2>Connect a TV to {screen.name}</h2>
      <form onSubmit={submit} noValidate>
        <p className="muted">
          On the TV, open <strong className="tnum">{tvAddress(o)}</strong> in the browser. Enter the code it shows. A TV already on this screen keeps working.
        </p>
        <Field label="Code on the TV" required error={error}>
          {(p) => <input {...p} className="code-input tnum" inputMode="numeric" autoComplete="off" placeholder="123 456" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />}
        </Field>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || code.replace(/\D/g, "").length !== 6}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Confirm({
  title,
  body,
  action,
  danger,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} label={title}>
      <h2>{title}</h2>
      <p>{body}</p>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? "btn danger-solid" : "btn primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (err) {
              setError(errorText(err));
              setBusy(false);
            }
          }}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}

// Playlists

function Playlists({ o, onChanged }: { o: Overview; onChanged: () => void }) {
  const [naming, setNaming] = useState(false);
  return (
    <>
      <div className="head-actions">
        <p className="hint">A playlist is the slides a screen shows, in order. Several screens can show the same playlist.</p>
        <button type="button" className="btn primary" onClick={() => setNaming(true)}>
          <Icon name="plus" /> New playlist
        </button>
      </div>
      {!o.playlists.length ? (
        <EmptyState icon="list" title="No playlists yet">
          <p className="muted">Make one, add a few slides and pick it for your screens.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Playlists</caption>
            <thead>
              <tr>
                <th scope="col">Playlist</th>
                <th scope="col" className="num">
                  Slides
                </th>
                <th scope="col" className="num">
                  Screens
                </th>
                <th scope="col" className="hide-sm">
                  Changed
                </th>
              </tr>
            </thead>
            <tbody>
              {o.playlists.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a className="row-link" href={`#/screens/playlists/${p.id}`}>
                      {p.name}
                    </a>
                  </td>
                  <td className="num tnum">{p.slides}</td>
                  <td className="num tnum">{p.screens}</td>
                  <td className="hide-sm">{dateTime(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {naming && <NewPlaylist onClose={() => setNaming(false)} onCreated={onChanged} />}
    </>
  );
}

function NewPlaylist({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api<Playlist>("/signage/playlists", { body: { name, slides: [] } });
      onCreated();
      location.hash = `#/screens/playlists/${p.id}`;
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="New playlist">
      <h2>New playlist</h2>
      <form onSubmit={submit} noValidate>
        <Field label="Name" required hint="e.g. Main window, Ramadan, Bakery counter" error={error}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        </Field>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            Make playlist
          </button>
        </div>
      </form>
    </Modal>
  );
}

const blank = (kind: Kind): Slide => ({
  kind,
  duration: kind === "prices" ? 12 : kind === "video" ? 30 : 10,
  mediaId: null,
  categoryId: null,
  promotionId: null,
  title: null,
  titleAr: null,
  body: null,
  bodyAr: null,
  videoUrl: null,
  theme: kind === "promo" ? "offer" : kind === "prices" ? "dark" : "brand",
  startsOn: null,
  endsOn: null,
  days: null,
  startTime: null,
  endTime: null,
  active: true,
});

const scheduled = (s: Slide) => !!(s.startsOn || s.endsOn || s.days?.length || s.startTime || s.endTime);

function PlaylistEditor({ id, media, onChanged }: { id: string; media: Media[]; onChanged: () => void }) {
  const toast = useToast();
  const loaded = useLoad(
    () =>
      Promise.all([
        api<Playlist>(`/signage/playlists/${id}`),
        api<{ categories: Category[] }>("/categories"),
        api<{ promotions: Promotion[] }>("/promotions"),
      ]),
    [id],
  );
  const [name, setName] = useState("");
  const [slides, setSlides] = useState<Slide[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setName(loaded.data[0].name);
    setSlides(loaded.data[0].slides);
    setDirty(false);
  }, [loaded.data]);

  const change = (i: number, patch: Partial<Slide>) => {
    setSlides((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    setDirty(true);
  };
  const move = (i: number, by: number) => {
    setSlides((list) => {
      const next = [...list];
      const [s] = next.splice(i, 1);
      next.splice(i + by, 0, s!);
      return next;
    });
    setDirty(true);
  };
  const remove = (i: number) => {
    setSlides((list) => list.filter((_, j) => j !== i));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<Playlist>(`/signage/playlists/${id}`, { method: "PUT", body: { name, slides } });
      const now = await api<{ slides: unknown[] }>(`/signage/playlists/${id}/preview`).catch(() => null);
      setLiveNote(now ? `Saved. Screens pick it up within a minute. Showing now: ${now.slides.length} of ${slides.length} slides; the others are switched off, scheduled for another time or have nothing to show.` : "Saved.");
      toast("Playlist saved");
      setDirty(false);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loaded.error) return <div className="page"><ErrorState message={loaded.error} onRetry={loaded.reload} /></div>;
  if (!loaded.data)
    return (
      <div className="page">
        <SkeletonRows rows={6} />
      </div>
    );
  const [, { categories }, { promotions }] = loaded.data;

  return (
    <div className="page">
      <a className="back-link" href="#/screens/playlists">
        <Icon name="arrowLeft" /> Playlists
      </a>
      <header className="page-head">
        <div>
          <h1>{name || "Playlist"}</h1>
          <p className="muted">Slides play in this order, then start again.</p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn danger" onClick={() => setDeleting(true)}>
            <Icon name="trash" /> Delete
          </button>
          <button type="button" className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      <div className="panel">
        <Field label="Name" required>
          {(p) => (
            <input
              {...p}
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
          )}
        </Field>
      </div>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      {liveNote && !dirty && (
        <p className="callout" role="status">
          {liveNote}
        </p>
      )}
      <ol className="slides">
        {slides.map((s, i) => (
          <li key={s.id ?? `new-${i}`} className={`slide-card${s.active ? "" : " off"}`}>
            <SlideEditor
              n={i + 1}
              slide={s}
              first={i === 0}
              last={i === slides.length - 1}
              media={media}
              categories={categories}
              promotions={promotions}
              onChange={(patch) => change(i, patch)}
              onMove={(by) => move(i, by)}
              onRemove={() => remove(i)}
            />
          </li>
        ))}
      </ol>
      {!slides.length && <p className="muted">No slides yet. Add the first one.</p>}
      <div className="add-slides" role="group" aria-label="Add a slide">
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            className="btn"
            disabled={slides.length >= 50}
            onClick={() => {
              setSlides([...slides, blank(k)]);
              setDirty(true);
            }}
          >
            <Icon name={KINDS[k].icon} /> {KINDS[k].label}
          </button>
        ))}
      </div>
      {dirty && (
        <div className="save-bar">
          <span>You have changes that are not saved.</span>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save playlist"}
          </button>
        </div>
      )}
      {deleting && (
        <Confirm
          title={`Delete ${name}?`}
          body="Screens showing it go blank until you pick another playlist. Pictures stay under Pictures."
          action="Delete playlist"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/signage/playlists/${id}`, { method: "DELETE" });
            toast("Playlist deleted");
            onChanged();
            location.hash = "#/screens/playlists";
          }}
        />
      )}
    </div>
  );
}

function SlideEditor({
  n,
  slide: s,
  first,
  last,
  media,
  categories,
  promotions,
  onChange,
  onMove,
  onRemove,
}: {
  n: number;
  slide: Slide;
  first: boolean;
  last: boolean;
  media: Media[];
  categories: Category[];
  promotions: Promotion[];
  onChange: (patch: Partial<Slide>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const [when, setWhen] = useState(scheduled(s));
  const k = KINDS[s.kind];
  const txt = (key: keyof Slide) => (e: { target: { value: string } }) => onChange({ [key]: e.target.value || null });
  const label = `Slide ${n}, ${k.label}`;
  return (
    <fieldset className="plain-fieldset">
      <legend className="sr-only">{label}</legend>
      <div className="slide-head">
        <span className="slide-n tnum" aria-hidden="true">
          {n}
        </span>
        <Icon name={k.icon} />
        <strong>{k.label}</strong>
        {!s.active && <span className="badge">Off</span>}
        {scheduled(s) && <span className="badge">Scheduled</span>}
        <span className="spacer-x" />
        <button type="button" className="btn sm" disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${label} up`}>
          <Icon name="chevronUp" />
        </button>
        <button type="button" className="btn sm" disabled={last} onClick={() => onMove(1)} aria-label={`Move ${label} down`}>
          <Icon name="chevronDown" />
        </button>
        <button type="button" className="btn sm danger" onClick={onRemove} aria-label={`Remove ${label}`}>
          <Icon name="trash" />
        </button>
      </div>
      <p className="hint">{k.hint}</p>
      <div className="form-grid">
        {s.kind === "image" && (
          <Field label="Picture" required hint={media.length ? undefined : "Upload pictures under Screens → Pictures first."}>
            {(p) => (
              <select {...p} value={s.mediaId ?? ""} onChange={txt("mediaId")}>
                <option value="">Choose a picture</option>
                {media.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {s.kind === "image" && s.mediaId && <Thumb id={s.mediaId} />}
        {s.kind === "prices" && (
          <Field label="Products" hint="Up to 48, by name.">
            {(p) => (
              <select {...p} value={s.categoryId ?? ""} onChange={txt("categoryId")}>
                <option value="">Every category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {s.kind === "promo" && (
          <Field label="Offer" required>
            {(p) => (
              <select {...p} value={s.promotionId ?? ""} onChange={txt("promotionId")}>
                <option value="">Choose an offer</option>
                {promotions.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {s.kind === "video" && (
          <Field label="Video address" required hint="An MP4 or WebM file at an https:// address. Keep it short; it plays muted.">
            {(p) => <input {...p} type="url" dir="ltr" placeholder="https://" value={s.videoUrl ?? ""} onChange={txt("videoUrl")} maxLength={500} />}
          </Field>
        )}
        {(s.kind === "message" || s.kind === "prices" || s.kind === "promo") && (
          <>
            <Field label={s.kind === "message" ? "Title" : "Title (optional)"} hint={s.kind === "prices" ? "Leave empty to use the category's name." : s.kind === "promo" ? "Leave empty to use the offer's name." : undefined}>
              {(p) => <input {...p} value={s.title ?? ""} onChange={txt("title")} maxLength={120} />}
            </Field>
            <Field label="Title in Arabic">
              {(p) => <input {...p} dir="rtl" lang="ar" value={s.titleAr ?? ""} onChange={txt("titleAr")} maxLength={120} />}
            </Field>
          </>
        )}
        {s.kind === "message" && (
          <>
            <Field label="Message">
              {(p) => <textarea {...p} rows={3} value={s.body ?? ""} onChange={txt("body")} maxLength={600} />}
            </Field>
            <Field label="Message in Arabic">
              {(p) => <textarea {...p} rows={3} dir="rtl" lang="ar" value={s.bodyAr ?? ""} onChange={txt("bodyAr")} maxLength={600} />}
            </Field>
          </>
        )}
        {s.kind !== "image" && s.kind !== "video" && (
          <Field label="Colours">
            {(p) => (
              <select {...p} value={s.theme} onChange={(e) => onChange({ theme: e.target.value as Theme })}>
                {THEMES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={s.kind === "prices" ? "Seconds per page" : "Seconds on screen"}>
          {(p) => (
            <input
              {...p}
              type="number"
              inputMode="numeric"
              min={3}
              max={300}
              value={s.duration}
              onChange={(e) => onChange({ duration: Math.round(Number(e.target.value) || 0) })}
              className="tnum"
            />
          )}
        </Field>
      </div>
      <div className="slide-foot">
        <label className="check">
          <input type="checkbox" checked={s.active} onChange={(e) => onChange({ active: e.target.checked })} />
          <span>Show this slide</span>
        </label>
        <button type="button" className="btn sm" aria-expanded={when} onClick={() => setWhen(!when)}>
          <Icon name="calendar" /> {when ? "Hide times" : "Only at certain times"}
        </button>
      </div>
      {when && (
        <div className="when">
          <div className="form-grid">
            <Field label="From date">{(p) => <input {...p} type="date" value={s.startsOn ?? ""} onChange={txt("startsOn")} />}</Field>
            <Field label="Until date">{(p) => <input {...p} type="date" value={s.endsOn ?? ""} onChange={txt("endsOn")} />}</Field>
            <Field label="From time" hint="The store's time.">
              {(p) => <input {...p} type="time" value={s.startTime ?? ""} onChange={txt("startTime")} />}
            </Field>
            <Field label="Until time" hint="May run past midnight.">
              {(p) => <input {...p} type="time" value={s.endTime ?? ""} onChange={txt("endTime")} />}
            </Field>
          </div>
          <div className="chips" role="group" aria-label="Days">
            {DAYS.map((d, i) => {
              const on = !!s.days?.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() => {
                    const days = on ? (s.days ?? []).filter((x) => x !== i) : [...(s.days ?? []), i].sort();
                    onChange({ days: days.length ? days : null });
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <p className="hint">No days picked means every day.</p>
        </div>
      )}
    </fieldset>
  );
}

function Thumb({ id, alt = "" }: { id: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    blobUrl(`/signage/media/${id}`)
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  return <div className="thumb">{url ? <img src={url} alt={alt} /> : <Icon name="image" size={28} />}</div>;
}

// Pictures

function Pictures({ o, onChanged }: { o: Overview; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setBusy(true);
    let added = 0;
    for (const f of Array.from(files)) {
      if (f.size > o.maxPicture) {
        setError(`${f.name} is ${mb(f.size)}. Pictures can be up to ${mb(o.maxPicture)}; a 1920 × 1080 JPEG is plenty.`);
        continue;
      }
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error("The file could not be read"));
          r.readAsDataURL(f);
        });
        await api("/signage/media", { body: { name: f.name, data } });
        added++;
      } catch (err) {
        setError(`${f.name}: ${errorText(err)}`);
      }
    }
    setBusy(false);
    if (added) {
      toast(added === 1 ? "Picture added" : `${added} pictures added`);
      onChanged();
    }
  };

  return (
    <>
      <div className="head-actions">
        <p className="hint">PNG, JPEG, WebP or GIF, up to {mb(o.maxPicture)} each. Make them 1920 × 1080 for wide screens or 1080 × 1920 for tall ones.</p>
        <label className={`btn primary${busy ? " disabled" : ""}`}>
          <Icon name="upload" /> {busy ? "Uploading…" : "Upload pictures"}
          <input
            type="file"
            className="sr-only"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      {!o.media.length ? (
        <EmptyState icon="image" title="No pictures yet">
          <p className="muted">Upload posters and banners, then add them to a playlist as picture slides.</p>
        </EmptyState>
      ) : (
        <ul className="pictures">
          {o.media.map((m) => (
            <li key={m.id}>
              <Thumb id={m.id} alt={m.name} />
              <div className="picture-meta">
                <span className="clamp" title={m.name}>
                  {m.name}
                </span>
                <span className="cell-sub">
                  {mb(m.size)} · {m.uses ? `in ${m.uses} ${m.uses === 1 ? "slide" : "slides"}` : "not used"}
                </span>
              </div>
              <button
                type="button"
                className="btn sm danger"
                disabled={m.uses > 0}
                title={m.uses ? "Take it out of the playlists first" : undefined}
                aria-label={`Delete ${m.name}`}
                onClick={() => setDeleting(m)}
              >
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          body="This cannot be undone."
          action="Delete picture"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/signage/media/${deleting.id}`, { method: "DELETE" });
            toast("Picture deleted");
            setDeleting(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
