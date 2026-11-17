import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { amount, buildPintXml, localDateTime, unitPrice, validatePint, type PintDocument } from "../src/einvoice/pint.js";
import { HttpProvider, SimulatorProvider, TransientError } from "../src/einvoice/providers.js";
import { backoffSeconds, processDue } from "../src/einvoice/queue.js";
import { makeOrder, openSession, postOrders, setup, teardown, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: { authorization: string };
let manager: { authorization: string };
let sessionId: string;

function api(method: "GET" | "POST" | "PUT", url: string, payload?: object, headers = owner) {
  return ctx.app.inject({ method, url: `/admin${url}`, headers, payload });
}

const BASE_SETTINGS = {
  enabled: true,
  scope: "all",
  provider: "simulator",
  simulatorMode: "accept",
  legalName: "Demo Minimart LLC",
  street: "Al Barsha 1",
  city: "Dubai",
  emirate: "DXB",
  maxAttempts: 8,
};

async function settings(patch: Record<string, unknown> = {}) {
  const res = await api("PUT", "/einvoicing/settings", { ...BASE_SETTINGS, ...patch });
  expect(res.statusCode, res.body).toBe(200);
}

async function sell(items = [{ variant: 0, qty: 2 }], opts: Parameters<typeof makeOrder>[3] = {}, customerId: string | null = null) {
  const order = makeOrder(ctx, sessionId, items, opts);
  order.customerId = customerId;
  const [result] = await postOrders(ctx, [order]);
  expect(result!.status).toBe("created");
  return order;
}

async function einvoiceOf(orderId: string) {
  const res = await api("GET", `/orders/${orderId}/einvoice`);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    enabled: boolean;
    einvoice: { id: string; kind: string; status: string; attempts: number; providerRef: string | null; lastError: string | null; forced: boolean } | null;
    attempts: { outcome: string; message: string | null; provider: string }[];
  };
}

/** Makes every waiting document due now, as if the backoff time had passed. */
const fastForward = () => ctx.db.query("UPDATE einvoices SET next_attempt_at = now() WHERE status = 'pending'");

beforeAll(async () => {
  ctx = await setup();
  const login = (email: string, password: string) =>
    ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email, password } });
  owner = { authorization: `Bearer ${(await login(ctx.data.ownerEmail, ctx.data.ownerPassword)).json().token}` };
  const { hashPassword } = await import("../src/security.js");
  await ctx.db.query("UPDATE users SET email = 'einv-manager@demo.ae', password_hash = $2 WHERE id = $1", [
    ctx.data.managerId,
    hashPassword("manager123"),
  ]);
  manager = { authorization: `Bearer ${(await login("einv-manager@demo.ae", "manager123")).json().token}` };
  sessionId = await openSession(ctx);
});
afterAll(async () => teardown(ctx));

