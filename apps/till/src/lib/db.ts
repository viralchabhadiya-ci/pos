import Dexie, { type Table } from "dexie";
import type { OrderSync, OrderTotals, PaymentCheck } from "@pos/core";

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
  attributes: Record<string, string>;
  price: number;
  active: boolean;
}
export interface PaymentMethod { id: string; name: string; kind: "cash" | "card" | "card_manual"; active: boolean }
export interface User { id: string; name: string; role: "cashier" | "manager" | "owner"; pinSalt: string; pinHash: string; active: boolean }

export interface DeviceSetup {
  tenant: { id: string; name: string; currency: string };
  store: {
    id: string;
    code: string;
    name: string;
    nameAr: string | null;
    address: string | null;
    trn: string | null;
    timezone: string;
    cashRoundingStep: number;
    receiptFooter: string | null;
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
}

export type OutboxKind = "session.open" | "cash.move" | "order" | "session.close";
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
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown) {
    await this.meta.put({ key, value });
  }
}

export const db = new TillDb();
