export interface Me {
  user: { id: string; name: string; role: "owner" | "manager" };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; code: string; timezone: string }[];
}

export interface Tax { id: string; name: string; rateBp: number; priceIncluded: boolean; active: boolean }
export interface Category { id: string; name: string; nameAr: string | null; sort: number; active: boolean; productCount: number }
export interface Product {
  id: string;
  name: string;
  nameAr: string | null;
  categoryId: string | null;
  categoryName: string | null;
  uom: "unit" | "kg";
  taxId: string | null;
  price: number;
  cost: number | null;
  barcode: string | null;
  sku: string | null;
  active: boolean;
  onHand: string;
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
}
