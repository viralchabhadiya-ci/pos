export type Role = "cashier" | "manager" | "owner";
export interface StaffUser {
  id: string;
  name: string;
  role: Role;
}
export interface DeviceSetup {
  store: { id: string; name: string; code: string };
  tenant: { name: string };
}
export interface LookupItem {
  productId: string;
  variantId: string;
  name: string;
  nameAr: string | null;
  uom: string;
  active: boolean;
  categoryName: string | null;
  price: number;
  barcode: string | null;
  sku: string | null;
  plu: string | null;
  reorderLevel: number | null;
  taxName: string | null;
  taxRateBp: number | null;
  onHand: number;
  otherStores: { name: string; qty: number }[];
  lastReceivedAt: string | null;
}
/** A line from a count or a delivery that the scanner can match. */
export interface Scannable {
  variantId: string;
  name: string;
  uom: string;
  barcode: string | null;
  extraBarcodes: string[] | null;
  sku: string | null;
}