describe("PINT AE XML", () => {
  const doc: PintDocument = {
    kind: "invoice",
    number: "DXB1-R1-0001-0001",
    uuid: "0b6f0c55-8f43-4e43-9a59-3d1c0c3b1a01",
    issuedAt: "2026-11-17T20:30:00Z",
    timezone: "Asia/Dubai",
    seller: { name: "Demo & Sons LLC", trn: "100000000000003", street: "Al Barsha 1", city: "Dubai", emirate: "DXB" },
    buyer: { name: "Acme <Trading>", trn: "100222333444003" },
    lines: [
      { lineNo: 1, name: "Water", qty: 3, uom: "unit", net: 1000, tax: 50, gross: 1050, category: "S", rateBp: 500, barcode: "6291003000014" },
      { lineNo: 2, name: "Bananas", qty: 0.375, uom: "kg", net: 298, tax: 0, gross: 298, category: "Z", rateBp: 0 },
      { lineNo: 3, name: "Gift voucher", qty: 1, uom: "unit", net: 5000, tax: 0, gross: 5000, category: "E", rateBp: 0 },
    ],
    cashRounding: 2,
    paymentKinds: ["cash"],
  };

  it("formats money without floats or separators", () => {
    expect(amount(123456)).toBe("1234.56");
    expect(amount(5)).toBe("0.05");
    expect(amount(-250)).toBe("-2.50");
    expect(unitPrice(1000, 3)).toBe("3.333333");
    expect(unitPrice(1000, 2)).toBe("5.00");
    expect(Number((3 * Number(unitPrice(1000, 3))).toFixed(2))).toBe(10);
  });

  it("uses the shop's local date and time", () => {
    expect(localDateTime("2026-11-17T20:30:00Z", "Asia/Dubai")).toEqual({ date: "2026-11-18", time: "00:30:00" });
  });

  it("builds an invoice with VAT per category and totals that add up", () => {
    const xml = buildPintXml(doc);
    expect(xml).toContain("<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:IssueDate>2026-11-18</cbc:IssueDate>");
    expect(xml).toContain('<cbc:EndpointID schemeID="0235">1000000000</cbc:EndpointID>');
    expect(xml).toContain("<cbc:CompanyID>100000000000003</cbc:CompanyID>");
    expect(xml).toContain("Demo &amp; Sons LLC");
    expect(xml).toContain("Acme &lt;Trading&gt;");
    expect(xml).toContain('<cbc:TaxAmount currencyID="AED">0.50</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="AED">62.98</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="AED">63.48</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PayableRoundingAmount currencyID="AED">0.02</cbc:PayableRoundingAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="AED">63.50</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="KGM">0.375</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:ID schemeID="0160">6291003000014</cbc:ID>');
    expect(xml).toContain("<cbc:TaxExemptionReason>Exempt supply</cbc:TaxExemptionReason>");
    expect(xml).toContain('<cbc:PaymentMeansCode name="Cash">10</cbc:PaymentMeansCode>');
    // One subtotal per category: S, Z and E.
    expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(3);
    expect(isBalanced(xml)).toBe(true);
  });

  it("builds a credit note that points at the invoice", () => {
    const xml = buildPintXml({
      ...doc,
      kind: "credit_note",
      number: "DXB1-R1-0001-0002",
      billingReference: { number: "DXB1-R1-0001-0001", issuedAt: "2026-11-17T08:00:00Z" },
    });
    expect(xml).toContain("<CreditNote xmlns=\"urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2\"");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toMatch(/<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>DXB1-R1-0001-0001<\/cbc:ID>/);
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="C62">3</cbc:CreditedQuantity>');
    expect(isBalanced(xml)).toBe(true);
  });

  it("explains what is missing in plain words", () => {
    const problems = validatePint({
      ...doc,
      kind: "credit_note",
      seller: { name: "", trn: "123", emirate: null },
      lines: [{ ...doc.lines[0]!, category: null, gross: 999 }],
    });
    expect(problems).toEqual([
      "The store TRN must have 15 digits.",
      "The seller's legal name is missing. Add it under E-invoicing settings.",
      "The seller's emirate is missing. Choose it under E-invoicing settings.",
      "A credit note needs the original invoice.",
      "Item 1 (Water) has no VAT rate.",
      "Item 1 (Water) amounts do not add up.",
    ]);
    expect(validatePint(doc)).toEqual([]);
  });
});

