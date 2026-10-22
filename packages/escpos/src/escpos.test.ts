import { describe, expect, it } from "vitest";
import { asciiPart, commands, encodeDrawerKick, encodeReceipt, row, toPrinterText, wrap } from "./index.js";

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
