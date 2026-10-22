import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // The service worker caches the app shell so the till reloads with no internet.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "POS Till",
        short_name: "Till",
        display: "fullscreen",
        orientation: "landscape",
        background_color: "#f4f6f5",
        theme_color: "#0d6b63",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      workbox: { navigateFallback: "/index.html", globPatterns: ["**/*.{js,css,html,svg,woff2}"] },
    }),
  ],
  server: { port: 5173 },
});
