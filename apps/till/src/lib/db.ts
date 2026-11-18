import Dexie, { type Table } from "dexie";
import type { OrderSync, OrderTotals, PaymentCheck, Promotion } from "@pos/core";

/** Local copies of the catalog. Shapes match /sync/catalog. */
export interface Tax { id: string; name: string; rateBp: number; priceIncluded: boolean; active: boolean }
export interface Category { id: string; parentId: string | null; name: string; nameAr: string | null; sort: number; active: boolean }
export interface Product {
  id: string;
  categoryId: string | null;
  name: string;
  nameAr: string | null;
  uom: "unit" | "kg";
  taxId: string | null;
  active: boolean;
}
export interface Variant {
  id: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  /** More barcodes for the same item (older packs and so on). */
  extraBarcodes?: string[];
  /** The item code on the shop's scale; scale labels carry it. */
  plu?: string | null;
  attributes: Record<string, string>;
  price: number;
  active: boolean;
}
export interface PaymentMethod { id: string; name: string; kind: "cash" | "card" | "card_manual" | "gift_card" | "points"; active: boolean }
export interface User { id: string; name: string; role: "cashier" | "manager" | "owner"; pinSalt: string; pinHash: string; active: boolean }
export interface PriceList { id: string; name: string; active: boolean }
/** id is "priceListId:variantId". */
export interface PriceListItem { id: string; priceListId: string; variantId: string; price: number; active: boolean }

export interface DeviceSetup {
  tenant: { id: string; name: string; currency: string };
  store: {
    id: string;
    code: string;
    name: string;
    nameAr: string | null;
    address: string | null;
    phone?: string | null;
    trn: string | null;
    timezone: string;
    cashRoundingStep: number;
    receiptFooter: string | null;
    /** The store's own prices; a customer's price list wins over it. */
    priceListId?: string | null;
  };
  register: { id: string; code: string; name: string };
  /** A device paired as a customer display shows the cart instead of selling. */
  device?: { role: "till" | "display" };
  /** Base for digital receipt links (the QR on the receipt); null when not set up. */
  publicUrl?: string | null;
  lastSessionSeq: number;
  openSession: { id: string; seq: number; openedBy: string; openedAt: string; openingCash: number } | null;
}

export interface Session {
  id: string;
  seq: number;
  state: "open" | "closed";
  openedBy: string;
  openedAt: string;
  openingCash: number;
  /** Last order sequence used for receipt numbers in this session. */
  orderSeq: number;
  closedAt?: string;
  closedBy?: string;
  closingCashCounted?: number;
}

export interface CashMoveRecord {
  id: string;
  sessionId: string;
  kind: "in" | "out";
  amount: number;
  reason: string;
  userId: string;
  at: string;
}

export interface LocalOrder extends OrderSync {
  totals: OrderTotals;
  payment: PaymentCheck;
  syncStatus: "pending" | "synced" | "rejected";
  syncError?: string;
  /** Points the customer earns, as the till works it out for the receipt (the server books them). */
  pointsEarned?: number;
}

export type OutboxKind = "session.open" | "cash.move" | "order" | "session.close" | "till.event";
export interface OutboxItem {
  seq?: number;
  kind: OutboxKind;
  refId: string;
  payload: unknown;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface Meta { key: string; value: unknown }

/** A sale put aside (customer went to fetch something) to serve the next one. Local to this till. */
export interface ParkedSale {
  id: string;
  createdAt: string;
  cashierName: string;
  cart: import("./cart.js").Cart;
  total: number;
}

/**
 * Every card payment the till starts is written here first, so after a crash or reload the
 * till can still ask what happened to it instead of charging the card again.
 */
export interface CardAttempt {
  id: string;
  orderId: string;
  kind: "sale" | "refund";
  amount: number;
  status: "pending" | "approved" | "declined" | "cancelled" | "failed" | "unknown";
  createdAt: string;
  /** Set once the payment is on a completed sale or refund. */
  usedAt?: string;
  /** Set when the cashier has dealt with an approved payment that never reached a sale. */
  resolvedAt?: string;
  cardLast4?: string | null;
  authCode?: string | null;
  refundOf?: string;
}

export class TillDb extends Dexie {
  meta!: Table<Meta, string>;
  taxes!: Table<Tax, string>;
  categories!: Table<Category, string>;
  products!: Table<Product, string>;
  variants!: Table<Variant, string>;
  paymentMethods!: Table<PaymentMethod, string>;
  users!: Table<User, string>;
  sessions!: Table<Session, string>;
  cashMoves!: Table<CashMoveRecord, string>;
  orders!: Table<LocalOrder, string>;
  outbox!: Table<OutboxItem, number>;
  parked!: Table<ParkedSale, string>;
  cardAttempts!: Table<CardAttempt, string>;
  promotions!: Table<Promotion, string>;
  priceLists!: Table<PriceList, string>;
  priceListItems!: Table<PriceListItem, string>;

  constructor(name = "pos-till") {
    super(name);
    this.version(1).stores({
      meta: "key",
      taxes: "id",
      categories: "id, sort",
      products: "id, categoryId, name",
      variants: "id, productId, barcode, sku",
      paymentMethods: "id",
      users: "id",
      sessions: "id, state",
      cashMoves: "id, sessionId",
      orders: "id, sessionId, number, createdAt, syncStatus",
      outbox: "++seq, kind, refId",
    });
    this.version(2).stores({ parked: "id, createdAt" });
    this.version(3).stores({ cardAttempts: "id, orderId, createdAt" });
    this.version(4).stores({ promotions: "id", priceLists: "id", priceListItems: "id, priceListId" });
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown) {
    await this.meta.put({ key, value });
  }
}

export const db = new TillDb();
