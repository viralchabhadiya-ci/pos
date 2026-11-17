import { dotsForWidth, needsRaster, packRaster, toBase64, type Align, type Block, type ReceiptDoc } from "@pos/escpos";
import { ARABIC_FONT, loadArabicFont } from "./fonts.js";

/**
 * Thermal printers' own fonts have no Arabic, so a receipt with Arabic text is drawn here
 * (the browser shapes and orders Arabic correctly) and sent as 1-bit pictures. Barcodes
 * and QR codes stay native commands: they print sharper and smaller that way.
 */

export interface TextStyle {
  size: number;
  bold: boolean;
}
export type Measure = (text: string, style: TextStyle) => number;

export type DrawOp =
  | { kind: "text"; text: string; x: number; baseline: number; align: Align; rtl: boolean; style: TextStyle }
  | { kind: "rule"; y: number; thickness: number };

export interface Layout {
  width: number;
  height: number;
  ops: DrawOp[];
}

export interface Painter {
  measure: Measure;
  /** Draws the layout black on white and returns its RGBA pixels. */
  paint(layout: Layout): Uint8ClampedArray;
}

const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const STRONG_LTR = /[A-Za-zÀ-ɏ]/;

/** Direction of a line from its first strong character, as the Unicode bidi rules do. */
export function isRtl(text: string): boolean {
  for (const ch of text) {
    if (STRONG_RTL.test(ch)) return true;
    if (STRONG_LTR.test(ch)) return false;
  }
  return false;
}

/** Word wrap by measured width; a word wider than the line is split by characters. */
export function wrapPx(text: string, max: number, style: TextStyle, measure: Measure): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, style) <= max) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    if (measure(word, style) <= max) {
      line = word;
      continue;
    }
    let part = "";
    for (const ch of word) {
      if (part && measure(part + ch, style) > max) {
        lines.push(part);
        part = "";
      }
      part += ch;
    }
    line = part;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Font sizes in dots for 80 mm paper (576 dots); 58 mm scales down. */
const BASE = { size: 24, double: 44, lineGap: 1.3 };

export function layoutBlocks(blocks: Block[], width: number, measure: Measure): Layout {
  const k = width / 576;
  const normal = Math.round(BASE.size * k);
  const lineHeight = (size: number) => Math.round(size * BASE.lineGap);
  const ops: DrawOp[] = [];
  let y = 0;
  const text = (t: string, align: Align, style: TextStyle) => {
    const rtl = isRtl(t);
    const x = align === "left" ? 0 : align === "right" ? width : width / 2;
    ops.push({ kind: "text", text: t, x, baseline: y + Math.round(style.size * 0.95), align, rtl, style });
  };

  for (const b of blocks) {
    switch (b.type) {
      case "text": {
        const style = { size: b.double ? Math.round(BASE.double * k) : normal, bold: !!b.bold };
        // Arabic lines start from the right unless the block asks otherwise.
        const align: Align = b.align ?? (isRtl(b.text) ? "right" : "left");
        for (const l of wrapPx(b.text, width, style, measure)) {
          text(l, align, style);
          y += lineHeight(style.size);
        }
        break;
      }
      case "row": {
        const style = { size: normal, bold: !!b.bold };
        const gap = Math.round(normal / 2);
        const rightWidth = b.right ? measure(b.right, style) : 0;
        const room = Math.max(width / 3, width - rightWidth - gap);
        const lefts = wrapPx(b.left, room, style, measure);
        lefts.forEach((l, i) => {
          text(l, "left", style);
          if (i === lefts.length - 1 && b.right) text(b.right, "right", style);
          y += lineHeight(normal);
        });
        break;
      }
      case "rule": {
        const h = lineHeight(normal);
        ops.push({ kind: "rule", y: y + Math.round(h / 2) - 1, thickness: 2 });
        y += h;
        break;
      }
      case "feed":
        y += lineHeight(normal) * (b.lines ?? 1);
        break;
      default:
        throw new Error(`layoutBlocks cannot draw ${b.type} blocks`);
    }
  }
  return { width, height: Math.max(1, Math.ceil(y)), ops };
}

const DRAWN = new Set<Block["type"]>(["text", "row", "rule", "feed"]);

/**
 * Turns a document's text into image blocks when it has characters the printer cannot
 * print; a plain-ASCII document is returned as it is (text mode is faster).
 */
export function rasterizeDoc(doc: ReceiptDoc, dots: number, painter: Painter): ReceiptDoc {
  if (!needsRaster(doc)) return doc;
  const width = Math.floor(dots / 8) * 8;
  const out: Block[] = [];
  let run: Block[] = [];
  const flush = () => {
    if (!run.length) return;
    const layout = layoutBlocks(run, width, painter.measure);
    const packed = packRaster(painter.paint(layout), layout.width, layout.height);
    out.push({ type: "image", width: packed.width, height: packed.height, data: toBase64(packed.bytes) });
    run = [];
  };
  for (const b of doc.blocks) {
    if (DRAWN.has(b.type)) run.push(b);
    else {
      flush();
      out.push(b);
    }
  }
  flush();
  return { ...doc, blocks: out };
}

const fontOf = (s: TextStyle) => `${s.bold ? 700 : 400} ${s.size}px "${ARABIC_FONT}", "Segoe UI", Tahoma, Arial, sans-serif`;

/** The browser painter: a canvas with the bundled Arabic font. */
export function canvasPainter(): Painter {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot draw receipts");
  const measure: Measure = (t, s) => {
    ctx.font = fontOf(s);
    return ctx.measureText(t).width;
  };
  return {
    measure,
    paint(layout) {
      canvas.width = layout.width;
      canvas.height = layout.height;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, layout.width, layout.height);
      ctx.fillStyle = "#000";
      ctx.textBaseline = "alphabetic";
      for (const op of layout.ops) {
        if (op.kind === "rule") {
          ctx.fillRect(0, op.y, layout.width, op.thickness);
          continue;
        }
        ctx.font = fontOf(op.style);
        ctx.direction = op.rtl ? "rtl" : "ltr";
        ctx.textAlign = op.align;
        ctx.fillText(op.text, op.x, op.baseline);
      }
      return ctx.getImageData(0, 0, layout.width, layout.height).data;
    },
  };
}

/** Rasterizes for a hub printer with `chars` characters per line (48 = 80 mm, 32 = 58 mm). */
export async function forPrinter(doc: ReceiptDoc, chars: number): Promise<ReceiptDoc> {
  if (!needsRaster(doc)) return doc;
  await loadArabicFont();
  return rasterizeDoc(doc, dotsForWidth(chars), canvasPainter());
}
