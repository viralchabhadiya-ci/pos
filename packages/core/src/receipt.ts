export interface ReceiptNumberParts {
  storeCode: string;
  registerCode: string;
  sessionSeq: number;
  orderSeq: number;
}

/**
 * Receipt numbers are generated on the device so they work offline, and are still unique
 * and sequential per register: STORE-REGISTER-SESSION-ORDER, e.g. DXB1-R1-0005-0012.
 */
export function formatReceiptNumber(p: ReceiptNumberParts): string {
  return [p.storeCode, p.registerCode, String(p.sessionSeq).padStart(4, "0"), String(p.orderSeq).padStart(4, "0")].join("-");
}

export function parseReceiptNumber(value: string): ReceiptNumberParts | null {
  const m = /^([A-Z0-9]+)-([A-Z0-9]+)-(\d{4,})-(\d{4,})$/.exec(value);
  if (!m) return null;
  return { storeCode: m[1]!, registerCode: m[2]!, sessionSeq: Number(m[3]), orderSeq: Number(m[4]) };
}
