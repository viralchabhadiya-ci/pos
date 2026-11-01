import type { PrinterConfig } from "./printer.js";

export interface HubConfig {
  cloudUrl: string;
  port: number;
  host: string;
  dataDir: string;
  printer: PrinterConfig | null;
  flushIntervalMs: number;
  catalogIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const cloudUrl = env.CLOUD_URL;
  if (!cloudUrl) throw new Error("CLOUD_URL is required, e.g. https://api.example.com");
  return {
    cloudUrl,
    port: Number(env.PORT ?? 4100),
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "./data",
    printer: env.PRINTER_HOST
      ? { host: env.PRINTER_HOST, port: Number(env.PRINTER_PORT ?? 9100), width: Number(env.PRINTER_WIDTH ?? 48) }
      : null,
    flushIntervalMs: Number(env.FLUSH_INTERVAL_MS ?? 5_000),
    catalogIntervalMs: Number(env.CATALOG_INTERVAL_MS ?? 60_000),
  };
}
