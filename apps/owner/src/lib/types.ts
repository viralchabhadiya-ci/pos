export interface Me {
  user: { id: string; name: string; role: "owner" | "manager" };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; code: string; timezone: string }[];
}

export interface Live {
  at: string;
  today: { total: number; orderCount: number };
  stores: { id: string; name: string; code: string; total: number; orderCount: number; lastOrderAt: string | null }[];
  openShifts: {
    id: string;
    registerName: string;
    storeName: string;
    cashier: string;
    openedAt: string;
    total: number;
    orderCount: number;
    lastSeenAt: string | null;
  }[];
  pendingApprovals: number;
  latestOrders: {
    id: string;
    number: string;
    total: number;
    createdAt: string;
    isRefund: boolean;
    storeName: string;
    cashier: string;
  }[];
}

export interface Dashboard {
  date: string;
  total: number;
  orderCount: number;
  refundCount: number;
  refunds: number;
  tax: number;
  discounts: number;
  averageBasket: number;
  hourly: { hour: number; orders: number; total: number }[];
  payments: { kind: "cash" | "card"; amount: number }[];
  topProducts: { variantId: string; name: string; qty: number; total: number }[];
  trend: { date: string; total: number; orders: number }[];
}

export interface AlertItem {
  label: string;
  detail?: string;
  amount?: number;
  href?: string;
}

export interface Alert {
  kind: string;
  severity: "high" | "medium" | "low";
  title: string;
  count: number;
  items: AlertItem[];
  href?: string;
}

export interface Approval {
  id: string;
  kind: "refund" | "discount" | "void" | "price_override" | "cash_out" | "no_sale" | "other";
  amount: number | null;
  reason: string | null;
  summary: string;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  note: string | null;
  storeName: string;
  registerName: string;
  requestedBy: string | null;
  decidedBy: string | null;
}

export interface ReportSettings {
  settings: { dailyEnabled: boolean; sendHour: number; extraEmails: string[] };
  recipients: string[];
  me: { email: string | null; daily: boolean };
  canEdit: boolean;
  transport: string;
  deliveries: {
    id: string;
    kind: "daily" | "manual";
    date: string;
    status: "pending" | "sending" | "sent" | "failed" | "skipped";
    recipients: string[];
    attempts: number;
    error: string | null;
    createdAt: string;
    sentAt: string | null;
  }[];
}

export interface DailySummary {
  date: string;
  compareDate: string;
  currency: string;
  totals: { total: number; tax: number; orderCount: number; refundCount: number; refunds: number; averageBasket: number; discounts: number };
  previous: { total: number };
  topProducts: { name: string; qty: number; total: number }[];
}
