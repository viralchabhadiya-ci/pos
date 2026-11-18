/** Types and labels for the Inventory pages. */

export type Uom = "unit" | "kg";

export interface Supplier {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  trn: string | null;
  address: string | null;
  paymentTermsDays: number;
  leadTimeDays: number;
  notes: string | null;
  active: boolean;
  openOrders: number;
  itemCount: number;
  lastDelivery: string | null;
}

export interface PickItem {
  variantId: string;
  productId: string;
  name: string;
  nameAr: string | null;
  uom: Uom;
  barcode: string | null;
  sku: string | null;
  cost: number | null;
  trackExpiry: boolean;
  supplierCost: number | null;
  supplierSku: string | null;
  onHand: number;
}

export interface StockRow {
  variantId: string;
  productId: string;
  name: string;
  nameAr: string | null;
  uom: Uom;
  barcode: string | null;
  sku: string | null;
  categoryName: string | null;
  cost: number | null;
  onHand: number;
  incoming: number;
  value: number;
  reorderLevel: number | null;
  reorderQty: number | null;
  supplierName: string | null;
  trackExpiry: boolean;
  active: boolean;
}

export interface ItemDetail {
  variantId: string;
  productId: string;
  name: string;
  nameAr: string | null;
  uom: Uom;
  barcode: string | null;
  sku: string | null;
  cost: number | null;
  price: number;
  reorderLevel: number | null;
  reorderQty: number | null;
  preferredSupplierId: string | null;
  trackExpiry: boolean;
  stores: { storeId: string; name: string; onHand: number }[];
  suppliers: { supplierId: string; name: string; supplierSku: string | null; unitCost: number | null; updatedAt: string }[];
  lots: { id: string; code: string; expiresOn: string | null; createdAt: string }[];
}

export type MoveReason = "sale" | "refund" | "adjust" | "receive" | "transfer" | "count" | "waste";
export interface Move {
  id: number;
  at: string;
  reason: MoveReason;
  qty: number;
  unitCost: number | null;
  note: string | null;
  variantId: string;
  name: string;
  uom: Uom;
  storeName: string;
  userName: string | null;
  lotCode: string | null;
  refId: string | null;
  refNumber: string | null;
  refKind: "order" | "receipt" | "transfer" | "count" | null;
  poId: string | null;
}

export const MOVE_LABEL: Record<MoveReason, string> = {
  sale: "Sale",
  refund: "Refund",
  adjust: "Correction",
  receive: "Goods received",
  transfer: "Transfer",
  count: "Stock count",
  waste: "Written off",
};

export type PoStatus = "draft" | "ordered" | "partial" | "received" | "closed" | "cancelled";
export const PO_STATUS: Record<PoStatus, { label: string; tone?: "good" | "warn" }> = {
  draft: { label: "Draft" },
  ordered: { label: "Ordered", tone: "warn" },
  partial: { label: "Part received", tone: "warn" },
  received: { label: "Received", tone: "good" },
  closed: { label: "Closed short" },
  cancelled: { label: "Cancelled" },
};

export interface PoSummary {
  id: string;
  number: string;
  status: PoStatus;
  supplierId: string;
  supplierName: string;
  storeId: string;
  storeName: string;
  expectedOn: string | null;
  createdAt: string;
  orderedAt: string | null;
  lines: number;
  net: number;
  vat: number;
  total: number;
  ordered: number;
  received: number;
}

export interface PoLine {
  id: string;
  lineNo: number;
  variantId: string;
  name: string;
  nameAr: string | null;
  uom: Uom;
  barcode: string | null;
  supplierSku: string | null;
  trackExpiry: boolean;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost: number;
  taxRateBp: number;
  net: number;
  onHand: number;
}

export interface PoDetail extends Omit<PoSummary, "lines"> {
  supplierPhone: string | null;
  supplierEmail: string | null;
  supplierTrn: string | null;
  supplierAddress: string | null;
  paymentTermsDays: number;
  storeAddress: string | null;
  storeTrn: string | null;
  notes: string | null;
  createdBy: string | null;
  closedAt: string | null;
  lines: PoLine[];
  receipts: { id: string; number: string; supplierInvoice: string | null; receivedAt: string; receivedBy: string | null; lines: number; value: number }[];
}

export type TransferStatus = "draft" | "sent" | "received" | "cancelled";
export const TRANSFER_STATUS: Record<TransferStatus, { label: string; tone?: "good" | "warn" }> = {
  draft: { label: "Draft" },
  sent: { label: "In transit", tone: "warn" },
  received: { label: "Received", tone: "good" },
  cancelled: { label: "Cancelled" },
};

export interface TransferSummary {
  id: string;
  number: string;
  status: TransferStatus;
  fromStoreId: string;
  fromStoreName: string;
  toStoreId: string;
  toStoreName: string;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  lines: number;
  qty: number;
}

export interface TransferLine {
  id: string;
  variantId: string;
  name: string;
  uom: Uom;
  barcode: string | null;
  qty: number;
  qtyReceived: number | null;
  cost: number | null;
  fromOnHand: number;
}

export interface TransferDetail extends Omit<TransferSummary, "lines"> {
  notes: string | null;
  createdBy: string | null;
  sentBy: string | null;
  receivedBy: string | null;
  lines: TransferLine[];
}

export type CountStatus = "open" | "completed" | "cancelled";
export const COUNT_STATUS: Record<CountStatus, { label: string; tone?: "good" | "warn" }> = {
  open: { label: "In progress", tone: "warn" },
  completed: { label: "Completed", tone: "good" },
  cancelled: { label: "Cancelled" },
};

export interface CountSummary {
  id: string;
  number: string;
  name: string;
  status: CountStatus;
  storeId: string;
  storeName: string;
  categoryName: string | null;
  createdAt: string;
  completedAt: string | null;
  lines: number;
  counted: number;
}

export interface CountLine {
  variantId: string;
  name: string;
  nameAr: string | null;
  uom: Uom;
  barcode: string | null;
  sku: string | null;
  cost: number | null;
  expected: number;
  counted: number | null;
  countedAt: string | null;
  adjustment: number | null;
  systemAtCount: number | null;
}

export interface ReorderLine {
  variantId: string;
  name: string;
  uom: Uom;
  barcode: string | null;
  onHand: number;
  incoming: number;
  dailySales: number;
  reorderAt: number;
  orderUpTo: number;
  auto: boolean;
  qty: number;
  unitCost: number;
  supplierId: string | null;
  supplierName: string | null;
}

export interface ExpiryLot {
  lotId: string;
  code: string;
  expiresOn: string;
  daysLeft: number;
  expired: boolean;
  variantId: string;
  name: string;
  uom: Uom;
  storeId: string;
  storeName: string;
  remaining: number;
  value: number;
}

/** "12" or "1.250 kg". */
export const qtyUnit = (n: number, uom: Uom) => {
  const v = Number(n);
  const s = Number.isInteger(v) ? String(v) : v.toFixed(3);
  return uom === "kg" ? `${s} kg` : s;
};

/** Parses a quantity typed by a person; pieces must be whole. Returns null when it is not valid. */
export function parseQty(input: string, uom: Uom, allowZero = false): number | null {
  const t = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  if (!allowZero && n === 0) return null;
  if (uom === "unit" && !Number.isInteger(n)) return null;
  return n;
}

export const dateOnly = (ymd: string) =>
  new Intl.DateTimeFormat("en-AE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
