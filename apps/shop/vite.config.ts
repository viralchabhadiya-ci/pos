import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://localhost:3000";

// The customers' shop: one static app for every business, chosen by the address (#/<shop>).
export default defineConfig({
  plugins: [react()],
  // In development the API is reached through Vite, so the browser sees one origin.
  server: { port: 5177, proxy: { "/shop-api": api } },
  preview: { port: 5177, proxy: { "/shop-api": api } },
});
