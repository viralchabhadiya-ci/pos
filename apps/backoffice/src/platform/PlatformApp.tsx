import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon, type IconName } from "../components/Icon.js";
import { errorText, getPlatformToken, platformApi, setPlatformToken, whenPlatformSignedOut } from "../lib/api.js";
import { useRoute } from "../lib/router.js";
import { Activity, Overview, Plans, Team, TenantDetail, Tenants } from "./pages.js";

export interface PlatformMe {
  user: { id: string; name: string; role: "admin" | "support" };
}

const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: "", label: "Overview", icon: "dashboard" },
  { path: "businesses", label: "Businesses", icon: "box" },
  { path: "plans", label: "Plans", icon: "tag" },
  { path: "team", label: "Team", icon: "users" },
  { path: "activity", label: "Activity", icon: "history" },
];

/**
 * The platform console at #/platform, for the operator's own staff: every business on the
 * platform, their plans and trials, support sign-in, and system health. It has its own
 * sign-in, separate from any business's back office.
 */
export function PlatformApp() {
  const [me, setMe] = useState<PlatformMe | null>(null);
  const [checking, setChecking] = useState(!!getPlatformToken());
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute().slice(1);
  const main = useRef<HTMLElement>(null);

  const loadMe = useCallback(async () => {
    try {
      setMe(await platformApi<PlatformMe>("/me"));
    } catch {
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    whenPlatformSignedOut(() => setMe(null));
    if (getPlatformToken()) void loadMe();
  }, [loadMe]);

  const page = route[0] ?? "";
  useEffect(() => {
    setMenuOpen(false);
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [page, route[1]]);

  useEffect(() => {
    document.title = "Platform console";
  }, []);

  const signOut = async () => {
    await platformApi("/logout", { method: "POST", body: {} }).catch(() => {});
    setPlatformToken(null);
    setMe(null);
  };

  if (checking) return <div className="boot" aria-busy="true" />;
  if (!me) {
    return (
      <PlatformLogin
        onSignedIn={(token) => {
          setPlatformToken(token);
          setChecking(true);
          void loadMe();
        }}
      />
    );
  }

  const content = (() => {
    switch (page) {
      case "businesses":
        return route[1] ? <TenantDetail id={route[1]} me={me} /> : <Tenants />;
      case "plans":
        return <Plans me={me} />;
      case "team":
        return <Team me={me} />;
      case "activity":
        return <Activity />;
      default:
        return <Overview />;
    }
  })();

  return (
    <div className="shell platform">
      <a href="#main" className="skip-link" onClick={(e) => (e.preventDefault(), main.current?.focus())}>
        Skip to content
      </a>
      <header className="topbar">
        <button
          type="button"
          className="icon-btn nav-toggle"
          aria-expanded={menuOpen}
          aria-controls="sidenav"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
        >
          <Icon name={menuOpen ? "close" : "menu"} />
        </button>
        <span className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span className="brand-name">Platform console</span>
        </span>
      </header>
      <nav id="sidenav" className={menuOpen ? "sidenav open" : "sidenav"} aria-label="Platform">
        <div className="brand side-brand">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <span>
            <strong className="brand-name">Platform console</strong>
            <span className="muted small">All businesses</span>
          </span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.path}>
              <a href={`#/platform${n.path ? `/${n.path}` : ""}`} aria-current={page === n.path ? "page" : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="side-foot">
          <div className="who">
            <strong>{me.user.name}</strong>
            <span className="muted small">{me.user.role === "admin" ? "Platform admin" : "Support"}</span>
          </div>
          <button type="button" className="btn ghost block-left" onClick={signOut}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </nav>
      {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} role="presentation" />}
      <main id="main" ref={main} tabIndex={-1}>
        {content}
      </main>
    </div>
  );
}

function PlatformLogin({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn((await platformApi<{ token: string }>("/login", { body: { email, password } })).token);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={48} height={48} />
        <h1>Platform console</h1>
        <p className="muted">For platform staff only. Shop owners sign in to the back office.</p>
        <Field label="Email" required>
          {(p) => <input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
        </Field>
        <Field label="Password" required>
          {(p) => <input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <button type="submit" className="btn primary block" disabled={busy || !email || !password}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
