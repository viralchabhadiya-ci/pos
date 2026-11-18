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

  // Payment and card terminal
  // The demo's payment method names; names a business types in itself stay as typed.
  Cash: "نقداً",
  Card: "بطاقة",
  "Card (manual terminal)": "بطاقة (جهاز يدوي)",
  Payment: "الدفع",
  "Paid in full": "تم الدفع بالكامل",
  "To refund": "المبلغ المسترد",
  "Amount due": "المبلغ المستحق",
  "Refund amount": "مبلغ الاسترداد",
  "Amount received": "المبلغ المستلم",
  "Refunds go back in full to the method you pick.": "يُعاد مبلغ الاسترداد كاملاً بطريقة الدفع التي تختارها.",
  "Leave empty to pay exactly what is due, or tap a note.": "اتركه فارغاً لدفع المبلغ المستحق بالضبط، أو اختر ورقة نقدية.",
  "Complete refund": "إتمام الاسترداد",
  "Complete sale": "إتمام البيع",
  "Saving…": "جارٍ الحفظ…",
  "Enter an amount": "أدخل مبلغاً",
  "Card amount cannot be more than what is due": "لا يمكن أن يزيد مبلغ البطاقة عن المبلغ المستحق",
  "Cash rounding {amount}": "تقريب النقد {amount}",
  "Remove {method} {amount}": "إزالة {method} {amount}",
  "Give change": "أعطِ الباقي",
  "Cash {amount} AED": "نقداً {amount} درهم",
  "on {terminal}": "على {terminal}",
  "The card terminal needs the internet. Use the manual card terminal or cash.": "جهاز البطاقات يحتاج إلى الإنترنت. استخدم جهاز البطاقات اليدوي أو النقد.",
  "The original sale was not paid on this card terminal. Refund in cash or on the manual terminal.": "لم يُدفع البيع الأصلي على جهاز البطاقات هذا. أعد المبلغ نقداً أو على الجهاز اليدوي.",
  "A card payment went through. Complete the sale; to undo it, refund it to the card afterwards.": "تمت عملية دفع بالبطاقة. أكمل البيع، ولإلغائها أعد المبلغ إلى البطاقة بعد ذلك.",
  "Charge {amount}": "خصم {amount}",
  "Refund {amount}": "استرداد {amount}",
  "Could not start the payment": "تعذّر بدء عملية الدفع",
  "Sending to the terminal…": "جارٍ الإرسال إلى جهاز البطاقات…",
  "Ask the customer to tap, insert or swipe the card": "اطلب من العميل تمرير البطاقة أو إدخالها أو تقريبها",
  "Ask the customer to tap or insert the card for the refund": "اطلب من العميل تقريب البطاقة أو إدخالها لاسترداد المبلغ",
  "Waiting for the customer to tap or insert the card": "بانتظار أن يقرّب العميل البطاقة أو يدخلها",
  "This is taking long. You can keep waiting or cancel on the terminal.": "العملية تستغرق وقتاً طويلاً. يمكنك الانتظار أو الإلغاء على الجهاز.",
  "No answer from the terminal yet": "لا يوجد رد من جهاز البطاقات بعد",
  "Checking again… Do not charge the card again until this clears.": "جارٍ التحقق مجدداً… لا تخصم من البطاقة مرة أخرى حتى يتضح الأمر.",
  Approved: "تمت الموافقة",
  "Auth {code}": "رمز التفويض {code}",
  Declined: "مرفوضة",
  Cancelled: "ملغاة",
  "Payment failed": "فشلت عملية الدفع",
  "Nothing was charged.": "لم يُخصم أي مبلغ.",
  "Check now": "تحقق الآن",
  "Cancel on terminal": "إلغاء على الجهاز",
  "Other method": "طريقة أخرى",
  "Try card again": "أعد المحاولة بالبطاقة",
  "No connection. Checking again…": "لا يوجد اتصال. جارٍ التحقق مجدداً…",
  "No connection. Cannot cancel yet.": "لا يوجد اتصال. لا يمكن الإلغاء الآن.",
  "{amount} was charged on a card ending {last4} at {time}, but the sale was not finished.": "تم خصم {amount} من بطاقة تنتهي بـ {last4} في {time}، لكن البيع لم يكتمل.",
  "{amount} was charged on a card at {time}, but the sale was not finished.": "تم خصم {amount} من بطاقة في {time}، لكن البيع لم يكتمل.",
  "Refund to card": "استرداد إلى البطاقة",
  "Already sorted": "تمت المعالجة",
  "Refund card payment": "استرداد دفعة البطاقة",
  "Confirm the {amount} card payment was dealt with (e.g. the sale was rung up again)": "أكّد أن دفعة البطاقة بقيمة {amount} تمت معالجتها (مثلاً أُعيد تسجيل البيع)",
  "The card terminal is not reachable right now. Try again in a moment.": "لا يمكن الوصول إلى جهاز البطاقات الآن. حاول بعد قليل.",
  "No connection. Try again when the till is back online.": "لا يوجد اتصال. حاول مجدداً عند عودة الاتصال.",

  // Customers, coupons and promotions
  Customer: "العميل",
  "Customer: {name}": "العميل: {name}",
  "Add customer": "إضافة العميل",
  "New customer": "عميل جديد",
  "Remove from sale": "إزالة من البيع",
  "Name or phone": "الاسم أو رقم الهاتف",
  "e.g. Ahmed or 4567": "مثلاً أحمد أو 4567",
  "No customer found.": "لم يتم العثور على عميل.",
  Name: "الاسم",
  Mobile: "الجوال",
  "Finding customers needs the connection.": "البحث عن العملاء يحتاج إلى الاتصال.",
  "Adding a customer needs the connection.": "إضافة عميل تحتاج إلى الاتصال.",
  Coupon: "قسيمة",
  "Add coupon": "إضافة قسيمة",
  "Coupons: {codes}": "القسائم: {codes}",
  "Coupon code": "رمز القسيمة",
  "No coupon with this code.": "لا توجد قسيمة بهذا الرمز.",
  "This coupon is not valid at this time or in this store.": "هذه القسيمة غير صالحة في هذا الوقت أو في هذا المتجر.",
  "This code is already on the sale.": "هذا الرمز مضاف إلى البيع بالفعل.",
  Applied: "مطبّقة",
  "Not applied yet: the sale does not qualify": "غير مطبّقة بعد: البيع لا يستوفي الشروط",
  Remove: "إزالة",
  Done: "تم",

  // Shared
  Close: "إغلاق",
  Dismiss: "إخفاء",
  // Gift cards and points
  "Gift card numbers are 6 to 40 letters, digits or dashes.": "رقم بطاقة الهدية من 6 إلى 40 حرفًا أو رقمًا أو شرطة.",
  "This gift card has been switched off.": "تم إيقاف بطاقة الهدية هذه.",
  "This gift card has expired.": "انتهت صلاحية بطاقة الهدية هذه.",
  "This gift card is empty.": "لا يوجد رصيد في بطاقة الهدية هذه.",
  "There is not enough left on this gift card.": "الرصيد المتبقي في بطاقة الهدية غير كافٍ.",
  "Gift card number": "رقم بطاقة الهدية",
  "Scan or type the number": "امسح الرقم أو اكتبه",
  "New number": "رقم جديد",
  "Check": "تحقق",
  "Store credit: {amount} goes onto this card when the refund syncs. Give the customer the number.": "رصيد المتجر: يضاف {amount} إلى هذه البطاقة عند مزامنة الاسترجاع. أعط الرقم للعميل.",
  "Refund {amount} to the card": "استرجاع {amount} إلى البطاقة",
  "Balance": "الرصيد",
  "Amount to use": "المبلغ المستخدم",
  "Use gift card": "استخدام بطاقة الهدية",
  "Gift cards and points need the internet. Take another payment.": "بطاقات الهدايا والنقاط تحتاج إلى الإنترنت. استخدم طريقة دفع أخرى.",
  "Points": "النقاط",
  "Points can only be used with a customer on the sale. Add the customer first.": "لا يمكن استخدام النقاط إلا مع عميل في البيع. أضف العميل أولًا.",
  "Refund to points": "استرجاع إلى النقاط",
  "The sale was not paid with points, so nothing goes back as points.": "لم يُدفع البيع بالنقاط، لذلك لا يُسترجع شيء كنقاط.",
  "{points} points go back to the customer for {amount}.": "تعود {points} نقطة إلى العميل مقابل {amount}.",
  "Give back {points} points": "إرجاع {points} نقطة",
  "Enter the points to use": "أدخل النقاط المستخدمة",
  "At least {n} points at a time.": "على الأقل {n} نقطة في كل مرة.",
  "At most {n} points on this sale.": "بحد أقصى {n} نقطة في هذا البيع.",
  "Pay with points": "الدفع بالنقاط",
  "Checking the customer's points…": "جارٍ التحقق من نقاط العميل…",
  "{n} points": "{n} نقطة",
  "worth {amount}": "بقيمة {amount}",
  "Not enough points yet: at least {n} are needed.": "النقاط غير كافية بعد: يلزم {n} نقطة على الأقل.",
  "Points to use (up to {n})": "النقاط المستخدمة (حتى {n})",
  "Pays {amount}": "تدفع {amount}",
  "Use points": "استخدام النقاط",
  "Refund to a gift card": "استرجاع إلى بطاقة هدية",
  "Pay with a gift card": "الدفع ببطاقة هدية",
  "No gift card with that number.": "لا توجد بطاقة هدية بهذا الرقم.",
  "{n} pts": "{n} نقطة",
  "A gift card can be loaded with at most AED 10,000 at a time.": "يمكن شحن بطاقة الهدية بـ 10,000 درهم كحد أقصى في كل مرة.",
  "Gift card": "بطاقة هدية",
  "Sell or top up": "بيع أو شحن",
  "Check balance": "معرفة الرصيد",
  "Scan a printed card, or make a new number and write it on the receipt for the customer. Selling the same number again tops it up.": "امسح بطاقة مطبوعة، أو أنشئ رقمًا جديدًا واكتبه على الإيصال للعميل. بيع الرقم نفسه مرة أخرى يشحنه.",
  "Amount": "المبلغ",
  "Valid until {date}": "صالحة حتى {date}",
  "Add to sale": "إضافة إلى البيع",
  "The gift card amount is still held; remove it again when back online.": "مبلغ بطاقة الهدية ما زال محجوزًا؛ احذفه مرة أخرى عند عودة الاتصال.",
  "Gift cards are not refunded: the balance stays on the card.": "لا تُسترجع بطاقات الهدايا: يبقى الرصيد على البطاقة.",
  "A gift card's amount is set when it is added. Delete the line and add it again to change it.": "يُحدد مبلغ بطاقة الهدية عند إضافتها. احذف السطر وأضفها من جديد لتغييره.",
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
