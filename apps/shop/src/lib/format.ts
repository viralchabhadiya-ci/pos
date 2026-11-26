const fmt = new Intl.NumberFormat("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fils as AED with two decimals, e.g. 1234 → "12.34". */
export const money = (fils: number) => fmt.format(fils / 100);
export const aed = (fils: number) => `AED ${money(fils)}`;
export const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(1));
