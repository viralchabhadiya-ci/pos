import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon.js";
import { api, getToken, setToken, whenSignedOut } from "./lib/api.js";
import { useRoute } from "./lib/router.js";
import type { Me } from "./lib/types.js";
import { Accounting } from "./pages/Accounting.js";
import { Audit } from "./pages/Audit.js";
import { Categories } from "./pages/Categories.js";
import { Customers } from "./pages/Customers.js";
import { Dashboard } from "./pages/Dashboard.js";
import { EInvoicing } from "./pages/EInvoicing.js";
import { Devices } from "./pages/Devices.js";
import { Login } from "./pages/Login.js";
import { Loyalty } from "./pages/Loyalty.js";
import { Signup } from "./pages/Signup.js";
import { AccountBanner } from "./components/AccountBanner.js";
import { OrderDetail } from "./pages/OrderDetail.js";
import { PriceLists } from "./pages/PriceLists.js";
import { Promotions } from "./pages/Promotions.js";
import { Products } from "./pages/Products.js";
import { Reports } from "./pages/Reports.js";
import { Sales } from "./pages/Sales.js";
import { Settings } from "./pages/Settings.js";
import { Staff } from "./pages/Staff.js";
import { Inventory } from "./pages/inventory/Inventory.js";
import { Labels } from "./pages/Labels.js";
import { Stores } from "./pages/Stores.js";
import { Developers } from "./pages/Developers.js";

/** hq: head office only. A store manager (limited to some stores) does not see these. */
const NAV: { path: string; label: string; icon: IconName; hq?: boolean; multi?: boolean }[] = [
  { path: "dashboard", label: "Dashboard", icon: "dashboard" },
  { path: "stores", label: "Stores", icon: "store", multi: true },
  { path: "sales", label: "Sales", icon: "receipt" },
  { path: "reports", label: "Reports", icon: "chart" },
  { path: "accounting", label: "Accounting", icon: "book", hq: true },
  { path: "einvoicing", label: "E-invoicing", icon: "send", hq: true },
  { path: "products", label: "Products", icon: "box" },
  { path: "inventory", label: "Inventory", icon: "stock" },
  { path: "categories", label: "Categories", icon: "tag", hq: true },
  { path: "promotions", label: "Promotions", icon: "percent", hq: true },
  { path: "price-lists", label: "Price lists", icon: "list", hq: true },
  { path: "labels", label: "Scales & labels", icon: "printer" },
  { path: "loyalty", label: "Loyalty & gift cards", icon: "gift", hq: true },
  { path: "customers", label: "Customers", icon: "user" },
  { path: "staff", label: "Staff", icon: "users" },
  { path: "devices", label: "Tills & devices", icon: "monitor" },
  { path: "audit", label: "Audit log", icon: "history", hq: true },
  { path: "developers", label: "Developers", icon: "key", hq: true },
  { path: "settings", label: "Settings", icon: "settings" },
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
  }, [page, route[1], route[2]]);

  const signOut = async () => {
    await api("/logout", { method: "POST", body: {} }).catch(() => {});
    setToken(null);
    setMe(null);
  };

  if (checking) return <div className="boot" aria-busy="true" />;
  if (!me) {
    const signedIn = (token: string) => {
      setToken(token);
      setChecking(true);
      void loadMe();
    };
    if (page === "signup") return <Signup onSignedIn={signedIn} />;
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
      case "reports":
        return <Reports me={me} />;
      case "accounting":
        return <Accounting me={me} tab={route[1]} />;
      case "einvoicing":
        return <EInvoicing me={me} tab={route[1]} />;
      case "products":
        // Keyed so the dashboard's "low stock" link resets the filter.
        return <Products key={route[1] ?? ""} me={me} initialStatus={route[1]} />;
      case "inventory":
        return <Inventory me={me} route={route.slice(1)} />;
      case "customers":
        return <Customers me={me} />;
      case "labels":
        return <Labels me={me} />;
      case "loyalty":
        return <Loyalty me={me} cardId={route[1] === "cards" ? route[2] : undefined} />;
      case "developers":
        return <Developers me={me} route={route.slice(1)} />;
      case "audit":
        return <Audit />;
      case "settings":
        return <Settings me={me} onAccountChanged={loadMe} />;
      case "categories":
        return <Categories />;
      case "promotions":
        return <Promotions />;
      case "price-lists":
        return <PriceLists key={route[1] ?? ""} id={route[1]} />;
      case "staff":
        return <Staff me={me} />;
      case "devices":
        return <Devices me={me} />;
      case "stores":
        return <Stores me={me} tab={route[1]} />;
      default:
        return <Dashboard key={route[1] ?? ""} me={me} storeId={page === "dashboard" ? route[1] : undefined} />;
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
          {NAV.filter((n) => (!n.hq || me.user.storeIds === null) && (!n.multi || me.stores.length > 1)).map((n) => (
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
            <span className="muted small">
              {me.user.role === "owner"
                ? "Owner"
                : me.user.storeIds
                  ? `Store manager · ${me.stores.length === 1 ? me.stores[0]!.name : `${me.stores.length} stores`}`
                  : "Manager"}
            </span>
          </div>
          <button type="button" className="btn ghost block-left" onClick={signOut}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </nav>
      {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} role="presentation" />}
      <main id="main" ref={main} tabIndex={-1}>
        <AccountBanner me={me} onEndSupport={signOut} />
        {content}
      </main>
    </div>
  );
}
