import { DEFAULT_LOYALTY, type LoyaltySettings } from "@pos/core";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db.js";

/** The points programme as last synced; off until the first sync says otherwise. */
export async function getLoyalty(): Promise<LoyaltySettings> {
  return (await db.getMeta<LoyaltySettings>("loyalty")) ?? DEFAULT_LOYALTY;
}

export function useLoyalty(): LoyaltySettings {
  return useLiveQuery(getLoyalty, []) ?? DEFAULT_LOYALTY;
}