describe("providers", () => {
  const sub = { id: "doc-1", kind: "invoice" as const, number: "N1", previousAttempts: 0, xml: buildPintXml(minimalDoc()) };

  it("simulator answers by mode", async () => {
    expect(await new SimulatorProvider("accept").submit(sub)).toMatchObject({ outcome: "accepted", reference: expect.stringMatching(/^SIM-/) });
    await expect(new SimulatorProvider("flaky").submit(sub)).rejects.toBeInstanceOf(TransientError);
    expect((await new SimulatorProvider("flaky").submit({ ...sub, previousAttempts: 1 })).outcome).toBe("accepted");
    await expect(new SimulatorProvider("down").submit(sub)).rejects.toBeInstanceOf(TransientError);
    expect((await new SimulatorProvider("reject").submit(sub)).outcome).toBe("rejected");
    expect((await new SimulatorProvider("accept").submit({ ...sub, xml: "<Invoice/>" })).outcome).toBe("rejected");
  });

  it("HTTP adapter: 2xx accepts, 4xx rejects, 5xx and timeouts retry", async () => {
    const seen: { key: unknown; auth: unknown; type: unknown; body: unknown }[] = [];
    const server = Fastify();
    server.addContentTypeParser("application/xml", { parseAs: "string" }, (_r, body, done) => done(null, body));
    server.post("/ok", async (req) => {
      seen.push({ key: req.headers["idempotency-key"], auth: req.headers.authorization, type: req.headers["content-type"], body: req.body });
      return { reference: "ASP-42" };
    });
    server.post("/bad", async (_req, reply) => reply.status(400).send({ message: "BR-AE-01 TRN invalid" }));
    server.post("/down", async (_req, reply) => reply.status(503).send("maintenance"));
    server.post("/slow", async () => new Promise((r) => setTimeout(() => r({}), 500)));
    const base = await server.listen({ port: 0, host: "127.0.0.1" });
    try {
      expect(await new HttpProvider(`${base}/ok`, "k1").submit(sub)).toEqual({ outcome: "accepted", reference: "ASP-42", message: undefined });
      expect(seen[0]).toMatchObject({ key: "doc-1", auth: "Bearer k1", type: "application/xml", body: sub.xml });
      expect(await new HttpProvider(`${base}/bad`, null).submit(sub)).toEqual({
        outcome: "rejected",
        message: "The provider refused it (400): BR-AE-01 TRN invalid",
      });
      await expect(new HttpProvider(`${base}/down`, null).submit(sub)).rejects.toThrow("The provider answered 503: maintenance");
      await expect(new HttpProvider(`${base}/slow`, null, 50).submit(sub)).rejects.toThrow("did not answer in time");
      await expect(new HttpProvider("http://127.0.0.1:1/x", null).submit(sub)).rejects.toBeInstanceOf(TransientError);
    } finally {
      await server.close();
    }
  });

  it("backs off from 30 seconds up to 6 hours", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(30)).toBe(21_600);
  });
});

