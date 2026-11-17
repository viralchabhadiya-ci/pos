import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadArabicFont } from "./lib/fonts.js";
import "./styles.css";

// Arabic text (product names, the Arabic UI, printed receipts) uses the bundled font.
void loadArabicFont();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
