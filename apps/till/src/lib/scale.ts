import { DEFAULT_SCALE_RULES, type ScaleBarcodeRule } from "@pos/core";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db.js";

/** How this business's scales print barcodes, as last synced. */
export async function getScaleRules(): Promise<ScaleBarcodeRule[]> {
  return (await db.getMeta<ScaleBarcodeRule[]>("scaleRules")) ?? DEFAULT_SCALE_RULES;
}

export function useScaleRules(): ScaleBarcodeRule[] {
  return useLiveQuery(getScaleRules, []) ?? DEFAULT_SCALE_RULES;
}
