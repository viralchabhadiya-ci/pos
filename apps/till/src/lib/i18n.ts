import { useSyncExternalStore } from "react";

/**
 * Till UI language. Strings are written in English in the code and looked up here, so a
 * missing translation shows English rather than a key. Arabic switches the page to RTL.
 * The choice is per device (localStorage), because each till has its own cashier.
 */
export type Lang = "en" | "ar";

const KEY = "till.lang";

/** Arabic for every English string passed to t(). i18n.test.ts checks none is missing. */
export const AR: Record<string, string> = {
  // Status bar and language switch
  "Offline · {n} waiting": "غير متصل · {n} بانتظار الإرسال",
  "Syncing {n}": "جارٍ المزامنة {n}",
  "Internet down · {n} waiting at hub": "الإنترنت منقطع · {n} بانتظار الإرسال في المركز",
  "Online · hub": "متصل · المركز",
  Online: "متصل",
  "{label}. Sync now": "{label}. زامن الآن",
  "{n} rejected": "{n} مرفوض",
  "{n} rejected at hub": "{n} مرفوض في المركز",
  "Shift {n}": "الوردية {n}",
  Menu: "القائمة",
  "Language: English": "اللغة: الإنجليزية",
  "Language: Arabic": "اللغة: العربية",
  "Switch to English": "التبديل إلى الإنجليزية",
  "Switch to Arabic": "التبديل إلى العربية",

  // Pairing, login, shifts
  "Set up this till": "إعداد نقطة البيع",
  "Enter the 6-digit pairing code shown in the back office (Devices, Add device).":
    "أدخل رمز الربط المكوّن من 6 أرقام الظاهر في لوحة الإدارة (الأجهزة، إضافة جهاز).",
  "Server address": "عنوان الخادم",
  "The store hub (http://hub-pc:4100) or the cloud address.": "مركز المتجر (http://hub-pc:4100) أو عنوان السحابة.",
  "Pairing code": "رمز الربط",
  "Device name": "اسم الجهاز",
  "Pairing…": "جارٍ الربط…",
  "Pair device": "ربط الجهاز",
  "Enter your PIN": "أدخل رمزك السري",
  "Wrong PIN, try again": "رمز سري خاطئ، حاول مرة أخرى",
  "No staff loaded yet. Connect to the internet once to sync.": "لم يتم تحميل الموظفين بعد. اتصل بالإنترنت مرة للمزامنة.",
  "{n} digits entered": "تم إدخال {n} أرقام",
  "Delete last digit": "حذف آخر رقم",
  "Checking…": "جارٍ التحقق…",
  OK: "موافق",
  Cancel: "إلغاء",
  "Manager approval": "موافقة المدير",
  "That PIN is not a manager PIN": "هذا الرمز ليس رمز مدير",
  "Open shift": "فتح الوردية",
  "Count the cash in the drawer before the first sale.": "عُدّ النقد في الدرج قبل أول عملية بيع.",
  "Opening cash (AED)": "النقد الافتتاحي (درهم)",
  "Enter the cash in the drawer, e.g. 500.00": "أدخل النقد الموجود في الدرج، مثلاً 500.00",
  "Sign out": "تسجيل الخروج",
  "Close shift {n}": "إغلاق الوردية {n}",
  "Count all cash in the drawer and enter the total.": "عُدّ كل النقد في الدرج وأدخل المجموع.",
  "Cash counted (AED)": "النقد المعدود (درهم)",
  "Back to selling": "العودة إلى البيع",
  Next: "التالي",
  Orders: "الطلبات",
  "Sales total": "إجمالي المبيعات",
  VAT: "ضريبة القيمة المضافة",
  "Paid by cash": "مدفوع نقدًا",
  "Paid by card": "مدفوع بالبطاقة",
  "Paid by card manual": "مدفوع بالبطاقة (يدوي)",
  "Opening cash": "النقد الافتتاحي",
  "Cash in / out": "إيداع / سحب نقدي",
  "Expected cash": "النقد المتوقع",
  Counted: "المعدود",
  Difference: "الفرق",
  "Reason for the difference": "سبب الفرق",
  Recount: "إعادة العد",
  "Close shift": "إغلاق الوردية",

  // Menu
  "Drawer opened": "تم فتح الدرج",
  "Drawer: {msg}": "الدرج: {msg}",
  "X report sent to the printer": "تم إرسال تقرير X إلى الطابعة",
  "Printer: {msg}": "الطابعة: {msg}",
  "Customer screen opened in a new window": "تم فتح شاشة العميل في نافذة جديدة",
  "Open the cash drawer without a sale": "فتح درج النقد بدون عملية بيع",
  "Enter an amount, e.g. 200.00": "أدخل مبلغًا، مثلاً 200.00",
  "Add a reason so the manager can match it later": "أضف سببًا ليتمكن المدير من مطابقته لاحقًا",
  "Recorded cash in of {amount}": "تم تسجيل إيداع نقدي بمبلغ {amount}",
  "Recorded cash out of {amount}": "تم تسجيل سحب نقدي بمبلغ {amount}",
  "Cash in": "إيداع نقدي",
  "Cash out": "سحب نقدي",
  "Amount (AED)": "المبلغ (درهم)",
  Reason: "السبب",
  "Bank drop, supplier payment…": "إيداع بنكي، دفعة لمورد…",
  "Change top-up…": "تعبئة الفكة…",
  Back: "رجوع",
  Save: "حفظ",
  "Open drawer": "فتح الدرج",
  "Print X report": "طباعة تقرير X",
  "Customer screen on this PC": "شاشة العميل على هذا الجهاز",
  "Switch cashier": "تبديل الكاشير",
  "Printed receipts": "الإيصالات المطبوعة",
  "English + Arabic": "الإنجليزية + العربية",
  "English only": "الإنجليزية فقط",
  "Receipts print in English and Arabic": "تُطبع الإيصالات بالإنجليزية والعربية",
  "Receipts print in English only": "تُطبع الإيصالات بالإنجليزية فقط",

  // Selling
  Qty: "الكمية",
  "% Disc": "خصم %",
  Price: "السعر",
  Sell: "البيع",
  Products: "المنتجات",
  "Sale parked. Open Parked to continue it.": "تم تعليق البيع. افتح المعلّقة لمتابعته.",
  "Finish or clear the refund before adding items": "أكمل الاسترداد أو امسحه قبل إضافة أصناف",
  "No product with barcode {code}": "لا يوجد منتج بالباركود {code}",
  "Change the price": "تغيير السعر",
  "Discount above 10%": "خصم أكثر من 10%",
  "Void this sale": "إلغاء هذا البيع",
  "Search products or scan a barcode": "ابحث عن المنتجات أو امسح الباركود",
  "Search name or scan barcode": "ابحث بالاسم أو امسح الباركود",
  Parked: "المعلّقة",
  Refund: "استرداد",
  Categories: "الفئات",
  All: "الكل",
  "No products match “{q}”.": "لا توجد منتجات تطابق “{q}”.",
  "Show all products": "عرض كل المنتجات",
  "Current sale": "البيع الحالي",
  "{n} item": "{n} صنف",
  "{n} items": "{n} أصناف",
  "{pct}% off": "خصم {pct}%",
  "Scan a barcode or tap a product to start.": "امسح باركود أو اضغط على منتج للبدء.",
  "Subtotal (excl. VAT)": "المجموع (بدون الضريبة)",
  Discounts: "الخصومات",
  Total: "الإجمالي",
  "Edit {mode} of line {n}": "تعديل {mode} للسطر {n}",
  "Select a line to change it": "اختر سطرًا لتعديله",
  Apply: "تطبيق",
  "Delete selected line": "حذف السطر المحدد",
  Clear: "مسح",
  Note: "ملاحظة",
  Park: "تعليق",
  Pay: "الدفع",
  "Note for {line}": "ملاحظة لـ {line}",
  "Note (prints on the receipt)": "ملاحظة (تُطبع على الإيصال)",
  "e.g. gift wrap, size swap": "مثلاً تغليف هدية، تبديل المقاس",
  "Remove note": "حذف الملاحظة",
  "Save note": "حفظ الملاحظة",
  "Parked sales": "المبيعات المعلّقة",
  "Park or clear the current sale before you continue another one.": "علّق البيع الحالي أو امسحه قبل متابعة بيع آخر.",
  Keep: "إبقاء",
  "Yes, discard": "نعم، تجاهل",
  Discard: "تجاهل",
  Continue: "متابعة",
  "Weigh {name}": "وزن {name}",
  "AED {price} per kg": "{price} درهم للكيلوغرام",
  "Weight (kg)": "الوزن (كغ)",
  "Price: {price}": "السعر: {price}",
  "Put the item on the scale or type its weight.": "ضع الصنف على الميزان أو اكتب وزنه.",
  Add: "إضافة",

  // Refunds
  "No sale found with that receipt number": "لا يوجد بيع بهذا الرقم",
  "This sale is from another till; connect to the internet to refund it": "هذا البيع من نقطة بيع أخرى؛ اتصل بالإنترنت لاسترداده",
  "Pick at least one item to return": "اختر صنفًا واحدًا على الأقل لإرجاعه",
  "Receipt number": "رقم الإيصال",
  "Find sale": "بحث عن البيع",
  "Sale {number}. Choose how many of each item come back.": "البيع {number}. اختر عدد ما يُرجع من كل صنف.",
  Item: "الصنف",
  Sold: "المباع",
  Return: "المرتجع",
  "Return quantity for {name}": "الكمية المرتجعة من {name}",
  "Start refund": "بدء الاسترداد",

  // Receipt screen
  "Refund complete": "تم الاسترداد",
  "Sale complete": "تم البيع",
  "Give change {amount} AED": "أعطِ الباقي {amount} درهم",
  "Receipt sent to the printer.": "تم إرسال الإيصال إلى الطابعة.",
  "Print again": "طباعة مرة أخرى",
  Print: "طباعة",
  "New sale": "بيع جديد",

  // Shared
  Close: "إغلاق",
  Dismiss: "إخفاء",
};

function load(): Lang {
  try {
    return localStorage.getItem(KEY) === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

let current: Lang = typeof localStorage === "undefined" ? "en" : load();
const listeners = new Set<() => void>();

/** Sets <html lang dir> so the browser mirrors the layout and screen readers switch voice. */
function applyToDocument(lang: Lang) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}
applyToDocument(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* private mode: the choice lasts until reload */
  }
  applyToDocument(lang);
  for (const l of listeners) l();
}

// A second window (the customer screen) follows the till's choice.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      current = load();
      applyToDocument(current);
      for (const l of listeners) l();
    }
  });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Re-renders the caller when the language changes. Used once at the app root. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** Translates an English UI string and fills {placeholders}. */
export function t(en: string, vars?: Record<string, string | number>): string {
  const text = current === "ar" ? (AR[en] ?? en) : en;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/** "{n} item" / "{n} items" in the current language. */
export const itemCount = (n: number) => t(n === 1 ? "{n} item" : "{n} items", { n });
