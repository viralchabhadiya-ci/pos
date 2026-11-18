import { isValidEan13 } from "@pos/core";

/**
 * Barcodes drawn for printed labels, as runs of bars. EAN-13 for retail barcodes (what scanners
 * expect on a product), Code 128 for anything else (SKUs, shop codes).
 */

export interface Bars {
  kind: "ean13" | "code128";
  /** One entry per module: true is a bar. */
  modules: boolean[];
  /** The text printed under the bars. */
  text: string;
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = L.map((p) => [...p].map((b) => (b === "0" ? "1" : "0")).join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

export function ean13(code: string): Bars {
  if (!isValidEan13(code)) throw new Error(`Not an EAN-13: ${code}`);
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  let bits = "101";
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === "L" ? L : G)[d[i]!];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[d[i]!];
  bits += "101";
  return { kind: "ean13", modules: [...bits].map((b) => b === "1"), text: code };
}

/** Code 128 bar and space widths for values 0 to 105, then the stop. */
export const CODE128 = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
const STOP = "2331112";
const START_B = 104;

/** Code 128 (set B: printable ASCII), with its check symbol. */
export function code128(text: string): Bars {
  if (!/^[\x20-\x7e]{1,40}$/.test(text)) throw new Error("Code 128 labels take 1 to 40 plain characters");
  const values = [START_B, ...[...text].map((c) => c.charCodeAt(0) - 32)];
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  const widths = [...values, check].map((v) => CODE128[v]!).join("") + STOP;
  const modules: boolean[] = [];
  [...widths].forEach((w, i) => {
    for (let k = 0; k < Number(w); k++) modules.push(i % 2 === 0);
  });
  return { kind: "code128", modules, text };
}

/** The right barcode for a product's code. */
export function barsFor(code: string): Bars {
  return isValidEan13(code) ? ean13(code) : code128(code);
}
