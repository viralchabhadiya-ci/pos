import { checkPayments, priceOrder } from "@pos/core";
import { encodeReceipt } from "@pos/escpos";
import { describe, expect, it } from "vitest";
import type { DeviceSetup, LocalOrder } from "./db.js";
import { needsDrawer, receiptDoc, shiftReportDoc } from "./print.js";

const setup = {
  store: { name: "Demo Minimart", address: "Al Karama, Dubai", trn: "100000000000003", timezone: "Asia/Dubai", receiptFooter: "Thank you" },
} as DeviceSetup;
const vat = { id: "vat", name: "VAT 5%", rateBp: 500, priceIncluded: true };
const lines = [
  { id: "l1", variantId: "v1", name: "Coca-Cola 330ml", qty: 2, unitPrice: 250, discountBp: 0, taxId: "vat" },
  { id: "l2", variantId: "v2", name: "Bananas", qty: 0.75, unitPrice: 795, discountBp: 0, taxId: "vat" },
];
const totals = priceOrder(lines, { taxes: { vat } });
const payments = [{ id: "p1", methodId: "cash", kind: "cash" as const, amount: 1100, tendered: 2000 }];
const order = {
  id: "o1",
  number: "DXB1-R1-0001-0007",
  refundOfOrderId: null,
  createdAt: "2026-10-22T08:30:00.000Z",
  lines,
  payments,
  totals,
  payment: checkPayments(totals.total, payments),
} as unknown as LocalOrder;

describe("printed receipt", () => {
  it("carries the tax invoice fields and opens the drawer for cash", () => {
    const doc = receiptDoc(setup, order, { cashierName: "Aisha", methods: [{ id: "cash", name: "Cash" }], openDrawer: needsDrawer(order) });
    const text = Buffer.from(encodeReceipt(doc, { width: 48 })).toString("latin1");
    for (const want of ["Demo Minimart", "TRN 100000000000003", "TAX INVOICE", "DXB1-R1-0001-0007", "22/10/2026, 12:30", "Cashier: Aisha", "0.750 kg x 7.95", "VAT 5%", "Total AED", "Change", "Thank you"]) {
      expect(text).toContain(want);
    }
    expect(doc.openDrawer).toBe(true);
    expect(doc.cut).toBe(true);
  });

  it("prints a credit note for a refund with the original invoice number", () => {
    const refund = { ...order, refundOfOrderId: "o0", payments: [{ ...payments[0]!, kind: "card" as const }] } as LocalOrder;
    const doc = receiptDoc(setup, refund, { cashierName: "Aisha", methods: [], originalNumber: "DXB1-R1-0001-0003" });
    const text = doc.blocks.map((b) => ("text" in b ? b.text : "left" in b ? `${b.left} ${b.right}` : "")).join("\n");
    expect(text).toContain("TAX CREDIT NOTE");
    expect(text).toContain("Ref. invoice: DXB1-R1-0001-0003");
    expect(needsDrawer(refund)).toBe(false);
  });
});

describe("notes, receipt QR and shift reports", () => {
  it("prints line notes and a QR to the digital receipt", () => {
    const withNote = { ...order, lines: [{ ...lines[0]!, note: "Gift wrap" }, lines[1]!] } as LocalOrder;
    const doc = receiptDoc({ ...setup, publicUrl: "https://pos.example" }, withNote, { cashierName: "Aisha", methods: [] });
    expect(doc.blocks).toContainEqual({ type: "text", text: "  Note: Gift wrap" });
    expect(doc.blocks).toContainEqual({ type: "qr", data: "https://pos.example/r/o1" });
    expect(receiptDoc(setup, order, { cashierName: "A", methods: [] }).blocks.some((b) => b.type === "qr")).toBe(false);
  });

  it("prints the Z report with expected, counted and the difference", () => {
    const summary = { openingCash: 50_000, cashSales: 1_100, cashIn: 0, cashOut: 2_000, expectedCash: 49_100, orderCount: 3, total: 4_000, taxTotal: 190, byKind: { cash: 1_100, card: 2_900 } };
    const doc = shiftReportDoc({ ...setup, register: { id: "r", code: "R1", name: "Counter 1" } } as DeviceSetup, { seq: 4, openedAt: "2026-10-22T04:00:00Z" }, summary, {
      kind: "Z",
      userName: "Rahul",
      counted: 49_000,
      note: "Short change",
      at: new Date("2026-10-22T16:00:00Z"),
    });
    const text = Buffer.from(encodeReceipt(doc, { width: 48 })).toString("latin1");
    for (const want of ["Z REPORT", "Counter 1", "shift 4", "Bills", "Card", "Expected cash", "491.00", "Counted", "490.00", "Difference", "-1.00", "Reason: Short change"]) {
      expect(text).toContain(want);
    }
  });
});
