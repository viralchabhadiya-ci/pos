/** What the customer is buying, by product variant, kept on the phone per shop. */
export type Basket = Record<string, number>;

const key = (slug: string) => `shop-basket:${slug}`;

export function loadBasket(slug: string): Basket {
  try {
    const raw = JSON.parse(localStorage.getItem(key(slug)) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, q]) => typeof q === "number" && q > 0)) as Basket;
  } catch {
    return {};
  }
}

export function saveBasket(slug: string, basket: Basket) {
  try {
    if (Object.keys(basket).length) localStorage.setItem(key(slug), JSON.stringify(basket));
    else localStorage.removeItem(key(slug));
  } catch {
    // Private browsing: the basket lasts until the page closes.
  }
}

/** Sets one item's quantity; 0 or less takes it out. Weighed items move in half kilos. */
export function setQty(basket: Basket, variantId: string, qty: number): Basket {
  const next = { ...basket };
  const q = Math.round(qty * 10) / 10;
  if (q <= 0) delete next[variantId];
  else next[variantId] = Math.min(q, 999);
  return next;
}

export const stepOf = (uom: string | null) => (uom === "kg" ? 0.5 : 1);
export const countItems = (b: Basket) => Object.keys(b).length;
