import { maskGiftCard } from "@pos/core";
import type { Block, ReceiptDoc } from "@pos/escpos";
import { request } from "./api.js";
import { forPrinter } from "./raster.js";
import { syncStore } from "./sync.js";
import type { DeviceSetup, LocalOrder, PaymentMethod, Session } from "./db.js";
import type { ShiftSummary } from "./till.js";
import { money, qtyText } from "./format.js";

/** "en": English labels. "bilingual": English and Arabic, as UAE shoppers expect. */
export type ReceiptLang = "en" | "bilingual";

const METHOD_AR: Record<string, string> = { cash: "نقدًا", card: "بطاقة", card_manual: "بطاقة", gift_card: "بطاقة هدية", points: "نقاط", delivery: "منصة التوصيل" };

/** How a payment shows on a receipt: the method, plus the end of a gift card's number or the points. */
export function paymentLabel(name: string, p: { giftCardCode?: string; points?: number }): string {
  if (p.giftCardCode) return `${name} ${maskGiftCard(p.giftCardCode)}`;
  if (p.points) return `${name} (${p.points} pts)`;
  return name;
}

/**
 * The receipt as a printer-neutral document for the store hub's thermal printer. It carries
 * the same tax-invoice fields as the on-screen receipt. With Arabic, printOnHub draws the
 * text as raster images, because the printers' built-in fonts have no Arabic.
 */
