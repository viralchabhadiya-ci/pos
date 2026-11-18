import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Installable on the owner's phone; the shell loads offline and shows the last numbers it had.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "POS Owner",
        short_name: "Owner",
        description: "Live sales, alerts and approvals for your shops",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        background_color: "#f3f5f4",
        theme_color: "#0b6158",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/admin\//],
        globPatterns: ["**/*.{js,css,html,svg}"],
        importScripts: ["sw-notify.js"],
      },
    }),
  ],
  // In development the API is reached through Vite, so the browser sees one origin.
  server: { port: 5175, proxy: { "/admin": process.env.API_URL ?? "http://localhost:3000" } },
  preview: { port: 5175, proxy: { "/admin": process.env.API_URL ?? "http://localhost:3000" } },
});
