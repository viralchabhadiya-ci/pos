import { useEffect, useState } from "react";
import { StatusBar } from "./components/StatusBar.js";
import { db, type DeviceSetup, type Session, type User } from "./lib/db.js";
import { useLang } from "./lib/i18n.js";
import { SETUP_CHANGED, startSync } from "./lib/sync.js";
import { currentSession, getSetup } from "./lib/till.js";
import { CloseShiftScreen } from "./screens/CloseShiftScreen.js";
import { KitchenScreen } from "./screens/KitchenScreen.js";
import { DisplayScreen } from "./screens/DisplayScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { MenuDialog } from "./screens/MenuDialog.js";
import { OpenShiftScreen } from "./screens/OpenShiftScreen.js";
import { PairScreen } from "./screens/PairScreen.js";
import { reconnectScale } from "./lib/scaleReader.js";
import { SellScreen } from "./screens/SellScreen.js";

/** Pair → PIN → open shift → sell → close shift. Every step works from local data. */
export function App() {
  // Every screen reads the language through t(); re-rendering from the root picks up a switch
  // without losing the cart or any other state.
  useLang();
  const [loaded, setLoaded] = useState(false);
  const [setup, setSetup] = useState<DeviceSetup | undefined>();
  const [user, setUser] = useState<User | undefined>();
  const [session, setSession] = useState<Session | undefined>();
  const [menu, setMenu] = useState(false);
  const [closing, setClosing] = useState(false);

  const reload = async () => {
    setSetup(await getSetup());
    setSession(await currentSession());
    setLoaded(true);
  };

  useEffect(() => {
    void reload();
    const refresh = () => void getSetup().then(setSetup);
    window.addEventListener(SETUP_CHANGED, refresh);
    return () => window.removeEventListener(SETUP_CHANGED, refresh);
  }, []);

  const isDisplay = setup?.device?.role === "display";
  const isKitchen = setup?.device?.role === "kitchen";
  // A till can open a second window (#display) on another screen for the customer.
  const secondWindow = window.location.hash === "#display";

  useEffect(() => {
    if (!setup || isDisplay || isKitchen || secondWindow) return;
    return startSync();
  }, [setup, isDisplay, isKitchen, secondWindow]);

  // A scale picked on this till before opens again by itself.
  useEffect(() => {
    if (setup && !isDisplay && !isKitchen && !secondWindow) void reconnectScale();
  }, [setup, isDisplay, isKitchen, secondWindow]);

  if (!loaded) return null;
  if (!setup) return <PairScreen onPaired={reload} />;
  if (isKitchen) return <KitchenScreen setup={setup} />;
  if (isDisplay || secondWindow) return <DisplayScreen setup={setup} remote={isDisplay} />;

  const bar = <StatusBar setup={setup} user={user} session={session} onMenu={user && session ? () => setMenu(true) : undefined} />;
  const logout = () => {
    setMenu(false);
    setUser(undefined);
  };

  let body;
  if (!user) body = <LoginScreen onLogin={setUser} />;
  else if (!session || session.state !== "open") body = <OpenShiftScreen user={user} onOpened={setSession} onLogout={logout} />;
  else if (closing)
    body = (
      <CloseShiftScreen
        setup={setup}
        session={session}
        user={user}
        onCancel={() => setClosing(false)}
        onClosed={async () => {
          setClosing(false);
          setSession(undefined);
          setUser(undefined);
          await db.setMeta("currentSessionId", null);
        }}
      />
    );
  else body = <SellScreen setup={setup} user={user} session={session} onMenu={() => setMenu(true)} />;

  return (
    <div className="app">
      {bar}
      {body}
      {menu && user && session && (
        <MenuDialog
          setup={setup}
          session={session}
          user={user}
          onClose={() => setMenu(false)}
          onLogout={logout}
          onCloseShift={() => {
            setMenu(false);
            setClosing(true);
          }}
        />
      )}
    </div>
  );
}
