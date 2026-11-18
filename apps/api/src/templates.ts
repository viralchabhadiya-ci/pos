/**
 * Starting points for a new business, by type. Categories always come with the template;
 * sample products are optional and can be edited or switched off in the back office.
 * Prices are in fils and include 5% VAT. Sample products have no barcode, so the owner's
 * real barcodes never clash with them.
 */

export type BusinessType = "grocery" | "fashion" | "electronics" | "cosmetics" | "pharmacy" | "other";

export interface Template {
  label: string;
  categories: { name: string; nameAr: string }[];
  /** [category, name, Arabic name, price in fils, sold by weight, zero rated] */
  samples: [string, string, string, number, boolean?, boolean?][];
}

export const TEMPLATES: Record<BusinessType, Template> = {
  grocery: {
    label: "Grocery or minimart",
    categories: [
      { name: "Beverages", nameAr: "مشروبات" },
      { name: "Dairy", nameAr: "ألبان" },
      { name: "Bakery", nameAr: "مخبوزات" },
      { name: "Snacks", nameAr: "وجبات خفيفة" },
      { name: "Fresh", nameAr: "طازج" },
      { name: "Household", nameAr: "منزلية" },
    ],
    samples: [
      ["Beverages", "Water 1.5L", "مياه 1.5 لتر", 150],
      ["Beverages", "Soft drink 330ml", "مشروب غازي 330 مل", 250],
      ["Dairy", "Fresh milk 1L", "حليب طازج 1 لتر", 650],
      ["Bakery", "Arabic bread (6 pcs)", "خبز عربي 6 حبات", 300],
      ["Snacks", "Potato chips 48g", "رقائق البطاطس 48 غ", 350],
      ["Fresh", "Bananas (per kg)", "موز (للكيلو)", 795, true],
      ["Household", "Tissues 200", "مناديل 200", 895],
    ],
  },
  fashion: {
    label: "Fashion and footwear",
    categories: [
      { name: "Men", nameAr: "رجال" },
      { name: "Women", nameAr: "نساء" },
      { name: "Kids", nameAr: "أطفال" },
      { name: "Footwear", nameAr: "أحذية" },
      { name: "Accessories", nameAr: "إكسسوارات" },
    ],
    samples: [
      ["Men", "Cotton T-shirt", "تيشيرت قطني", 4900],
      ["Men", "Kandura", "كندورة", 22000],
      ["Women", "Abaya", "عباية", 35000],
      ["Kids", "Kids T-shirt", "تيشيرت أطفال", 2900],
      ["Footwear", "Sandals", "صندل", 8900],
      ["Accessories", "Scarf", "وشاح", 5900],
    ],
  },
  electronics: {
    label: "Electronics and mobiles",
    categories: [
      { name: "Phones", nameAr: "هواتف" },
      { name: "Accessories", nameAr: "إكسسوارات" },
      { name: "Audio", nameAr: "صوتيات" },
      { name: "Computers", nameAr: "حواسيب" },
      { name: "Repairs", nameAr: "صيانة" },
    ],
    samples: [
      ["Accessories", "USB-C charger 20W", "شاحن USB-C 20 واط", 7900],
      ["Accessories", "Phone case", "غطاء هاتف", 4500],
      ["Accessories", "Screen protector", "واقي شاشة", 3500],
      ["Audio", "Wireless earbuds", "سماعات لاسلكية", 19900],
      ["Computers", "Wireless mouse", "فأرة لاسلكية", 6900],
      ["Repairs", "Screen replacement (labour)", "تبديل شاشة (أجرة)", 15000],
    ],
  },
  cosmetics: {
    label: "Cosmetics and perfumes",
    categories: [
      { name: "Perfumes", nameAr: "عطور" },
      { name: "Oud and bakhoor", nameAr: "عود وبخور" },
      { name: "Makeup", nameAr: "مكياج" },
      { name: "Skincare", nameAr: "العناية بالبشرة" },
      { name: "Hair care", nameAr: "العناية بالشعر" },
    ],
    samples: [
      ["Perfumes", "Eau de parfum 100ml", "ماء عطر 100 مل", 29900],
      ["Oud and bakhoor", "Bakhoor 50g", "بخور 50 غ", 7500],
      ["Makeup", "Lipstick", "أحمر شفاه", 6900],
      ["Skincare", "Moisturiser 50ml", "مرطب 50 مل", 8900],
      ["Hair care", "Hair oil 100ml", "زيت شعر 100 مل", 4500],
    ],
  },
  pharmacy: {
    label: "Pharmacy (retail)",
    categories: [
      { name: "Medicines", nameAr: "أدوية" },
      { name: "Vitamins", nameAr: "فيتامينات" },
      { name: "Personal care", nameAr: "العناية الشخصية" },
      { name: "Baby", nameAr: "أطفال رضع" },
      { name: "First aid", nameAr: "إسعافات أولية" },
    ],
    samples: [
      // Many medicines are zero rated for VAT in the UAE; check each product's VAT before selling.
      ["Medicines", "Paracetamol 500mg (24)", "باراسيتامول 500 ملغ (24)", 900, false, true],
      ["Vitamins", "Vitamin C 1000mg (30)", "فيتامين سي 1000 ملغ (30)", 4500],
      ["Personal care", "Toothpaste 100ml", "معجون أسنان 100 مل", 1200],
      ["Baby", "Baby wipes (80)", "مناديل أطفال (80)", 1500],
      ["First aid", "Plasters (20)", "لاصق جروح (20)", 1000],
    ],
  },
  other: {
    label: "Other retail",
    categories: [
      { name: "General", nameAr: "عام" },
      { name: "Services", nameAr: "خدمات" },
    ],
    samples: [
      ["General", "Sample item", "منتج تجريبي", 1000],
      ["Services", "Sample service", "خدمة تجريبية", 5000],
    ],
  },
};

export const BUSINESS_TYPES = Object.keys(TEMPLATES) as BusinessType[];

/** The seven emirates, with the short code used at the start of receipt numbers. */
export const EMIRATES = {
  dubai: { label: "Dubai", code: "DXB" },
  abu_dhabi: { label: "Abu Dhabi", code: "AUH" },
  sharjah: { label: "Sharjah", code: "SHJ" },
  ajman: { label: "Ajman", code: "AJM" },
  umm_al_quwain: { label: "Umm Al Quwain", code: "UAQ" },
  ras_al_khaimah: { label: "Ras Al Khaimah", code: "RAK" },
  fujairah: { label: "Fujairah", code: "FUJ" },
} as const;
export type Emirate = keyof typeof EMIRATES;
