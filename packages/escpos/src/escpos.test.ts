import { describe, expect, it } from "vitest";
import {
  asciiPart,
  commands,
  dotsForWidth,
  encodeDrawerKick,
  encodeReceipt,
  fromBase64,
  needsRaster,
  packRaster,
  RASTER_BAND,
  rasterBytes,
  row,
  toBase64,
  toPrinterText,
  wrap,
} from "./index.js";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const contains = (bytes: Uint8Array, seq: readonly number[]) => Buffer.from(bytes).includes(Buffer.from(seq));

describe("text layout", () => {
  it("wraps words and long tokens to the paper width", () => {
    expect(wrap("Al Rawabi Fresh Milk Full Cream 1L", 16)).toEqual(["Al Rawabi Fresh", "Milk Full Cream", "1L"]);
    expect(wrap("ABCDEFGHIJ", 4)).toEqual(["ABCD", "EFGH", "IJ"]);
  });

  it("right-aligns amounts and wraps long item names", () => {
    expect(row("Water", "1.50", 20)).toEqual(["Water           1.50"]);
    const lines = row("Puck Cream Cheese Spread Jar 240g", "14.50", 24);
    expect(lines.at(-1)!.endsWith("14.50")).toBe(true);
    expect(lines.every((l) => l.length <= 24)).toBe(true);
  });

  it("replaces characters the printer font cannot show", () => {
    expect(toPrinterText("Café")).toEqual([...Buffer.from("Cafe")]);
    expect(toPrinterText("مياه")).toEqual([0x3f, 0x3f, 0x3f, 0x3f]);
    expect(asciiPart("Total AED / الإجمالي")).toBe("Total AED");
    expect(asciiPart("Plain")).toBe("Plain");
  });
});

describe("encodeReceipt", () => {
  it("prints text, cuts, and kicks the drawer when asked", () => {
    const bytes = encodeReceipt(
      {
        blocks: [
          { type: "text", text: "Demo Minimart", align: "center", bold: true },
          { type: "row", left: "Coca-Cola 330ml", right: "5.00" },
          { type: "rule" },
          { type: "row", left: "Total AED", right: "27.46", bold: true },
          { type: "qr", data: "DXB1-R1-0001-0001" },
        ],
        openDrawer: true,
      },
      { width: 32 },
    );
    const s = text(bytes);
    expect(s).toContain("Demo Minimart");
    expect(s).toContain("Coca-Cola 330ml" + " ".repeat(13) + "5.00");
    expect(s).toContain("-".repeat(32));
    expect(s).toContain("DXB1-R1-0001-0001");
    expect(contains(bytes, commands.cut)).toBe(true);
    expect(contains(bytes, commands.drawer)).toBe(true);
  });

  it("skips the cut when disabled and kicks the drawer on its own", () => {
    expect(contains(encodeReceipt({ blocks: [], cut: false }), commands.cut)).toBe(false);
    expect(contains(encodeDrawerKick(), commands.drawer)).toBe(true);
  });
});

describe("raster images", () => {
  it("packs dark pixels into MSB-first 1-bit rows, treating transparency as paper", () => {
    // 10 x 2 image: row 0 has black at x=0 and x=9; row 1 has a transparent black pixel and mid grey.
    const w = 10;
    const px = new Uint8ClampedArray(w * 2 * 4).fill(255);
    const set = (x: number, y: number, v: number, a = 255) => px.set([v, v, v, a], (y * w + x) * 4);
    set(0, 0, 0);
    set(9, 0, 0);
    set(1, 1, 0, 0);
    set(2, 1, 100);
    const r = packRaster(px, w, 2);
    expect(r.width).toBe(16);
    expect([...r.bytes]).toEqual([0b1000_0000, 0b0100_0000, 0b0010_0000, 0]);
  });

  it("round-trips base64", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) & 0xff);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it("encodes GS v 0 in bands with the size header", () => {
    const height = RASTER_BAND + 2;
    const bytes = new Uint8Array(2 * height).fill(0xaa);
    const out = rasterBytes(16, height, bytes);
    expect(out.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, RASTER_BAND, 0]);
    const second = 8 + 2 * RASTER_BAND;
    expect(out.slice(second, second + 8)).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 2, 0]);
    expect(out.length).toBe(16 + bytes.length);
    expect(() => rasterBytes(12, 1, new Uint8Array(2))).toThrow(/multiple of 8/);
    expect(() => rasterBytes(16, 2, new Uint8Array(3))).toThrow(/expected 4/);
  });

  it("prints image blocks centred inside a receipt", () => {
    const img = { type: "image" as const, width: 8, height: 1, data: toBase64(Uint8Array.of(0xff)) };
    const bytes = encodeReceipt({ blocks: [img], cut: false });
    expect(contains(bytes, [...commands.alignCenter, 0x1d, 0x76, 0x30, 0, 1, 0, 1, 0, 0xff, ...commands.alignLeft])).toBe(true);
  });

  it("knows when a document needs raster printing", () => {
    expect(needsRaster({ blocks: [{ type: "text", text: "Total" }, { type: "qr", data: "x" }] })).toBe(false);
    expect(needsRaster({ blocks: [{ type: "row", left: "Total / الإجمالي", right: "1.00" }] })).toBe(true);
    expect(dotsForWidth(48)).toBe(576);
    expect(dotsForWidth(32)).toBe(384);
  });

  it("drops the Arabic half of labels when printing as text", () => {
    const bytes = encodeReceipt({ blocks: [{ type: "row", left: "Total AED / الإجمالي", right: "5.00" }], cut: false }, { width: 20 });
    expect(text(bytes)).toContain("Total AED       5.00");
    expect(asciiPart("A/B")).toBe("A/B");
  });
});
