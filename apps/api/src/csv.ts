/** Minimal RFC 4180 CSV, enough for spreadsheets exported from Excel or Google Sheets. */

/**
 * A cell that starts with = + @ or a tab is run as a formula by spreadsheet apps, so it is
 * prefixed with an apostrophe. A leading minus is only escaped when it is not a number.
 */
function safeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // A BOM makes Excel open UTF-8 (Arabic names) correctly.
  return "﻿" + [header, ...rows].map((r) => r.map(safeCell).join(",")).join("\r\n") + "\r\n";
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** "2.50" or "2.5" or "2" AED → 250 fils. Returns null when it is not a money amount. */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(/^AED\s*/i, "").replaceAll(",", "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const money = (fils: number | null | undefined) => (fils === null || fils === undefined ? "" : (fils / 100).toFixed(2));
