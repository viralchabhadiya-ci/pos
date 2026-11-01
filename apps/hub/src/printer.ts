import { connect } from "node:net";

export interface PrinterConfig {
  host: string;
  port: number;
  width: number;
}

/**
 * Sends raw bytes to a network printer (port 9100, "raw" or "JetDirect" mode), the way
 * almost every Epson, Star, Xprinter and Rongta Ethernet model accepts ESC/POS.
 */
export function sendToPrinter(cfg: PrinterConfig, bytes: Uint8Array, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: cfg.host, port: cfg.port });
    let failed = false;
    socket.setTimeout(timeoutMs, () => {
      failed = true;
      socket.destroy();
      reject(new Error(`Printer at ${cfg.host}:${cfg.port} did not respond`));
    });
    socket.once("error", (err) => {
      failed = true;
      socket.destroy();
      reject(err);
    });
    socket.once("connect", () => {
      socket.end(Buffer.from(bytes));
    });
    socket.once("close", () => {
      if (!failed) resolve();
    });
  });
}
