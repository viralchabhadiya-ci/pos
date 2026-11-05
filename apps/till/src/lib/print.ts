import type { Block, ReceiptDoc } from "@pos/escpos";
import { request } from "./api.js";
import type { DeviceSetup, LocalOrder, PaymentMethod, Session } from "./db.js";
import type { ShiftSummary } from "./till.js";
import { money, qtyText } from "./format.js";

/**
 * The receipt as a printer-neutral document for the store hub's thermal printer. It carries
 * the same tax-invoice fields as the on-screen receipt. Labels are English only because
 * the printers' built-in fonts have no Arabic; Arabic comes with raster printing.
 */
export function receiptDoc(
  setup: DeviceSetup,
  order: LocalOrder,
  opts: { cashierName: string; methods: Pick<PaymentMethod, "id" | "name">[]; originalNumber?: string; openDrawer?: boolean },
): ReceiptDoc {
  const notes = new Map(order.lines.map((l) => [l.id, l.note]));
  const refund = order.refundOfOrderId !== null;
  const date = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: setup.store.timezone,
  }).format(new Date(order.createdAt));
  const blocks: Block[] = [
    { type: "text", text: setup.store.name, align: "center", bold: true, double: true },
  ];
  if (setup.store.address) blocks.push({ type: "text", text: setup.store.address, align: "center" });
  if (setup.store.trn) blocks.push({ type: "text", text: `TRN ${setup.store.trn}`, align: "center" });
  blocks.push(
    { type: "text", text: refund ? "TAX CREDIT NOTE" : "TAX INVOICE", align: "center", bold: true },
    { type: "row", left: `No. ${order.number}`, right: date },
  );
  if (refund) blocks.push({ type: "text", text: `Ref. invoice: ${opts.originalNumber ?? order.refundOfOrderId}` });
  blocks.push({ type: "text", text: `Cashier: ${opts.cashierName}` }, { type: "rule" });

  for (const l of order.totals.lines) {
    const uom = Number.isInteger(l.qty) ? "unit" : "kg";
    const discount = l.lineDiscount ? ` (-${money(Math.abs(l.lineDiscount))})` : "";
    blocks.push(
      { type: "text", text: l.name },
      { type: "row", left: `  ${qtyText(Math.abs(l.qty), uom)} x ${money(l.unitPrice)}${discount}`, right: money(l.gross) },
    );
    const note = notes.get(l.id);
    if (note) blocks.push({ type: "text", text: `  Note: ${note}` });
  }
  blocks.push({ type: "rule" }, { type: "row", left: "Total excl. VAT", right: money(order.totals.subtotalNet) });
  for (const t of order.totals.taxes) blocks.push({ type: "row", left: `VAT ${t.rateBp / 100}%`, right: money(t.tax) });
  blocks.push({ type: "row", left: "Total AED", right: money(order.totals.total), bold: true });
  if (order.payment.cashRounding !== 0) {
    blocks.push(
      { type: "row", left: "Cash rounding", right: money(order.payment.cashRounding) },
      { type: "row", left: "Payable AED", right: money(order.payment.due), bold: true },
    );
  }
  blocks.push({ type: "rule" });
  for (const p of order.payments) {
    const name = opts.methods.find((m) => m.id === p.methodId)?.name ?? p.kind;
    blocks.push({ type: "row", left: name, right: money(p.tendered ?? p.amount) });
  }
  if (order.payment.change > 0) blocks.push({ type: "row", left: "Change", right: money(order.payment.change) });
  if (setup.store.receiptFooter) blocks.push({ type: "feed" }, { type: "text", text: setup.store.receiptFooter, align: "center" });
  blocks.push({ type: "feed" }, { type: "barcode", data: order.number });
  if (setup.publicUrl) {
    blocks.push(
      { type: "feed" },
      { type: "qr", data: `${setup.publicUrl}/r/${order.id}` },
      { type: "text", text: "Scan for your digital receipt", align: "center" },
    );
  }
  return { blocks, cut: true, openDrawer: opts.openDrawer ?? false };
}

/**
 * The shift report. X: printed mid-shift, changes nothing. Z: printed at close with the
 * counted cash and the difference; it ends the shift's numbers for the day.
 */
export function shiftReportDoc(
  setup: DeviceSetup,
  session: Pick<Session, "seq" | "openedAt">,
  summary: ShiftSummary,
  opts: { kind: "X" | "Z"; userName: string; counted?: number; note?: string; at?: Date },
): ReceiptDoc {
  const fmt = (d: Date | string) =>
    new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: setup.store.timezone }).format(new Date(d));
  const label: Record<string, string> = { cash: "Cash", card: "Card", card_manual: "Card (manual)" };
  const blocks: Block[] = [
    { type: "text", text: setup.store.name, align: "center", bold: true },
    { type: "text", text: `${opts.kind} REPORT`, align: "center", bold: true, double: true },
    { type: "row", left: `${setup.register.name} · shift ${session.seq}`, right: "" },
    { type: "row", left: "Opened", right: fmt(session.openedAt) },
    { type: "row", left: opts.kind === "Z" ? "Closed" : "Printed", right: fmt(opts.at ?? new Date()) },
    { type: "row", left: "By", right: opts.userName },
    { type: "rule" },
    { type: "row", left: "Bills", right: String(summary.orderCount) },
    { type: "row", left: "Sales total", right: money(summary.total), bold: true },
    { type: "row", left: "VAT", right: money(summary.taxTotal) },
    { type: "rule" },
  ];
  for (const [kind, amount] of Object.entries(summary.byKind)) blocks.push({ type: "row", left: label[kind] ?? kind, right: money(amount) });
  blocks.push(
    { type: "rule" },
    { type: "row", left: "Opening cash", right: money(summary.openingCash) },
    { type: "row", left: "Cash sales", right: money(summary.cashSales) },
    { type: "row", left: "Cash in", right: money(summary.cashIn) },
    { type: "row", left: "Cash out", right: `-${money(summary.cashOut)}` },
    { type: "row", left: "Expected cash", right: money(summary.expectedCash), bold: true },
  );
  if (opts.counted !== undefined) {
    blocks.push(
      { type: "row", left: "Counted", right: money(opts.counted), bold: true },
      { type: "row", left: "Difference", right: money(opts.counted - summary.expectedCash), bold: true },
    );
    if (opts.note) blocks.push({ type: "text", text: `Reason: ${opts.note}` });
  }
  blocks.push({ type: "feed" }, { type: "text", text: "Signature: ____________________" });
  return { blocks, cut: true, openDrawer: false };
}

/** A cash sale or a cash refund needs the drawer. */
export function needsDrawer(order: LocalOrder): boolean {
  return order.payments.some((p) => p.kind === "cash");
}

export async function printOnHub(doc: ReceiptDoc) {
  await request("/hub/print", { body: { doc } });
}

export async function openDrawerOnHub() {
  await request("/hub/drawer", { method: "POST", body: {} });
}