export function receiptDoc(
  setup: DeviceSetup,
  order: LocalOrder,
  opts: {
    cashierName: string;
    methods: Pick<PaymentMethod, "id" | "name">[];
    originalNumber?: string;
    openDrawer?: boolean;
    lang?: ReceiptLang;
    /** Arabic item names by variant id. */
    arabicNames?: Map<string, string | null>;
  },
): ReceiptDoc {
  const ar = opts.lang === "bilingual";
  // The Arabic half is a bidi isolate (FSI ... PDI) so numbers in it, like "5%", stay with
  // their Arabic words instead of jumping across the English half.
  const L = (en: string, arabic: string) => (ar ? `${en} / \u2068${arabic}\u2069` : en);
  const notes = new Map(order.lines.map((l) => [l.id, l.note]));
  const mods = new Map(order.lines.map((l) => [l.id, l.modifiers ?? []]));
  const variants = new Map(order.lines.map((l) => [l.id, l.variantId]));
  const refund = order.refundOfOrderId !== null;
  const date = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: setup.store.timezone,
  }).format(new Date(order.createdAt));
  const blocks: Block[] = [
    { type: "text", text: setup.store.name, align: "center", bold: true, double: true },
  ];
  if (ar && setup.store.nameAr) blocks.push({ type: "text", text: setup.store.nameAr, align: "center", bold: true, double: true });
  if (setup.store.address) blocks.push({ type: "text", text: setup.store.address, align: "center" });
  if (setup.store.phone) blocks.push({ type: "text", text: `${L("Tel", "هاتف")} ${setup.store.phone}`, align: "center" });
  if (setup.store.trn) blocks.push({ type: "text", text: `${L("TRN", "الرقم الضريبي")} ${setup.store.trn}`, align: "center" });
  blocks.push({ type: "text", text: refund ? "TAX CREDIT NOTE" : "TAX INVOICE", align: "center", bold: true });
  if (ar) blocks.push({ type: "text", text: refund ? "إشعار دائن ضريبي" : "فاتورة ضريبية", align: "center", bold: true });
  blocks.push({ type: "row", left: `${L("No.", "رقم")} ${order.number}`, right: date });
  if (refund) blocks.push({ type: "text", text: `${L("Ref. invoice", "الفاتورة الأصلية")}: ${opts.originalNumber ?? order.refundOfOrderId}` });
  blocks.push({ type: "text", text: `${L("Cashier", "الكاشير")}: ${opts.cashierName}` }, { type: "rule" });

  for (const l of order.totals.lines) {
    const uom = Number.isInteger(l.qty) ? "unit" : "kg";
    const off = l.lineDiscount + (l.promoDiscount ?? 0);
    const discount = off ? ` (-${money(Math.abs(off))})` : "";
    blocks.push({ type: "text", text: l.giftCardCode ? `${l.name} ${maskGiftCard(l.giftCardCode)}` : l.name });
    if (l.giftCardCode) blocks.push({ type: "text", text: `  ${L("Outside the scope of VAT", "خارج نطاق الضريبة")}` });
    const nameAr = ar ? opts.arabicNames?.get(variants.get(l.id) ?? "") : null;
    if (nameAr) blocks.push({ type: "text", text: nameAr });
    for (const m of mods.get(l.id) ?? []) blocks.push({ type: "text", text: `  + ${m.name}${m.price ? ` ${money(m.price)}` : ""}` });
    blocks.push({ type: "row", left: `  ${qtyText(Math.abs(l.qty), uom)} x ${money(l.unitPrice)}${discount}`, right: money(l.gross) });
    const note = notes.get(l.id);
    if (note) blocks.push({ type: "text", text: `  ${L("Note", "ملاحظة")}: ${note}` });
  }
  blocks.push({ type: "rule" });
  for (const p of order.promotions ?? []) {
    blocks.push({ type: "row", left: p.name ?? L("Promotion", "عرض"), right: `-${money(Math.abs(p.amount))}` });
  }
  blocks.push({ type: "row", left: L("Total excl. VAT", "المجموع بدون الضريبة"), right: money(order.totals.subtotalNet) });
  for (const t of order.totals.taxes) {
    blocks.push({ type: "row", left: L(`VAT ${t.rateBp / 100}%`, `ضريبة القيمة المضافة ${t.rateBp / 100}%`), right: money(t.tax) });
  }
  blocks.push({ type: "row", left: L("Total AED", "الإجمالي درهم"), right: money(order.totals.total), bold: true });
  if (order.payment.cashRounding !== 0) {
    blocks.push(
      { type: "row", left: L("Cash rounding", "تقريب نقدي"), right: money(order.payment.cashRounding) },
      { type: "row", left: L("Payable AED", "المبلغ المستحق درهم"), right: money(order.payment.due), bold: true },
    );
  }
  blocks.push({ type: "rule" });
  for (const p of order.payments) {
    const name = opts.methods.find((m) => m.id === p.methodId)?.name ?? p.kind;
    const label = paymentLabel(ar && METHOD_AR[p.kind] ? L(name, METHOD_AR[p.kind]!) : name, p);
    blocks.push({ type: "row", left: label, right: money(p.tendered ?? p.amount) });
  }
  if (order.payment.change > 0) blocks.push({ type: "row", left: L("Change", "الباقي"), right: money(order.payment.change) });
  if (order.pointsEarned) blocks.push({ type: "text", text: L(`Points earned: ${order.pointsEarned}`, `نقاط مكتسبة: ${order.pointsEarned}`), align: "center" });
  if (setup.store.receiptFooter) {
    blocks.push({ type: "feed" });
    // "|" in the footer starts a new line (e.g. English | Arabic).
    for (const line of setup.store.receiptFooter.split("|").map((l) => l.trim()).filter(Boolean)) {
      blocks.push({ type: "text", text: line, align: "center" });
    }
  }
  blocks.push({ type: "feed" }, { type: "barcode", data: order.number });
  if (setup.publicUrl) {
    blocks.push(
      { type: "feed" },
      { type: "qr", data: `${setup.publicUrl}/r/${order.id}` },
      { type: "text", text: "Scan for your digital receipt", align: "center" },
      ...(ar ? [{ type: "text" as const, text: "امسح الرمز للإيصال الرقمي", align: "center" as const }] : []),
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
  const label: Record<string, string> = { cash: "Cash", card: "Card", card_manual: "Card (manual)", gift_card: "Gift card", points: "Points", delivery: "Delivery platform" };
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

/**
 * Sends a document to the hub's printer. Arabic (or any text the printer fonts lack, such
 * as an Arabic cashier name on an X report) is drawn into raster images first.
 */
export async function printOnHub(doc: ReceiptDoc) {
  const chars = syncStore.get().hub?.printer?.width ?? 48;
  await request("/hub/print", { body: { doc: await forPrinter(doc, chars) } });
}

const RECEIPT_LANG_KEY = "till.receiptLang";

/** This device's printed receipt language; English + Arabic unless changed in the menu. */
export function getReceiptLang(): ReceiptLang {
  try {
    return localStorage.getItem(RECEIPT_LANG_KEY) === "en" ? "en" : "bilingual";
  } catch {
    return "bilingual";
  }
}

export function setReceiptLang(lang: ReceiptLang) {
  try {
    localStorage.setItem(RECEIPT_LANG_KEY, lang);
  } catch {
    /* private mode: the default stays */
  }
}

export async function openDrawerOnHub() {
  await request("/hub/drawer", { method: "POST", body: {} });
}

/** A kitchen ticket: big table name, then what to make (or stop making). */
export function kitchenDoc(
  ticket: { label: string; guests?: number | null; lines: { name: string; qty: number; modifiers: string[]; note?: string | null }[]; createdAt: string },
  opts: { by: string; timezone: string },
): ReceiptDoc {
  const time = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: opts.timezone }).format(new Date(ticket.createdAt));
  const blocks: Block[] = [
    { type: "text", text: ticket.label, align: "center", bold: true, double: true },
    { type: "row", left: `${time} · ${opts.by}`, right: ticket.guests ? `${ticket.guests} guests` : "" },
    { type: "rule" },
  ];
  for (const l of ticket.lines) {
    const qty = qtyText(Math.abs(l.qty), Number.isInteger(l.qty) ? "unit" : "kg");
    blocks.push({ type: "text", text: `${l.qty < 0 ? "CANCEL " : ""}${qty} x ${l.name}`, bold: true, double: true });
    for (const m of l.modifiers) blocks.push({ type: "text", text: `   ${m}`, bold: true });
    if (l.note) blocks.push({ type: "text", text: `   "${l.note}"` });
  }
  blocks.push({ type: "feed", lines: 2 });
  return { blocks, cut: true, openDrawer: false };
}
