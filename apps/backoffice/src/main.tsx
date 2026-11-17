import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ToastProvider } from "./components/Toast.js";
import { useRoute } from "./lib/router.js";
import { PlatformApp } from "./platform/PlatformApp.js";
import "./styles.css";

/** #/platform is the operator's console; everything else is a business's back office. */
function Root() {
  const route = useRoute();
  return route[0] === "platform" ? <PlatformApp /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>,
);
