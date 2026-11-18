import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderExport } from "../src/accounting/formats.js";
import { buildJournal, paymentAccount, type DayData, type Journal } from "../src/accounting/journal.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/accounting/settings.js";
import { parseCsv } from "../src/csv.js";
import { hashPassword } from "../src/security.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };

const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);
// A window around today, so a run that crosses midnight in Dubai still sees every bill.
const FROM = ymd(new Date(Date.now() - 86_400_000));
const TO = ymd(new Date(Date.now() + 86_400_000));
const RANGE = `from=${FROM}&to=${TO}`;

function api(method: "GET" | "POST" | "PUT", url: string, payload?: object, headers = owner) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
}
async function ok(method: "GET" | "POST" | "PUT", url: string, payload?: object, headers = owner) {
  const res = await api(method, url, payload, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const sum = (journals: Journal[], pick: (l: Journal["lines"][number]) => boolean) =>
  journals.flatMap((j) => j.lines).filter(pick).reduce((n, l) => n + l.amount, 0);

beforeAll(async () => {
  ctx = await setup();
  const login = (email: string, password: string) => ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  await ctx.db.query("UPDATE users SET email = 'acc-manager@demo.ae', password_hash = $2 WHERE id = $1", [ctx.data.managerId, hashPassword("manager123")]);
  manager = { authorization: `Bearer ${(await login("acc-manager@demo.ae", "manager123")).json().token}` };
});
afterAll(async () => teardown(ctx));

describe("building a day's journal", () => {
  const day: DayData = {
    date: "2026-11-17",
    storeId: randomUUID(),
    storeCode: "DXB1",
    storeName: "Dubai Marina",
    supplies: [
      { refund: false, kind: "standard", rateBp: 500, net: 10_000, vat: 500, lines: 3 },
      { refund: false, kind: "zero", rateBp: 0, net: 2_000, vat: 0, lines: 1 },
      { refund: true, kind: "standard", rateBp: 500, net: -1_000, vat: -50, lines: 1 },
    ],
    payments: [
      { methodId: randomUUID(), methodName: "Cash", kind: "cash", amount: 4_452, count: 2 },
      { methodId: randomUUID(), methodName: "Card", kind: "card", amount: 7_000, count: 1 },
    ],
    sales: 3,
    refunds: 1,
    total: 11_450,
    cashRounding: 2,
    cashVariance: -500,
    cashIn: 0,
    cashOut: 1_500,
  };

  it("balances, with VAT, rounding, refunds and the cash drawer on their own accounts", () => {
    const j = buildJournal(day, DEFAULT_CONFIG);
    expect(j.lines.reduce((n, l) => n + l.amount, 0)).toBe(0);
    expect(j.warnings).toEqual([]);
    expect(j.reference).toBe("POS-DXB1-20261117");
    const by = (code: string) => j.lines.filter((l) => l.account.code === code).reduce((n, l) => n + l.amount, 0);
    expect(by("4000")).toBe(-10_000);
    expect(by("4010")).toBe(-2_000);
    expect(by("4100")).toBe(1_000);
    expect(by("2200")).toBe(-450);
    expect(by("4900")).toBe(-2);
    expect(by("6900")).toBe(500);
    expect(by("6910")).toBe(1_500);
    expect(by("1000")).toBe(4_452 - 1_500 - 500);
    expect(by("1010")).toBe(7_000);
  });

  it("puts a payment difference on the rounding account and says so", () => {
    const j = buildJournal({ ...day, payments: [{ ...day.payments[0]!, amount: 4_400 }, day.payments[1]!] }, DEFAULT_CONFIG);
    expect(j.lines.reduce((n, l) => n + l.amount, 0)).toBe(0);
    expect(j.warnings.join(" ")).toContain("differ by AED 0.52");
  });

  it("writes Xero lines tax exclusive, with Xero's own VAT rounding absorbed", () => {
    // 3 standard lines whose VAT the bills rounded per line: Xero would compute 0.50 on 10.01.
    const odd: DayData = {
      ...day,
      supplies: [{ refund: false, kind: "standard", rateBp: 500, net: 1_001, vat: 51, lines: 3 }],
      payments: [{ methodId: randomUUID(), methodName: "Card", kind: "card", amount: 1_052, count: 1 }],
      cashRounding: 0,
      cashVariance: 0,
      cashOut: 0,
    };
    const j = buildJournal(odd, DEFAULT_CONFIG);
    const t = renderExport("xero", [odd], [j], DEFAULT_CONFIG);
    expect(t.header.slice(0, 6)).toEqual(["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount"]);
    expect(t.rows.some((r) => r[3] === "2200")).toBe(false);
    const sales = t.rows.find((r) => r[3] === "4000")!;
    expect(sales[4]).toBe("Standard Rated Income");
    expect(sales[5]).toBe("-10.01");
    expect(sales[1]).toBe("17/11/2026");
    // Xero adds -0.50 VAT itself; the bills say -0.51, so -0.01 more goes to rounding.
    const rounding = t.rows.find((r) => r[2] === "VAT rounding difference")!;
    expect(rounding[5]).toBe("-0.01");
    const xeroVat = -50;
    const total = t.rows.reduce((n, r) => n + Math.round(Number(r[5]) * 100), 0) + xeroVat;
    expect(total).toBe(0);
  });

  it("sends gift cards, store credit and loyalty to their own accounts", () => {
    expect(["cash", "card", "card_manual", "gift_card", "store_credit", "loyalty", "voucher"].map(paymentAccount)).toEqual([
      "cash", "card", "card", "giftCards", "storeCredit", "loyalty", "otherPayments",
    ]);
    const j = buildJournal(
      { ...day, payments: [...day.payments, { methodId: randomUUID(), methodName: "Gift card", kind: "gift_card", amount: 1_000, count: 1 }], cashRounding: 2, total: 12_450 },
      DEFAULT_CONFIG,
    );
    expect(j.lines.find((l) => l.description === "Gift card takings")!.account.code).toBe("2300");
  });

  it("falls back to defaults for anything missing from saved settings", () => {
    const c = mergeConfig({ accounts: { cash: { code: "101", name: "Petty cash" } } });
    expect(c.accounts.cash.name).toBe("Petty cash");
    expect(c.accounts.salesStandard).toEqual(DEFAULT_CONFIG.accounts.salesStandard);
    expect(mergeConfig({ dateFormat: "nonsense" })).toEqual(DEFAULT_CONFIG);
  });
});

describe("accounting export API", () => {
  let sessionId: string;
  let saleId: string;

  beforeAll(async () => {
    sessionId = await openSession(ctx);
    const cash = makeOrder(ctx, sessionId, [{ variant: 0, qty: 3 }, { variant: 1, qty: 1 }], { pay: "cash", tendered: 10_000 });
    const card = makeOrder(ctx, sessionId, [{ variant: 2, qty: 2 }], { pay: "card" });
    await postOrders(ctx, [cash, card]);
    saleId = card.id;
    const refund = makeOrder(ctx, sessionId, [{ variant: 2, qty: -1 }], { pay: "card", refundOf: saleId });
    const [r] = await postOrders(ctx, [refund]);
    expect(r!.status).toBe("created");
    const move = await ctx.app.inject({
      method: "POST",
      url: "/cash-moves",
      headers: ctx.auth,
      payload: { id: randomUUID(), sessionId, kind: "out", amount: 2_000, reason: "Milk delivery", userId: ctx.data.cashierId, at: new Date().toISOString() },
    });
    expect(move.statusCode, move.body).toBe(200);
    const summary = await ctx.app.inject({ method: "GET", url: `/sessions/${sessionId}/summary`, headers: ctx.auth });
    const expected = summary.json().expectedCash as number;
    const close = await ctx.app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/close`,
      headers: ctx.auth,
      payload: { closedBy: ctx.data.cashierId, closingCashCounted: expected - 250, closedAt: new Date().toISOString() },
    });
    expect(close.statusCode, close.body).toBe(200);
  });

  it("builds balanced journals that agree with the VAT report", async () => {
    const res = await ok("GET", `/accounting/journals?${RANGE}`);
    expect(res.configured).toBe(false);
    const journals = res.journals as Journal[];
    expect(journals.length).toBeGreaterThan(0);
    for (const j of journals) expect(j.lines.reduce((n, l) => n + l.amount, 0)).toBe(0);
    expect(res.totals.debit).toBe(res.totals.credit);
    expect(journals.flatMap((j) => j.warnings)).toEqual([]);

    const vat = await ok("GET", `/reports/vat?${RANGE}`);
    expect(-sum(journals, (l) => l.key === "vatOutput")).toBe(vat.boxes.standardRated.vat);
    expect(-sum(journals, (l) => l.key === "salesStandard" || l.key === "returns")).toBe(vat.boxes.standardRated.amount);
    expect(sum(journals, (l) => l.key === "overShort")).toBe(250);
    expect(sum(journals, (l) => l.key === "cashMovements")).toBe(2_000);
    expect(sum(journals, (l) => l.key === "returns")).toBeGreaterThan(0);
  });

  it("lets a manager look and export but only the owner change the accounts", async () => {
    await ok("GET", `/accounting/journals?${RANGE}`, undefined, manager);
    const settings = await ok("GET", "/accounting/settings", undefined, manager);
    const res = await api("PUT", "/accounting/settings", settings.config, manager);
    expect(res.statusCode).toBe(403);
  });

  it("saves the owner's accounts and uses them, including a per-method account", async () => {
    const s = await ok("GET", "/accounting/settings");
    expect(s.methods.length).toBe(3);
    const card = s.methods.find((m: { kind: string }) => m.kind === "card");
    const config = {
      ...s.config,
      accounts: { ...s.config.accounts, salesStandard: { code: "200", name: "Sales" }, vatOutput: { code: "820", name: "VAT" } },
      methodAccounts: { [card.id]: { code: "615", name: "Network International clearing" } },
      storeEmirates: { [ctx.data.storeId]: "SHJ" },
    };
    await ok("PUT", "/accounting/settings", config);
    const res = await ok("GET", `/accounting/journals?${RANGE}`);
    expect(res.configured).toBe(true);
    const lines = (res.journals as Journal[]).flatMap((j) => j.lines);
    expect(lines.some((l) => l.account.code === "200")).toBe(true);
    expect(lines.some((l) => l.account.code === "615" && l.description === "Card takings")).toBe(true);
    expect(lines.some((l) => l.account.code === "1010")).toBe(false);

    const foreign = await api("PUT", "/accounting/settings", { ...config, methodAccounts: { [randomUUID()]: { code: "1", name: "x" } } });
    expect(foreign.statusCode).toBe(400);
    const blank = await api("PUT", "/accounting/settings", { ...config, accounts: { ...config.accounts, cash: { code: "1", name: "" } } });
    expect(blank.statusCode).toBe(400);
  });

  it("exports each tool's format, balanced, and remembers what was exported", async () => {
    const get = async (format: string) => {
      const res = await api("GET", `/accounting/export?${RANGE}&format=${format}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      return { body: res.body, rows: parseCsv(res.body), disposition: String(res.headers["content-disposition"]) };
    };
    const cents = (s: string | undefined) => (s ? Math.round(Number(s) * 100) : 0);

    const generic = await get("generic");
    expect(generic.rows[0]).toEqual(["Date", "Journal", "Store", "Account code", "Account name", "Description", "Debit", "Credit", "VAT rate %"]);
    const gl = generic.rows.slice(1);
    expect(gl.reduce((n, r) => n + cents(r[6]) - cents(r[7]), 0)).toBe(0);

    const qb = await get("quickbooks");
    expect(qb.body.charCodeAt(0)).not.toBe(0xfeff);
    expect(qb.rows[0]!.slice(0, 5)).toEqual(["Journal No", "Journal Date", "Account Name", "Debits", "Credits"]);
    expect(qb.rows.slice(1).reduce((n, r) => n + cents(r[3]) - cents(r[4]), 0)).toBe(0);
    expect(qb.rows[1]![1]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(qb.disposition).toContain("quickbooks-journal-entries-");

    const zoho = await get("zoho");
    expect(zoho.rows[0]!.slice(0, 2)).toEqual(["Journal Date", "Reference Number"]);
    expect(zoho.rows.slice(1).reduce((n, r) => n + cents(r[7]) - cents(r[8]), 0)).toBe(0);

    const xero = await get("xero");
    expect(xero.rows[0]![0]).toBe("*Narration");
    expect(xero.rows.slice(1).every((r) => r[3] !== "820")).toBe(true);
    expect(xero.rows.slice(1).some((r) => r[4] === "Standard Rated Income")).toBe(true);

    for (const f of ["sales", "vat", "payments"]) {
      const listing = await get(f);
      expect(listing.rows.length).toBeGreaterThan(1);
    }
    const payments = await get("payments");
    expect(payments.rows.some((r) => r[2] === "Cash paid out" && r[4] === "-20.00")).toBe(true);

    const log = await ok("GET", "/accounting/exports");
    expect(log.exports.map((e: { format: string }) => e.format).sort()).toEqual(["generic", "quickbooks", "xero", "zoho"]);
    const again = await ok("GET", `/accounting/journals?${RANGE}`);
    expect(again.overlapping.length).toBeGreaterThan(0);
    expect(again.overlapping[0].by).toBe("Omar (Owner)");

    const audit = await ctx.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'accounting.export'");
    expect(audit.rows[0].n).toBe(4);
  });

  it("refuses bad ranges and unknown formats", async () => {
    expect((await api("GET", `/accounting/journals?from=${TO}&to=${FROM}`)).statusCode).toBe(400);
    expect((await api("GET", "/accounting/journals?from=2020-01-01&to=2026-01-01")).statusCode).toBe(400);
    expect((await api("GET", `/accounting/export?${RANGE}&format=sage`)).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "GET", url: `/admin/accounting/journals?${RANGE}` })).statusCode).toBe(401);
  });

  it("fills the VAT 201 return: emirate boxes, credit notes, purchases and tax payable", async () => {
    await ok("POST", "/receipts", { storeId: ctx.data.storeId, lines: [{ variantId: ctx.data.variants[0]!.id, qty: 10, unitCost: 1_000 }] });
    const v = await ok("GET", `/accounting/vat-return?from=${FROM}&to=${TO}`);
    const vat = await ok("GET", `/reports/vat?${RANGE}`);
    const shj = v.emirates.find((e: { emirate: string }) => e.emirate === "SHJ");
    expect(shj.box).toBe("1c");
    expect(shj.amount).toBe(vat.boxes.standardRated.amount);
    expect(shj.vat).toBe(vat.boxes.standardRated.vat);
    expect(v.unassigned).toEqual([]);
    expect(v.creditNotes.amount).toBeGreaterThan(0);
    expect(v.box9Purchases).toEqual({ amount: 10_000, vat: 500, receipts: 1 });
    expect(v.box14Payable).toBe(v.box12TotalDue - 500);

    // Without an emirate the sales are held back and named, so the return is not filed wrong.
    const s = await ok("GET", "/accounting/settings");
    await ok("PUT", "/accounting/settings", { ...s.config, storeEmirates: {} });
    const bare = await ok("GET", `/accounting/vat-return?from=${FROM}&to=${TO}`);
    expect(bare.unassigned).toHaveLength(1);
    expect(bare.unassigned[0].vat).toBe(vat.boxes.standardRated.vat);

    // The e-invoicing emirate is the fallback.
    await ctx.db.query("INSERT INTO einvoice_settings (tenant_id, emirate) VALUES ($1, 'DXB')", [ctx.data.tenantId]);
    const dxb = await ok("GET", `/accounting/vat-return?from=${FROM}&to=${TO}`);
    expect(dxb.emirates.find((e: { emirate: string }) => e.emirate === "DXB").vat).toBe(vat.boxes.standardRated.vat);

    const csv = await api("GET", `/accounting/vat-return?from=${FROM}&to=${TO}&format=csv`);
    const rows = parseCsv(csv.body);
    expect(rows[0]).toEqual(["Box", "Description", "Amount (AED)", "VAT (AED)"]);
    expect(rows.find((r) => r[0] === "14")![3]).toBe(((dxb.box14Payable as number) / 100).toFixed(2));
  });

  it("keeps each business's books to itself", async () => {
    const other = randomUUID();
    await ctx.db.query("INSERT INTO tenants (id, name) VALUES ($1, 'Other LLC')", [other]);
    const res = await ok("GET", `/accounting/journals?${RANGE}&storeId=${randomUUID()}`);
    expect(res.journals).toEqual([]);
  });
});
