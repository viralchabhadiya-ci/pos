import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import type { PromoEnv } from "./cart.js";
import { db, type DeviceSetup } from "./db.js";

export interface Pricing {
  /** The price of a variant for this sale: the customer's list, else the store's, else its own. */
  priceOf: (variantId: string) => number | undefined;
  env: PromoEnv;
  /** Name of the customer's price list when it is in use, to show on the cart. */
  listName: string | null;
}

/** Everything the till needs to price a sale, read from the local catalog so it works offline. */
export function usePricing(setup: DeviceSetup, customerPriceListId: string | null | undefined): Pricing | undefined {
  const storeListId = setup.store.priceListId ?? null;
  const data = useLiveQuery(async () => {
    const [products, variants, promotions, lists] = await Promise.all([
      db.products.toArray(),
      db.variants.toArray(),
      db.promotions.toArray(),
      db.priceLists.toArray(),
    ]);
    const live = new Set(lists.filter((l) => l.active).map((l) => l.id));
    const listPrices = async (id: string | null | undefined) => {
      if (!id || !live.has(id)) return null;
      const items = await db.priceListItems.where("priceListId").equals(id).toArray();
      return new Map(items.filter((i) => i.active).map((i) => [i.variantId, i.price]));
    };
    return {
      products,
      variants,
      promotions: promotions.filter((p) => p.active),
      store: await listPrices(storeListId),
      customer: await listPrices(customerPriceListId),
      customerListName: customerPriceListId && live.has(customerPriceListId) ? (lists.find((l) => l.id === customerPriceListId)?.name ?? null) : null,
    };
  }, [storeListId, customerPriceListId]);

  return useMemo(() => {
    if (!data) return undefined;
    const own = new Map(data.variants.map((v) => [v.id, v.price]));
    const productOf = new Map(data.products.map((p) => [p.id, p]));
    const products = new Map(
      data.variants.map((v) => [v.id, { productId: v.productId, categoryId: productOf.get(v.productId)?.categoryId ?? null }]),
    );
    return {
      priceOf: (id: string) => data.customer?.get(id) ?? data.store?.get(id) ?? own.get(id),
      env: { promotions: data.promotions, products, storeId: setup.store.id, timezone: setup.store.timezone },
      listName: data.customerListName,
    };
  }, [data, setup.store.id, setup.store.timezone]);
}
