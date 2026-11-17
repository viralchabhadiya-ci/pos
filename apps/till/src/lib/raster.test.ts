import { fromBase64, type ReceiptDoc } from "@pos/escpos";
import { describe, expect, it } from "vitest";
import { isRtl, layoutBlocks, rasterizeDoc, wrapPx, type Layout, type Measure, type Painter } from "./raster.js";

/** Every character is half the font size wide. */
const measure: Measure = (t, s) => [...t].length * (s.size / 2);
const style = { size: 24, bold: false };

describe("raster layout", () => {
  it("finds the base direction from the first strong character", () => {
    expect(isRtl("الإجمالي")).toBe(true);
    expect(isRtl("Total AED / الإجمالي")).toBe(false);
    expect(isRtl("12.50 درهم")).toBe(true);
    expect(isRtl("12.50")).toBe(false);
  });

  it("wraps by measured width and splits words wider than the line", () => {
    expect(wrapPx("aaaa bbbb cccc", 120, style, measure)).toEqual(["aaaa bbbb", "cccc"]);
    expect(wrapPx("abcdefghij", 60, style, measure)).toEqual(["abcde", "fghij"]);
    expect(wrapPx("", 60, style, measure)).toEqual([""]);
  });

  it("puts Arabic text on the right, amounts on the right, and wraps long row labels", () => {
    const layout = layoutBlocks(
      [
        { type: "text", text: "Demo Minimart", align: "center", bold: true, double: true },
        { type: "text", text: "حليب طازج" },
        { type: "row", left: "Total excl. VAT / المجموع بدون الضريبة الكلي", right: "10.48" },
        { type: "rule" },
        { type: "feed", lines: 2 },
      ],
      576,
      measure,
    );
    const texts = layout.ops.filter((o) => o.kind === "text");
    expect(texts[0]).toMatchObject({ text: "Demo Minimart", align: "center", x: 288, style: { size: 44, bold: true } });
    expect(texts[1]).toMatchObject({ text: "حليب طازج", align: "right", x: 576, rtl: true });
    const amount = texts.find((o) => o.kind === "text" && o.text === "10.48")!;
    expect(amount).toMatchObject({ align: "right", x: 576 });
    const labelLines = texts.filter((o) => o.kind === "text" && o.align === "left");
    expect(labelLines.length).toBe(2); // 44 characters x 12 px does not fit beside the amount
    // The amount sits on the label's last line.
    expect(amount.kind === "text" && amount.baseline).toBe(labelLines[1]!.kind === "text" && labelLines[1]!.baseline);
    expect(layout.ops.some((o) => o.kind === "rule")).toBe(true);
    // 57 (double) + 31 + 2 x 31 (row) + 31 (rule) + 62 (feed)
    expect(layout.height).toBe(57 + 31 + 62 + 31 + 62);
  });

  it("scales fonts down for 58 mm paper", () => {
    const layout = layoutBlocks([{ type: "text", text: "x" }], 384, measure);
    expect(layout.ops[0]).toMatchObject({ style: { size: 16 } });
  });
});

describe("rasterizeDoc", () => {
  const painted: Layout[] = [];
  /** Paints the whole image black so the packed bytes are easy to check. */
  const painter: Painter = {
    measure,
    paint(layout) {
      painted.push(layout);
      const px = new Uint8ClampedArray(layout.width * layout.height * 4);
      for (let i = 3; i < px.length; i += 4) px[i] = 255;
      return px;
    },
  };

  it("leaves plain-ASCII documents as text", () => {
    const doc: ReceiptDoc = { blocks: [{ type: "text", text: "Total" }] };
    expect(rasterizeDoc(doc, 576, painter)).toBe(doc);
  });

  it("draws text runs as images and keeps barcodes and QR codes native", () => {
    painted.length = 0;
    const doc: ReceiptDoc = {
      blocks: [
        { type: "text", text: "فاتورة ضريبية" },
        { type: "row", left: "Total", right: "1.00" },
        { type: "barcode", data: "DXB1" },
        { type: "text", text: "Thanks" },
        { type: "qr", data: "https://x" },
      ],
      cut: true,
      openDrawer: true,
    };
    const out = rasterizeDoc(doc, 576, painter);
    expect(out.blocks.map((b) => b.type)).toEqual(["image", "barcode", "image", "qr"]);
    expect(out.cut).toBe(true);
    expect(out.openDrawer).toBe(true);
    expect(painted).toHaveLength(2);
    const img = out.blocks[0]!;
    if (img.type !== "image") throw new Error("expected image");
    expect(img.width).toBe(576);
    expect(img.height).toBe(painted[0]!.height);
    const bytes = fromBase64(img.data);
    expect(bytes.length).toBe((576 / 8) * img.height);
    expect(bytes.every((b) => b === 0xff)).toBe(true);
  });

  it("rounds odd paper widths down to whole bytes", () => {
    const out = rasterizeDoc({ blocks: [{ type: "text", text: "مرحبا" }] }, 380, painter);
    expect(out.blocks[0]).toMatchObject({ type: "image", width: 376 });
  });
});