describe("e-invoice queue", () => {
  beforeEach(async () => {
    // Earlier documents must not leak into the next test's counts.
    await ctx.db.query("UPDATE einvoices SET status = 'accepted' WHERE status IN ('pending', 'sending')");
  });

  it("queues nothing while e-invoicing is off", async () => {
    const order = await sell();
    expect((await einvoiceOf(order.id))).toMatchObject({ enabled: false, einvoice: null });
  });

  it("only the owner changes settings, and the API key is never sent back", async () => {
    expect((await api("PUT", "/einvoicing/settings", BASE_SETTINGS, manager)).statusCode).toBe(403);
    const bad = await api("PUT", "/einvoicing/settings", { ...BASE_SETTINGS, provider: "http", endpointUrl: "" });
    expect(bad.statusCode).toBe(400);
    const plain = await api("PUT", "/einvoicing/settings", { ...BASE_SETTINGS, provider: "http", endpointUrl: "http://evil.example/x" });
    expect(plain.statusCode).toBe(400);
    await settings({ provider: "http", endpointUrl: "https://asp.example/v1/invoices", apiKey: "secret-1" });
    let got = (await api("GET", "/einvoicing/settings")).json();
    expect(got.settings).toMatchObject({ provider: "http", hasApiKey: true });
    expect(JSON.stringify(got)).not.toContain("secret-1");
    // Saving without a key keeps the old one.
    await settings({ provider: "http", endpointUrl: "https://asp.example/v1/invoices" });
    expect((await ctx.db.query("SELECT api_key FROM einvoice_settings")).rows[0].api_key).toBe("secret-1");
    await settings({ apiKey: "" });
    got = (await api("GET", "/einvoicing/settings")).json();
    expect(got.settings).toMatchObject({ provider: "simulator", hasApiKey: false, emirate: "DXB" });
    expect(got.stores[0].trn).toBe("100000000000003");
    const { rows } = await ctx.db.query("SELECT data FROM audit_log WHERE action = 'einvoicing.settings'");
    expect(JSON.stringify(rows)).not.toContain("secret-1");
  });

  it("sends a sale as soon as it syncs and stores the accepted XML", async () => {
    await settings();
    const order = await sell([{ variant: 0, qty: 2 }, { variant: 11, qty: 0.5 }], { pay: "cash" });
    expect((await einvoiceOf(order.id)).einvoice).toMatchObject({ kind: "invoice", status: "pending" });
    expect(await processDue(ctx.db)).toBe(1);
    const e = await einvoiceOf(order.id);
    expect(e.einvoice).toMatchObject({ status: "accepted", attempts: 1, providerRef: expect.stringMatching(/^SIM-/), lastError: null });
    expect(e.attempts).toMatchObject([{ outcome: "accepted", provider: "simulator" }]);

    const xml = await api("GET", `/einvoices/${e.einvoice!.id}/xml`);
    expect(xml.headers["content-type"]).toContain("application/xml");
    expect(xml.headers["content-disposition"]).toContain(`${order.number}.xml`);
    const stored = (await ctx.db.query("SELECT total, tax_total, subtotal_net, cash_rounding FROM orders WHERE id = $1", [order.id])).rows[0];
    expect(xml.body).toContain(`<cbc:ID>${order.number}</cbc:ID>`);
    expect(xml.body).toContain(`<cbc:TaxExclusiveAmount currencyID="AED">${amount(stored.subtotal_net)}</cbc:TaxExclusiveAmount>`);
    expect(xml.body).toContain(`<cbc:TaxInclusiveAmount currencyID="AED">${amount(stored.total)}</cbc:TaxInclusiveAmount>`);
    expect(xml.body).toContain(`<cbc:PayableAmount currencyID="AED">${amount(stored.total + stored.cash_rounding)}</cbc:PayableAmount>`);
    expect(xml.body).toContain('unitCode="KGM">0.5<');
    // Nothing is left to send.
    expect(await processDue(ctx.db)).toBe(0);
  });

  it("skips walk-in bills when only B2B is sent, and sends one on request", async () => {
    await settings({ scope: "b2b" });
    const walkIn = await sell();
    const customer = await api("POST", "/customers", { name: "Gulf Traders LLC", trn: "100222333444003" });
    const b2b = await sell([{ variant: 2, qty: 1 }], {}, customer.json().id);
    await processDue(ctx.db);
    const skipped = (await einvoiceOf(walkIn.id)).einvoice!;
    expect(skipped).toMatchObject({ status: "skipped", lastError: expect.stringContaining("Walk-in") });
    expect((await einvoiceOf(b2b.id)).einvoice!.status).toBe("accepted");
    const xml = (await api("GET", `/einvoices/${(await einvoiceOf(b2b.id)).einvoice!.id}/xml`)).body;
    expect(xml).toContain("Gulf Traders LLC");
    expect(xml).toContain("<cbc:CompanyID>100222333444003</cbc:CompanyID>");

    const retry = await api("POST", `/einvoices/${skipped.id}/retry`, {});
    expect(retry.json()).toMatchObject({ result: "accepted" });
    expect((await einvoiceOf(walkIn.id)).einvoice).toMatchObject({ status: "accepted", forced: true });
  });

  it("retries with backoff when the provider is unreachable", async () => {
    await settings({ simulatorMode: "flaky" });
    const order = await sell();
    await processDue(ctx.db);
    let e = (await einvoiceOf(order.id)).einvoice!;
    expect(e).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("not reachable") });
    const wait = (await ctx.db.query("SELECT next_attempt_at - now() AS w FROM einvoices WHERE id = $1", [e.id])).rows[0].w;
    expect(wait.seconds).toBeGreaterThan(20);
    // Not due yet.
    expect(await processDue(ctx.db)).toBe(0);
    await fastForward();
    await processDue(ctx.db);
    e = (await einvoiceOf(order.id)).einvoice!;
    expect(e).toMatchObject({ status: "accepted", attempts: 2, lastError: null });
    expect((await einvoiceOf(order.id)).attempts.map((a) => a.outcome)).toEqual(["accepted", "error"]);
  });

  it("gives up after the last try and can be queued again in bulk", async () => {
    await settings({ simulatorMode: "down", maxAttempts: 2 });
    const order = await sell();
    await processDue(ctx.db);
    await fastForward();
    await processDue(ctx.db);
    expect((await einvoiceOf(order.id)).einvoice).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: expect.stringContaining("Gave up after 2 tries"),
    });
    const list = (await api("GET", "/einvoices?status=failed")).json();
    expect(list.counts.failed).toBe(1);
    expect(list.einvoices[0]).toMatchObject({ number: order.number, status: "failed" });

    await settings({ simulatorMode: "accept" });
    expect((await api("POST", "/einvoices/retry-failed", {})).json()).toEqual({ queued: 1 });
    await processDue(ctx.db);
    expect((await einvoiceOf(order.id)).einvoice).toMatchObject({ status: "accepted", attempts: 1 });
  });

  it("keeps a rejection final until someone retries it", async () => {
    await settings({ simulatorMode: "reject" });
    const order = await sell();
    await processDue(ctx.db);
    await fastForward();
    expect(await processDue(ctx.db)).toBe(0);
    const e = (await einvoiceOf(order.id)).einvoice!;
    expect(e).toMatchObject({ status: "rejected", lastError: expect.stringContaining("reject") });
    await settings();
    expect((await api("POST", `/einvoices/${e.id}/retry`, {})).json().result).toBe("accepted");
    expect((await api("POST", `/einvoices/${e.id}/retry`, {})).statusCode).toBe(409);
  });

  it("fails without sending when the store has no TRN, then sends once it is fixed", async () => {
    await settings();
    await ctx.db.query("UPDATE stores SET trn = NULL");
    const order = await sell();
    await processDue(ctx.db);
    const e = (await einvoiceOf(order.id)).einvoice!;
    expect(e).toMatchObject({ status: "failed", attempts: 0, lastError: "The store has no TRN. Add it under Settings." });
    await ctx.db.query("UPDATE stores SET trn = '100000000000003'");
    expect((await api("POST", `/einvoices/${e.id}/retry`, {})).json().result).toBe("accepted");
  });

  it("sends a refund as a credit note after its invoice", async () => {
    await settings({ simulatorMode: "flaky" });
    const sale = await sell([{ variant: 0, qty: 3 }]);
    const refund = makeOrder(ctx, sessionId, [{ variant: 0, qty: -1 }], { refundOf: sale.id });
    await postOrders(ctx, [refund]);
    await processDue(ctx.db);
    // The invoice failed its first try, so the credit note waits for it.
    expect((await einvoiceOf(refund.id)).einvoice).toMatchObject({
      kind: "credit_note",
      status: "pending",
      attempts: 0,
      lastError: expect.stringContaining("original invoice"),
    });
    await fastForward();
    await processDue(ctx.db);
    expect((await einvoiceOf(sale.id)).einvoice!.status).toBe("accepted");
    await fastForward();
    await processDue(ctx.db);
    const cn = (await einvoiceOf(refund.id)).einvoice!;
    expect(cn.status).toBe("accepted");
    const xml = (await api("GET", `/einvoices/${cn.id}/xml`)).body;
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toContain(`<cbc:ID>${sale.number}</cbc:ID>`);
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>');
    expect(xml).not.toMatch(/currencyID="AED">-/);
  });

  it("sends the refund of a B2B invoice even when the refund has no customer", async () => {
    await settings({ scope: "b2b" });
    const customer = await api("POST", "/customers", { name: "Blue Sea Cafe", trn: "100555666777003" });
    const sale = await sell([{ variant: 4, qty: 2 }], {}, customer.json().id);
    await processDue(ctx.db);
    const refund = makeOrder(ctx, sessionId, [{ variant: 4, qty: -1 }], { refundOf: sale.id });
    await postOrders(ctx, [refund]);
    await processDue(ctx.db);
    const cn = (await einvoiceOf(refund.id)).einvoice!;
    expect(cn.status).toBe("accepted");
    expect((await api("GET", `/einvoices/${cn.id}/xml`)).body).toContain("Blue Sea Cafe");
  });

  it("sends an older bill on request", async () => {
    await api("PUT", "/einvoicing/settings", { ...BASE_SETTINGS, enabled: false });
    const old = await sell();
    expect((await api("POST", `/orders/${old.id}/einvoice`, {})).statusCode).toBe(409);
    await settings();
    const res = await api("POST", `/orders/${old.id}/einvoice`, {});
    expect(res.json()).toMatchObject({ result: "accepted" });
    expect((await api("POST", `/orders/${old.id}/einvoice`, {})).json().error).toBe("already_queued");
  });

  it("never sends a document twice when two workers run at once", async () => {
    await settings();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await sell()).id);
    const handled = await Promise.all([processDue(ctx.db, { batch: 2 }), processDue(ctx.db, { batch: 2 })]);
    expect(handled[0]! + handled[1]!).toBe(6);
    const { rows } = await ctx.db.query(
      `SELECT e.status, COUNT(a.id)::int AS sends FROM einvoices e LEFT JOIN einvoice_attempts a ON a.einvoice_id = e.id
        WHERE e.order_id = ANY($1) GROUP BY e.id`,
      [ids],
    );
    expect(rows).toEqual(Array(6).fill({ status: "accepted", sends: 1 }));
  });

  it("leaves documents alone while e-invoicing is turned off", async () => {
    await settings();
    const order = await sell();
    await api("PUT", "/einvoicing/settings", { ...BASE_SETTINGS, enabled: false });
    expect(await processDue(ctx.db)).toBe(0);
    expect((await einvoiceOf(order.id)).einvoice!.status).toBe("pending");
    expect((await api("POST", `/einvoices/${(await einvoiceOf(order.id)).einvoice!.id}/retry`, {})).statusCode).toBe(409);
  });

  it("keeps other businesses' e-invoices out of reach", async () => {
    await settings();
    const order = await sell();
    const id = (await einvoiceOf(order.id)).einvoice!.id;
    const { seed } = await import("../src/seed.js");
    const other = await seed(ctx.db);
    const login = await ctx.app.inject({ method: "POST", url: "/admin/login", payload: { email: other.ownerEmail, password: other.ownerPassword } });
    const them = { authorization: `Bearer ${login.json().token}` };
    expect((await api("GET", `/einvoices/${id}/xml`, undefined, them)).statusCode).toBe(404);
    expect((await api("POST", `/einvoices/${id}/retry`, {}, them)).statusCode).toBe(409);
    expect((await api("GET", `/orders/${order.id}/einvoice`, undefined, them)).statusCode).toBe(404);
    expect((await api("GET", "/einvoices", undefined, them)).json().count).toBe(0);
  });
});

function minimalDoc(): PintDocument {
  return {
    kind: "invoice",
    number: "N1",
    uuid: "u1",
    issuedAt: new Date(),
    timezone: "Asia/Dubai",
    seller: { name: "S", trn: "100000000000003", emirate: "DXB" },
    buyer: { name: "B" },
    lines: [{ lineNo: 1, name: "x", qty: 1, uom: "unit", net: 100, tax: 5, gross: 105, category: "S", rateBp: 500 }],
    cashRounding: 0,
    paymentKinds: ["card"],
  };
}

/** Every opening tag has its closing tag, in order. */
function isBalanced(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}
