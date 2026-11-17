/**
 * A printer-neutral receipt document and its ESC/POS encoding for 80 mm and 58 mm
 * thermal printers. The till builds the document; the store hub encodes and sends it.
 */

export type Align = "left" | "center" | "right";

export type Block =
  | { type: "text"; text: string; align?: Align; bold?: boolean; double?: boolean }
  | { type: "row"; left: string; right: string; bold?: boolean }
  | { type: "rule" }
  | { type: "feed"; lines?: number }
  | { type: "barcode"; data: string }
  | { type: "qr"; data: string }
  /**
   * A 1-bit picture: rows of `width / 8` bytes, most significant bit on the left, 1 = black,
   * base64 encoded. Text in scripts the printer fonts lack (Arabic) is drawn by the till
   * and sent this way. `width` is a multiple of 8, at most the paper's dot width.
   */
  | { type: "image"; width: number; height: number; data: string };

export interface ReceiptDoc {
  blocks: Block[];
  /** Cut the paper at the end (default true). */
  cut?: boolean;
  /** Open the cash drawer after printing. */
  openDrawer?: boolean;
}

export interface EncodeOptions {
  /** Characters per line in the normal font: 48 for 80 mm, 32 for 58 mm. */
  width?: number;
}

const ESC = 0x1b;
const GS = 0x1d;

export const commands = {
  init: [ESC, 0x40],
  alignLeft: [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  alignRight: [ESC, 0x61, 2],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  doubleOn: [GS, 0x21, 0x11],
  doubleOff: [GS, 0x21, 0x00],
  /** Feed 3 lines, then partial cut. */
  cut: [GS, 0x56, 0x42, 3],
  /** Pulse drawer pin 2: on 50 ms, off 500 ms. */
  drawer: [ESC, 0x70, 0, 25, 250],
} as const;

/**
 * Thermal printers' built-in fonts are single-byte. Characters outside printable ASCII
 * (Arabic, accents) are replaced with "?" here. Documents with Arabic reach the printer
 * as "image" blocks instead: the till draws that text and sends the picture.
 */
export function toPrinterText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize("NFKD")) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) out.push(code);
    else if (code >= 0x300 && code <= 0x36f) continue; // combining accents dropped
    else if (ch === "\n") out.push(0x0a);
    else out.push(0x3f);
  }
  return out;
}

/** True when a document has text the printer's built-in fonts cannot print. */
export function needsRaster(doc: ReceiptDoc): boolean {
  const nonAscii = /[^\x20-\x7e]/;
  return doc.blocks.some((b) =>
    b.type === "text" ? nonAscii.test(b.text) : b.type === "row" ? nonAscii.test(b.left) || nonAscii.test(b.right) : false,
  );
}

/** Paper width in printer dots for a characters-per-line setting: 576 on 80 mm, 384 on 58 mm. */
export function dotsForWidth(chars: number): number {
  return chars >= 42 ? 576 : 384;
}

/**
 * Packs RGBA pixels (as from a canvas) into 1-bit rows. A pixel prints black when it is
 * darker than `threshold` (0-255); transparent pixels count as white paper.
 */
export function packRaster(rgba: ArrayLike<number>, width: number, height: number, threshold = 140): { width: number; height: number; bytes: Uint8Array } {
  const stride = Math.ceil(width / 8);
  const bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3]! / 255;
      const lum = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * alpha + 255 * (1 - alpha);
      if (lum < threshold) bytes[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width: stride * 8, height, bytes };
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Rows per GS v 0 command; printers with small buffers choke on one huge image. */
export const RASTER_BAND = 128;

