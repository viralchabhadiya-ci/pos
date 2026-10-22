import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon.js";
import { api, getToken, setToken, whenSignedOut } from "./lib/api.js";
import { useRoute } from "./lib/router.js";
import type { Me } from "./lib/types.js";
import { Categories } from "./pages/Categories.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Devices } from "./pages/Devices.js";
import { Login } from "./pages/Login.js";
import { OrderDetail } from "./pages/OrderDetail.js";
import { Products } from "./pages/Products.js";
import { Sales } from "./pages/Sales.js";
import { Staff } from "./pages/Staff.js";

const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: "dashboard", label: "Dashboard", icon: "dashboard" },
  { path: "sales", label: "Sales", icon: "receipt" },
  { path: "products", label: "Products", icon: "box" },
  { path: "categories", label: "Categories", icon: "tag" },
  { path: "staff", label: "Staff", icon: "users" },
  { path: "devices", label: "Tills & devices", icon: "monitor" },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();
  const main = useRef<HTMLElement>(null);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
    } catch {
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    whenSignedOut(() => setMe(null));
    if (getToken()) void loadMe();
  }, [loadMe]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const page = route[0] ?? "dashboard";
  useEffect(() => {
    setMenuOpen(false);
    // A new page is announced by moving focus to its content, not left on the old link.
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [page, route[1]]);

  const signOut = async () => {
    await api("/logout", { method: "POST", body: {} }).catch(() => {});
    setToken(null);
    setMe(null);
  };

  if (checking) return <div className="boot" aria-busy="true" />;
  if (!me) {
    return (
      <Login
        onSignedIn={(token) => {
          setToken(token);
          setChecking(true);
          void loadMe();
        }}
      />
    );
  }

  const content = (() => {
    switch (page) {
      case "sales":
        return route[1] ? <OrderDetail id={route[1]} /> : <Sales />;
      case "products":
        return <Products me={me} />;
      case "categories":
        return <Categories />;
      case "staff":
        return <Staff me={me} />;
      case "devices":
        return <Devices me={me} />;
      default:
        return <Dashboard me={me} />;
    }
  })();

  return (
    <div className="shell">
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
          <span className="brand-name">{me.tenant.name}</span>
        </span>
      </header>
      <nav id="sidenav" className={menuOpen ? "sidenav open" : "sidenav"} aria-label="Main">
        <div className="brand side-brand">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <span>
            <strong className="brand-name">{me.tenant.name}</strong>
            <span className="muted small">Back office</span>
          </span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.path}>
              <a href={`#/${n.path}`} aria-current={page === n.path || (page === "" && n.path === "dashboard") ? "page" : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="side-foot">
          <div className="who">
            <strong>{me.user.name}</strong>
            <span className="muted small">{me.user.role === "owner" ? "Owner" : "Manager"}</span>
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
