import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Installs to a staff phone's home screen; the shell opens without signal, the checks need it.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "POS Staff",
        short_name: "Staff",
        description: "Price check, stock counts, deliveries and labels on the shop floor",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        background_color: "#f3f5f4",
        theme_color: "#0b6158",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/staff\//, /^\/pairing\//],
        globPatterns: ["**/*.{js,css,html,svg,wasm}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  // In development the API is reached through Vite, so the browser sees one origin.
  server: { port: 5176, proxy: { "/staff": process.env.API_URL ?? "http://localhost:3000", "/pairing": process.env.API_URL ?? "http://localhost:3000" } },
  preview: { port: 5176, proxy: { "/staff": process.env.API_URL ?? "http://localhost:3000", "/pairing": process.env.API_URL ?? "http://localhost:3000" } },
});
