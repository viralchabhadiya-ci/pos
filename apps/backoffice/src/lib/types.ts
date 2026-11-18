export interface Me {
  user: { id: string; name: string; role: "owner" | "manager" };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; code: string; timezone: string }[];
  account: {
    status: "trial" | "active" | "past_due" | "suspended" | "cancelled";
    trialEndsAt: string | null;
    planId: string;
    planName: string;
    maxStores: number | null;
    maxRegisters: number | null;
    stores: number;
    registers: number;
  };
  /** Set while platform support is signed in to help. */
  support: { by: string; reason: string; endsAt: string } | null;
}

export type TaxKind = "standard" | "zero" | "exempt";
export interface Tax { id: string; name: string; rateBp: number; priceIncluded: boolean; kind: TaxKind; active: boolean; productCount: number }
export interface Category { id: string; name: string; nameAr: string | null; sort: number; active: boolean; productCount: number }
export interface Product {
  id: string;
  variantId: string;
  name: string;
  nameAr: string | null;
  categoryId: string | null;
  categoryName: string | null;
  uom: "unit" | "kg";
  taxId: string | null;
  price: number;
  cost: number | null;
  barcode: string | null;
  extraBarcodes: string[];
  sku: string | null;
  /** The item code on the shop's scale. */
  plu: string | null;
  reorderLevel: number | null;
  active: boolean;
  onHand: number;
}
export interface Staff {
  id: string;
  name: string;
  email: string | null;
  role: "cashier" | "manager" | "owner";
  active: boolean;
  lastLoginAt: string | null;
  canSignIn: boolean;
}
export interface Device { id: string; name: string; role: "till" | "display"; pairedAt: string; lastSeenAt: string | null; online: boolean }
export interface Register {
  id: string;
  code: string;
  name: string;
  storeId: string;
  storeName: string;
  openSession: { id: string; openedAt: string; openedBy: string } | null;
  devices: Device[];
}
export interface OrderRow {
  id: string;
  number: string;
  createdAt: string;
  total: number;
  taxTotal: number;
  isRefund: boolean;
  storeName: string;
  registerName: string;
  cashierName: string;
  lineCount: number;
  paymentKinds: string[] | null;
}
export interface Dashboard {
  date: string;
  orderCount: number;
  refundCount: number;
  total: number;
  net: number;
  tax: number;
  discounts: number;
  refunds: number;
  averageBasket: number;
  hourly: { hour: number; orders: number; total: number }[];
  payments: { kind: "cash" | "card"; amount: number }[];
  topProducts: { variantId: string; name: string; qty: number; total: number }[];
  trend: { date: string; total: number; orders: number }[];
  recentOrders: { id: string; number: string; createdAt: string; total: number; isRefund: boolean }[];
  lowStock: { count: number; items: { id: string; name: string; reorderLevel: number; onHand: number }[] };
}
export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  trn: string | null;
  priceListId?: string | null;
  priceListName?: string | null;
  orders?: number;
  spent?: number;
  lastVisit?: string | null;
  points?: number;
}

export interface LoyaltySettings {
  enabled: boolean;
  pointsPerAed: number;
  pointValueFils: number;
  minRedeemPoints: number;
}
export interface LoyaltyOverview {
  settings: LoyaltySettings;
  stats: {
    pointsOutstanding: number;
    pointsValue: number;
    members: number;
    earned30: number;
    redeemed30: number;
    giftCardBalance: number;
    giftCardsLive: number;
  };
}
export interface GiftCard {
  id: string;
  code: string;
  status: "active" | "disabled";
  balance: number;
  loaded: number;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  customerId: string | null;
  customerName: string | null;
  lastUsed?: string | null;
}
export interface GiftCardDetail extends GiftCard {
  customerPhone: string | null;
  moves: {
    id: string;
    kind: string;
    amount: number;
    at: string;
    note: string | null;
    orderId: string | null;
    orderNumber: string | null;
    storeName: string | null;
    userName: string | null;
    unclaimed: boolean;
    releasable: boolean;
  }[];
}
export interface CustomerLoyalty {
  points: number;
  moves: { id: string; kind: string; points: number; at: string; note: string | null; orderId: string | null; orderNumber: string | null; userName: string | null }[];
  giftCards: { id: string; code: string; status: string; balance: number }[];
}
export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  data: Record<string, unknown>;
  userName: string | null;
  deviceName: string | null;
}
export interface Store {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  address: string | null;
  phone: string | null;
  trn: string | null;
  timezone: string;
  cashRoundingStep: number;
  receiptFooter: string | null;
  priceListId?: string | null;
}

export type PromotionKind = "percent_off" | "buy_x_get_y" | "multi_buy" | "order_percent_off" | "order_amount_off";
export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  target: { all: boolean; categoryIds: string[]; productIds: string[] };
  percentBp: number | null;
  buyQty: number | null;
  getQty: number | null;
  bundleQty: number | null;
  bundlePrice: number | null;
  amount: number | null;
  minSubtotal: number | null;
  minQty: number | null;
  code: string | null;
  startsAt: string | null;
  endsAt: string | null;
  days: number[] | null;
  startTime: string | null;
  endTime: string | null;
  storeIds: string[] | null;
  priority: number;
  maxUses: number | null;
  uses: number;
  active: boolean;
  sales: number;
  discount: number;
  lastUsed: string | null;
}
export interface PriceList {
  id: string;
  name: string;
  active: boolean;
  itemCount: number;
  customerCount: number;
  stores: { id: string; name: string }[];
}
export interface PriceListItem {
  variantId: string;
  productId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  basePrice: number;
  price: number;
  productActive: boolean;
}