/** GS v 0 (print raster bit image), split into bands of RASTER_BAND rows. */
export function rasterBytes(width: number, height: number, bytes: Uint8Array): number[] {
  const stride = width / 8;
  if (!Number.isInteger(stride) || stride < 1) throw new Error("Image width must be a multiple of 8");
  if (bytes.length !== stride * height) throw new Error(`Image data is ${bytes.length} bytes, expected ${stride * height}`);
  const out: number[] = [];
  for (let y = 0; y < height; y += RASTER_BAND) {
    const rows = Math.min(RASTER_BAND, height - y);
    out.push(GS, 0x76, 0x30, 0, stride & 0xff, stride >> 8, rows & 0xff, rows >> 8);
    const band = bytes.subarray(y * stride, (y + rows) * stride);
    for (let i = 0; i < band.length; i += 1) out.push(band[i]!);
  }
  return out;
}

/** Keeps only the ASCII part of a bilingual label such as "Total AED / الإجمالي". */
export function asciiPart(text: string): string {
  if (/^[\x00-\x7f]*$/.test(text)) return text;
  const cleaned = text
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && [...s].every((c) => c.charCodeAt(0) < 0x7f));
  return cleaned.length ? cleaned.join(" / ") : text;
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (word.length > width) {
      if (line) lines.push(line);
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      line = "";
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Left text and right-aligned amount on one line; the left side wraps if needed. */
export function row(left: string, right: string, width: number): string[] {
  const room = width - right.length - 1;
  const lefts = wrap(left, Math.max(8, room));
  const last = lefts.pop()!;
  const pad = Math.max(1, width - last.length - right.length);
  return [...lefts, `${last}${" ".repeat(pad)}${right}`];
}

function qrBytes(data: string): number[] {
  const bytes = toPrinterText(data);
  const len = bytes.length + 3;
  return [
    GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00, // model 2
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 0x06, // module size 6
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31, // error correction M
    GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...bytes, // store
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, // print
  ];
}

function barcodeBytes(data: string): number[] {
  const bytes = toPrinterText(data);
  // CODE128 with code set B prefix.
  const payload = [0x7b, 0x42, ...bytes];
  return [GS, 0x68, 80, GS, 0x77, 2, GS, 0x48, 2, GS, 0x6b, 73, payload.length, ...payload];
}

export function encodeReceipt(doc: ReceiptDoc, opts: EncodeOptions = {}): Uint8Array {
  const width = opts.width ?? 48;
  const out: number[] = [...commands.init];
  const line = (text: string) => out.push(...toPrinterText(text), 0x0a);

  for (const b of doc.blocks) {
    switch (b.type) {
      case "text": {
        out.push(...(b.align === "center" ? commands.alignCenter : b.align === "right" ? commands.alignRight : commands.alignLeft));
        if (b.bold) out.push(...commands.boldOn);
        if (b.double) out.push(...commands.doubleOn);
        for (const l of wrap(asciiPart(b.text), b.double ? Math.floor(width / 2) : width)) line(l);
        if (b.double) out.push(...commands.doubleOff);
        if (b.bold) out.push(...commands.boldOff);
        out.push(...commands.alignLeft);
        break;
      }
      case "row":
        if (b.bold) out.push(...commands.boldOn);
        for (const l of row(asciiPart(b.left), asciiPart(b.right), width)) line(l);
        if (b.bold) out.push(...commands.boldOff);
        break;
      case "rule":
        line("-".repeat(width));
        break;
      case "feed":
        for (let i = 0; i < (b.lines ?? 1); i++) out.push(0x0a);
        break;
      case "qr":
        out.push(...commands.alignCenter, ...qrBytes(b.data), 0x0a, ...commands.alignLeft);
        break;
      case "image":
        out.push(...commands.alignCenter, ...rasterBytes(b.width, b.height, fromBase64(b.data)), ...commands.alignLeft);
        break;
      case "barcode":
        out.push(...commands.alignCenter, ...barcodeBytes(b.data), 0x0a, ...commands.alignLeft);
        break;
    }
  }
  if (doc.cut !== false) out.push(...commands.cut);
  if (doc.openDrawer) out.push(...commands.drawer);
  return Uint8Array.from(out);
}

export function encodeDrawerKick(): Uint8Array {
  return Uint8Array.from([...commands.init, ...commands.drawer]);
}
