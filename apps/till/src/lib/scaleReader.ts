import { useSyncExternalStore } from "react";

/**
 * A scale on the till PC's serial or USB port, read through the browser (Web Serial, in Chrome
 * and Edge). Most retail scales (CAS, DIGI, Dibal, Mettler Toledo, Bizerba and their copies)
 * send the weight as a line of text, either all the time or when asked, e.g.
 *   ST,GS,+  1.234kg     (steady, gross)        US,GS,+  1.230kg   (still moving)
 *   S S     1.234 kg     (Mettler SICS, steady) 1234 g
 */

export interface ScaleReading {
  kg: number;
  /** False while the weight is still settling. */
  stable: boolean;
}

/** Reads one line from a scale. Null when it holds no weight in kg or g (e.g. lb, or an error code). */
export function parseScaleReading(line: string): ScaleReading | null {
  const text = line.replace(/[\x00-\x1f]/g, " ").trim();
  const m = /([+-]?)\s*(\d+(?:\.\d+)?)\s*(kg|g|lb|oz)?\s*$/i.exec(text) ?? /([+-]?)\s*(\d+(?:\.\d+)?)\s*(kg|g|lb|oz)\b/i.exec(text);
  if (!m) return null;
  const unit = (m[3] ?? "kg").toLowerCase();
  if (unit === "lb" || unit === "oz") return null;
  let kg = Number(m[2]) * (unit === "g" ? 0.001 : 1);
  if (m[1] === "-") kg = -kg;
  kg = Math.round(kg * 1000) / 1000;
  const unstable = /^(US|SD)\b|^S\s+D\b|\bmotion\b|\?/i.test(text);
  return { kg: Math.max(0, kg), stable: !unstable && kg >= 0 };
}

/** Bytes some scales want before they answer with the weight. */
export const SCALE_REQUESTS = {
  none: "",
  W: "W\r\n",
  ENQ: "\x05",
  P: "P\r\n",
} as const;
export type ScaleRequest = keyof typeof SCALE_REQUESTS;

export interface ScaleConfig {
  baudRate: number;
  request: ScaleRequest;
}

const CONFIG_KEY = "till.scale";
const DEFAULT_CONFIG: ScaleConfig = { baudRate: 9600, request: "none" };

export function getScaleConfig(): ScaleConfig {
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as Partial<ScaleConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveScaleConfig(c: ScaleConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    // Private window: the scale still works until the page reloads.
  }
}

/** Splits a stream of text from the scale into lines and hands each reading on. */
export async function readScaleLines(stream: ReadableStream<string>, onReading: (r: ScaleReading) => void, signal?: AbortSignal) {
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel);
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const parts = buffer.split(/[\r\n]+/);
      buffer = parts.pop() ?? "";
      for (const p of parts) {
        const r = parseScaleReading(p);
        if (r) onReading(r);
      }
      // A scale that never ends its line: read what is there once it looks complete.
      if (buffer.length > 64) {
        const r = parseScaleReading(buffer);
        buffer = "";
        if (r) onReading(r);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

// --- The connection, shared by the whole till ---------------------------------------------

/** The parts of Web Serial used here, so the code type-checks without DOM serial types. */
interface Port {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface Serial {
  requestPort(): Promise<Port>;
  getPorts(): Promise<Port[]>;
}

export type ScaleStatus = "unsupported" | "off" | "connecting" | "on" | "error";
interface State {
  status: ScaleStatus;
  reading: ScaleReading | null;
  /** When the last reading came in, so an old weight is not used. */
  at: number;
  error: string | null;
}

const serial = (): Serial | undefined => (globalThis.navigator as unknown as { serial?: Serial } | undefined)?.serial;
let state: State = { status: serial() ? "off" : "unsupported", reading: null, at: 0, error: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

let port: Port | null = null;
let stop: AbortController | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
/** Settles once nothing reads from the port any more, so it can be closed. */
let reading: Promise<unknown> = Promise.resolve();

async function start(p: Port, config: ScaleConfig) {
  set({ status: "connecting", error: null });
  try {
    await p.open({ baudRate: config.baudRate });
  } catch (err) {
    set({ status: "error", error: (err as Error).message });
    return;
  }
  port = p;
  const abort = new AbortController();
  stop = abort;
  set({ status: "on" });
  const request = SCALE_REQUESTS[config.request];
  if (request && p.writable) {
    const w = p.writable.getWriter();
    writer = w;
    const bytes = new TextEncoder().encode(request);
    poll = setInterval(() => void w.write(bytes).catch(() => {}), 400);
  }
  const decoder = new TextDecoderStream();
  const piped = p.readable!.pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
  const loop = readScaleLines(decoder.readable, (r) => set({ reading: r, at: Date.now() }), abort.signal)
    .catch((err: Error) => {
      if (!abort.signal.aborted) set({ status: "error", error: err.message });
    })
    .finally(() => {
      if (!abort.signal.aborted && state.status === "on") set({ status: "off", reading: null });
    });
  reading = Promise.all([loop, piped]);
}

/** Asks the cashier to pick the scale's port (the browser shows its own list), then reads it. */
export async function connectScale(config: ScaleConfig) {
  const s = serial();
  if (!s) return;
  await disconnectScale();
  saveScaleConfig(config);
  try {
    await start(await s.requestPort(), config);
  } catch (err) {
    // Closing the browser's list without picking is not an error worth showing.
    if ((err as Error).name !== "NotFoundError") set({ status: "error", error: (err as Error).message });
  }
}

/** Opens the scale picked before, without asking, when the till starts. */
export async function reconnectScale() {
  const s = serial();
  if (!s || port) return;
  const [known] = await s.getPorts().catch(() => [] as Port[]);
  if (known) await start(known, getScaleConfig());
}

export async function disconnectScale() {
  if (poll) clearInterval(poll);
  poll = null;
  stop?.abort();
  stop = null;
  const p = port;
  port = null;
  set({ status: serial() ? "off" : "unsupported", reading: null });
  if (!p) return;
  // Web Serial only closes a port once its streams are let go.
  await reading;
  writer?.releaseLock();
  writer = null;
  await p.close().catch(() => {});
}

export const getScaleState = (): State => state;

/** The scale's state; a reading older than two seconds counts as none. */
export function useScale(): State {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  return s.reading && Date.now() - s.at > 2000 ? { ...s, reading: null } : s;
}
