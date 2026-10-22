import type { Block, ReceiptDoc } from "@pos/escpos";
import { request } from "./api.js";
import type { DeviceSetup, LocalOrder, PaymentMethod } from "./db.js";
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
  return { blocks, cut: true, openDrawer: opts.openDrawer ?? false };
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
