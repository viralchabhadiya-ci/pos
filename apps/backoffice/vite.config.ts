import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // In development the API is reached through Vite, so the browser sees one origin.
  server: { port: 5174, proxy: { "/admin": process.env.API_URL ?? "http://localhost:3000" } },
});
