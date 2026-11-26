import { useSyncExternalStore } from "react";

export type Lang = "en" | "ar";

/** Arabic for every customer-facing string; the English is the key. */
export const AR: Record<string, string> = {
  "Order online, collect in store": "اطلب عبر الإنترنت واستلم من المتجر",
  "Pay when you collect.": "ادفع عند الاستلام.",
  "Usually ready in {n} minutes.": "يكون جاهزاً عادةً خلال {n} دقيقة.",
  "Collect from": "الاستلام من",
  Search: "بحث",
  "Search products": "ابحث عن المنتجات",
  All: "الكل",
  Add: "أضف",
  "Sold out": "نفدت الكمية",
  "per kg": "للكيلو",
  "Less": "أقل",
  "More": "أكثر",
  "Nothing matches.": "لا توجد نتائج.",
  "Nothing is for sale online yet.": "لا توجد منتجات للبيع عبر الإنترنت بعد.",
  "View basket": "عرض السلة",
  "{n} item": "{n} صنف",
  "{n} items": "{n} أصناف",
  "Your basket": "سلتك",
  "Your basket is empty.": "سلتك فارغة.",
  "Total, VAT included": "الإجمالي شامل ضريبة القيمة المضافة",
  "Minimum order {amount}": "الحد الأدنى للطلب {amount}",
  "Your details": "بياناتك",
  Name: "الاسم",
  Mobile: "الجوال",
  "Email (optional)": "البريد الإلكتروني (اختياري)",
  "Note for the shop (optional)": "ملاحظة للمتجر (اختياري)",
  "Send me offers by SMS and WhatsApp": "أرسلوا لي العروض عبر الرسائل النصية وواتساب",
  "Place order": "تأكيد الطلب",
  "Placing order…": "جارٍ تأكيد الطلب…",
  "You pay at the counter when you collect.": "تدفع عند الكاشير عند الاستلام.",
  Back: "رجوع",
  Close: "إغلاق",
  "Enter your name": "أدخل اسمك",
  "Enter your mobile number": "أدخل رقم جوالك",
  "Checking prices…": "جارٍ التحقق من الأسعار…",
  "Order {n}": "الطلب {n}",
  Received: "تم الاستلام",
  "Being packed": "قيد التجهيز",
  "Ready to collect": "جاهز للاستلام",
  Collected: "تم الاستلام من المتجر",
  Cancelled: "أُلغي",
  "Pickup code": "رمز الاستلام",
  "Say this code at the counter.": "أخبر الكاشير بهذا الرمز.",
  "We'll send you a message when it is ready.": "سنرسل لك رسالة عندما يكون جاهزاً.",
  "To pay": "المبلغ المطلوب",
  "Cancel order": "إلغاء الطلب",
  "Cancel this order?": "هل تريد إلغاء هذا الطلب؟",
  "Yes, cancel": "نعم، ألغِ الطلب",
  "Keep it": "لا، أبقِه",
  "Order more": "اطلب المزيد",
  "Keep this page to check your order.": "احتفظ بهذه الصفحة لمتابعة طلبك.",
  "This shop is not open online": "هذا المتجر غير متاح عبر الإنترنت",
  "Try again": "حاول مرة أخرى",
  "Open the link the shop gave you.": "افتح الرابط الذي أرسله لك المتجر.",
  "Reason: {r}": "السبب: {r}",
  Items: "الأصناف",
};

let lang: Lang = (() => {
  try {
    const saved = localStorage.getItem("shop-lang");
    if (saved === "ar" || saved === "en") return saved;
  } catch {
    // Storage blocked: fall back to the browser's language.
  }
  return typeof navigator !== "undefined" && navigator.language?.startsWith("ar") ? "ar" : "en";
})();
const listeners = new Set<() => void>();

function apply() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}
apply();

export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem("shop-lang", l);
  } catch {
    // Not saved; it still changes for this visit.
  }
  apply();
  listeners.forEach((f) => f());
}

export const useLang = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => lang,
  );

export function t(en: string, vars: Record<string, string | number> = {}) {
  const text = lang === "ar" ? (AR[en] ?? en) : en;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export const itemsText = (n: number) => t(n === 1 ? "{n} item" : "{n} items", { n });
