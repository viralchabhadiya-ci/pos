import { SCOPES } from "./auth.js";
import { API_VERSION, EVENT_TYPES } from "../webhooks/events.js";
import { MAX_ATTEMPTS, RETRY_DELAYS_S } from "../webhooks/deliver.js";

type Schema = Record<string, unknown>;

const str = (description?: string, extra: Schema = {}): Schema => ({ type: "string", ...(description ? { description } : {}), ...extra });
const nstr = (description?: string): Schema => ({ type: ["string", "null"], ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: "integer", ...(description ? { description } : {}) });
const nint = (description?: string): Schema => ({ type: ["integer", "null"], ...(description ? { description } : {}) });
const num = (description?: string): Schema => ({ type: "number", ...(description ? { description } : {}) });
const bool = (description?: string): Schema => ({ type: "boolean", ...(description ? { description } : {}) });
const uuid = (description?: string): Schema => str(description, { format: "uuid" });
const nuuid = (description?: string): Schema => ({ type: ["string", "null"], format: "uuid", ...(description ? { description } : {}) });
const time = (description?: string): Schema => str(description, { format: "date-time" });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
});
const list = (item: string): Schema =>
  obj({ data: { type: "array", items: ref(item) }, nextCursor: nstr("Pass as cursor to get the next page; null on the last page") });
const fils = (d: string) => int(`${d}, in fils (1 AED = 100 fils)`);

const PRODUCT_FIELDS: Record<string, Schema> = {
  name: str("Name on the till and receipt", { maxLength: 160 }),
  nameAr: nstr("Arabic name, printed on Arabic receipts"),
  categoryId: nuuid(),
  uom: str("unit, or kg for goods sold by weight", { enum: ["unit", "kg"] }),
  taxId: nuuid("The VAT rate; see the back office for ids"),
  price: fils("Selling price, VAT included"),
  cost: nint("Cost price in fils"),
  barcode: nstr(),
  extraBarcodes: { type: "array", items: str(), description: "More barcodes that ring up the same product" },
  sku: nstr(),
  plu: nstr("Item code on the shop's scale, up to 6 digits"),
  reorderLevel: { type: ["number", "null"], description: "stock.low fires when stock falls to this" },
  active: bool("false hides it from the tills"),
};

const CUSTOMER_FIELDS: Record<string, Schema> = {
  name: str(undefined, { maxLength: 200 }),
  phone: nstr("Unique per business"),
  email: nstr(),
  trn: nstr("A business customer's 15-digit VAT number"),
  priceListId: nuuid("Their own price list, if any"),
};

const schemas: Record<string, Schema> = {
  Error: obj({ error: str("A stable code such as not_found, missing_scope, rate_limited"), message: str("Readable explanation") }, ["error"]),
  Store: obj({
    id: uuid(),
    code: str(),
    name: str(),
    nameAr: nstr(),
    address: nstr(),
    phone: nstr(),
    trn: nstr(),
    timezone: str(),
    registers: { type: "array", items: obj({ id: uuid(), code: str(), name: str() }) },
  }),
  Product: obj({
    id: uuid(),
    variantId: uuid("Order lines and stock refer to this"),
    ...PRODUCT_FIELDS,
    categoryName: nstr(),
    taxRateBp: nint("VAT rate in basis points, 500 = 5%"),
    updatedAt: time(),
  }),
  ProductInput: obj(PRODUCT_FIELDS, ["name", "price"]),
  Customer: obj({ id: uuid(), ...CUSTOMER_FIELDS, points: int("Loyalty points balance"), updatedAt: time() }),
  CustomerInput: obj(CUSTOMER_FIELDS, ["name"]),
  OrderLine: obj({
    id: uuid(),
    lineNo: int(),
    productId: nuuid("null for a gift card line"),
    variantId: nuuid(),
    sku: nstr(),
    barcode: nstr(),
    name: str(),
    qty: num("Negative on refunds"),
    unitPrice: fils("Price per unit"),
    discountBp: int("Manual line discount in basis points"),
    discount: fils("All discounts on the line: manual, bill and promotion"),
    promotionId: nuuid(),
    taxId: nuuid(),
    taxRateBp: nint(),
    net: fils("Line amount without VAT"),
    tax: fils("VAT"),
    gross: fils("Line amount with VAT"),
    giftCardCode: nstr("Set when the line sells a gift card"),
    note: nstr(),
  }),
  Payment: obj({
    id: uuid(),
    kind: str("How it was paid", { enum: ["cash", "card", "card_manual", "gift_card", "points"] }),
    method: str("The payment method's name"),
    amount: fils("Amount paid"),
    tendered: nint("Cash handed over"),
    change: fils("Change given"),
    reference: nstr("Card approval code or similar"),
    points: nint("Points used, for points payments"),
  }),
  Order: obj({
    id: uuid(),
    number: str("Receipt number, e.g. DXB1-R1-0003-0042"),
    type: str(undefined, { enum: ["sale", "refund"] }),
    refundOfOrderId: nuuid("The sale this refunds"),
    storeId: uuid(),
    storeCode: str(),
    registerId: uuid(),
    sessionId: uuid("The till shift"),
    cashier: obj({ id: uuid(), name: str() }),
    customer: { type: ["object", "null"], properties: { id: uuid(), name: str() } },
    currency: str(undefined, { example: "AED" }),
    amountTotal: fils("Before discounts"),
    discountTotal: fils("All discounts"),
    subtotalNet: fils("Without VAT"),
    taxTotal: fils("VAT"),
    total: fils("To pay, VAT included; negative on refunds"),
    cashRounding: fils("Cash rounding to the nearest 25 fils"),
    createdAt: time("When the till rang it up"),
    syncedAt: time("When it reached the server; tills that were offline sync late"),
    lines: { type: "array", items: ref("OrderLine") },
    payments: { type: "array", items: ref("Payment") },
  }),
  StockLevel: obj({
    productId: uuid(),
    variantId: uuid(),
    name: str(),
    sku: nstr(),
    barcode: nstr(),
    uom: str(),
    storeId: uuid(),
    storeCode: str(),
    onHand: num(),
    reorderLevel: { type: ["number", "null"] },
  }),
  Adjustment: obj({
    storeId: uuid(),
    reason: str("adjust: a correction either way. waste: goods written off (positive qty, note required)", { enum: ["adjust", "waste"] }),
    note: nstr(),
    lines: { type: "array", items: obj({ productId: uuid(), qty: num("Signed for adjust, positive for waste") }) },
  }, ["storeId", "reason", "lines"]),
  DailySales: obj({
    storeId: uuid(),
    storeCode: str(),
    date: str("Day in the store's time zone", { format: "date" }),
    salesCount: int(),
    refundCount: int(),
    grossSales: fils("Sales total with VAT"),
    refunds: fils("Refunds total (negative)"),
    discounts: fils("Discounts given"),
    netSales: fils("Sales less refunds, without VAT"),
    vat: fils("VAT"),
    total: fils("Sales less refunds, with VAT"),
  }),
  WebhookEvent: obj({
    id: uuid("Same as the POS-Event-Id header; use it to ignore duplicates"),
    type: str(undefined, { enum: Object.keys(EVENT_TYPES) }),
    apiVersion: str(undefined, { example: API_VERSION }),
    createdAt: time(),
    data: { type: "object", description: "order.*: an Order. customer.*: a Customer. product.*: a Product. stock.low: a StockLevel. session.closed: the shift summary." },
  }),
};

const errors = {
  "400": { description: "The request is not valid", content: { "application/json": { schema: ref("Error") } } },
  "401": { description: "No API key, or the key is revoked or expired", content: { "application/json": { schema: ref("Error") } } },
  "403": { description: "The key lacks the scope this needs", content: { "application/json": { schema: ref("Error") } } },
  "429": {
    description: "Rate limit reached; wait for Retry-After seconds",
    headers: { "Retry-After": { schema: int() } },
    content: { "application/json": { schema: ref("Error") } },
  },
};
const notFoundResp = { "404": { description: "Not found", content: { "application/json": { schema: ref("Error") } } } };
const json = (schema: Schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
const q = (name: string, schema: Schema, description: string, required = false) => ({ name, in: "query", required, description, schema });
const pathId = { name: "id", in: "path", required: true, schema: uuid() };
const paging = [q("limit", int(), "1 to 200, default 50"), q("cursor", str(), "nextCursor from the previous page")];
const idem = { name: "Idempotency-Key", in: "header", required: false, schema: str(), description: "Any unique string; a retry with the same key returns the first answer instead of creating twice" };

function op(scope: string | null, summary: string, rest: Schema) {
  const description = [scope ? `Needs the **${scope}** scope.` : null, rest.description].filter(Boolean).join(" ");
  return {
    summary,
    ...rest,
    ...(description ? { description } : {}),
    ...(scope ? { "x-scope": scope } : {}),
    responses: { ...(rest.responses as object), ...errors },
  };
}

export function openApiSpec() {
  const retries = RETRY_DELAYS_S.map((s) => (s < 3600 ? `${s / 60} min` : `${s / 3600} h`)).join(", ");
  return {
    openapi: "3.1.0",
    info: {
      title: "POS public API",
      version: API_VERSION,
      description: [
        "Connect your online shop, ERP, accounting or delivery app to your POS.",
        "",
        "**Keys.** The owner creates API keys in the back office under Developers. Send one on every request as `Authorization: Bearer pos_live_…`. Each key has scopes; write scopes include reading the same data.",
        "",
        "**Rate limits.** Each key allows a number of requests a minute (120 unless the owner set another). Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (unix seconds). Over the limit you get 429 with `Retry-After`.",
        "",
        "**Money and numbers.** Amounts are integers in fils (AED 12.50 is 1250). Quantities have up to 3 decimals. Times are ISO 8601 in UTC.",
        "",
        "**Paging.** Lists return `{ data, nextCursor }`, oldest change first. Keep calling with `cursor` until `nextCursor` is null. Save the last `updatedAt` (or `syncedAt` for orders) to pick up only changes next time.",
        "",
        "**Retries.** POST requests accept an `Idempotency-Key` header; answers are kept for 24 hours.",
        "",
        "**Webhooks.** Instead of polling, add a webhook URL in the back office. Each event is a POST with a JSON body (see WebhookEvent) and these headers: `POS-Event-Id`, `POS-Event-Type`, `POS-Delivery-Id` and `POS-Signature: t=<unix seconds>,v1=<hex>`. To check it, compute HMAC-SHA256 of `<t>.<raw body>` with the endpoint's signing secret and compare with `v1`; reject a `t` more than 5 minutes old. Answer any 2xx within 10 seconds. Otherwise the delivery is tried again after " +
          `${retries} (${MAX_ATTEMPTS} tries in all), and an endpoint that fails for 3 days is turned off. The same event can arrive more than once and out of order, so use the event id to skip duplicates.`,
        "",
        "**Events.** " + Object.entries(EVENT_TYPES).map(([k, v]) => `\`${k}\`: ${v}.`).join(" "),
      ].join("\n"),
    },
    servers: [{ url: process.env.PUBLIC_API_URL ?? "/" }],
    security: [{ apiKey: [] }],
    tags: [
      { name: "Account" }, { name: "Stores" }, { name: "Products" }, { name: "Customers" }, { name: "Orders" }, { name: "Inventory" }, { name: "Reports" },
    ],
    paths: {
      "/v1/me": { get: { tags: ["Account"], ...op(null, "The business and the key in use", { responses: { "200": json(obj({ business: obj({ id: uuid(), name: str(), country: str(), currency: str() }), key: obj({ id: uuid(), name: str(), scopes: { type: "array", items: str() } }) })) } }) } },
      "/v1/stores": { get: { tags: ["Stores"], ...op("stores:read", "List stores with their registers", { responses: { "200": json(obj({ data: { type: "array", items: ref("Store") } })) } }) } },
      "/v1/products": {
        get: {
          tags: ["Products"],
          ...op("products:read", "List products", {
            parameters: [
              q("updatedSince", time(), "Only products changed at or after this time"),
              q("q", str(), "Search the name, or an exact SKU"),
              q("barcode", str(), "Exact barcode, main or extra"),
              q("active", str(undefined, { enum: ["true", "false"] }), "Only products on sale, or only hidden ones"),
              ...paging,
            ],
            responses: { "200": json(list("Product")) },
          }),
        },
        post: {
          tags: ["Products"],
          ...op("products:write", "Add a product", {
            parameters: [idem],
            requestBody: { required: true, content: { "application/json": { schema: ref("ProductInput") } } },
            responses: { "201": json(ref("Product"), "Created"), "409": json(ref("Error"), "Barcode or scale code already used") },
          }),
        },
      },
      "/v1/products/{id}": {
        get: { tags: ["Products"], ...op("products:read", "Get a product", { parameters: [pathId], responses: { "200": json(ref("Product")), ...notFoundResp } }) },
        patch: {
          tags: ["Products"],
          ...op("products:write", "Change a product", {
            description: "Send only the fields to change, e.g. `{\"price\": 1250}`. Tills pick the change up on their next sync.",
            parameters: [pathId],
            requestBody: { required: true, content: { "application/json": { schema: { ...ref("ProductInput"), required: [] } } } },
            responses: { "200": json(ref("Product")), ...notFoundResp },
          }),
        },
      },
      "/v1/customers": {
        get: {
          tags: ["Customers"],
          ...op("customers:read", "List customers", {
            parameters: [
              q("updatedSince", time(), "Only customers changed at or after this time (points changes count)"),
              q("q", str(), "Search the name"),
              q("phone", str(), "Exact phone number"),
              q("email", str(), "Exact email, any case"),
              ...paging,
            ],
            responses: { "200": json(list("Customer")) },
          }),
        },
        post: {
          tags: ["Customers"],
          ...op("customers:write", "Add a customer", {
            parameters: [idem],
            requestBody: { required: true, content: { "application/json": { schema: ref("CustomerInput") } } },
            responses: { "201": json(ref("Customer"), "Created"), "409": json(ref("Error"), "Phone number already used") },
          }),
        },
      },
      "/v1/customers/{id}": {
        get: { tags: ["Customers"], ...op("customers:read", "Get a customer", { parameters: [pathId], responses: { "200": json(ref("Customer")), ...notFoundResp } }) },
        patch: {
          tags: ["Customers"],
          ...op("customers:write", "Change a customer", {
            description: "Send only the fields to change.",
            parameters: [pathId],
            requestBody: { required: true, content: { "application/json": { schema: { ...ref("CustomerInput"), required: [] } } } },
            responses: { "200": json(ref("Customer")), ...notFoundResp },
          }),
        },
      },
      "/v1/orders": {
        get: {
          tags: ["Orders"],
          ...op("orders:read", "List sales and refunds", {
            description: "Sorted by syncedAt, the time the order reached the server. Sync with syncedSince so orders from tills that were offline are not missed.",
            parameters: [
              q("syncedSince", time(), "Only orders that reached the server at or after this time"),
              q("from", time(), "Rung up at or after"),
              q("to", time(), "Rung up before"),
              q("storeId", uuid(), "One store"),
              q("customerId", uuid(), "One customer"),
              q("type", str(undefined, { enum: ["sale", "refund"] }), "Only sales or only refunds"),
              ...paging,
            ],
            responses: { "200": json(list("Order")) },
          }),
        },
      },
      "/v1/orders/{id}": { get: { tags: ["Orders"], ...op("orders:read", "Get an order", { parameters: [pathId], responses: { "200": json(ref("Order")), ...notFoundResp } }) } },
      "/v1/inventory": {
        get: {
          tags: ["Inventory"],
          ...op("inventory:read", "Stock on hand per product and store", {
            parameters: [q("storeId", uuid(), "One store"), q("productId", uuid(), "One product"), ...paging],
            responses: { "200": json(list("StockLevel")) },
          }),
        },
      },
      "/v1/inventory/adjustments": {
        post: {
          tags: ["Inventory"],
          ...op("inventory:write", "Correct stock or write goods off", {
            parameters: [idem],
            requestBody: { required: true, content: { "application/json": { schema: ref("Adjustment") } } },
            responses: { "201": json(obj({ id: uuid(), value: fils("Cost value of the change") }), "Saved") },
          }),
        },
      },
      "/v1/reports/daily-sales": {
        get: {
          tags: ["Reports"],
          ...op("reports:read", "Sales totals per store per day", {
            parameters: [q("from", str(undefined, { format: "date" }), "First day", true), q("to", str(undefined, { format: "date" }), "Last day, at most 366 days after from", true), q("storeId", uuid(), "One store")],
            responses: { "200": json(obj({ data: { type: "array", items: ref("DailySales") } })) },
          }),
        },
      },
    },
    webhooks: Object.fromEntries(
      Object.entries(EVENT_TYPES).map(([type, description]) => [
        type,
        {
          post: {
            summary: description,
            requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
            responses: { "200": { description: "Any 2xx means received" } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "An API key from the back office: Developers → API keys" } },
      schemas,
      "x-scopes": SCOPES,
    },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The small bit of Markdown the descriptions use: **bold** and `code`. */
const md = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

function schemaTable(schema: Schema, all: Record<string, Schema>): string {
  const s = (schema.$ref ? all[String(schema.$ref).split("/").pop()!] : schema) as Schema;
  const props = (s.properties ?? {}) as Record<string, Schema>;
  const req = new Set((schema.required as string[] | undefined) ?? (s.required as string[] | undefined) ?? []);
  const rows = Object.entries(props).map(([name, p]) => {
    const type = p.$ref ? String(p.$ref).split("/").pop() : p.type === "array" ? `array of ${(p.items as Schema).$ref ? String((p.items as Schema).$ref).split("/").pop() : (p.items as Schema).type}` : Array.isArray(p.type) ? (p.type as string[]).join(" | ") : String(p.type ?? "object");
    const extra = p.enum ? ` One of: ${(p.enum as string[]).map((e) => `<code>${esc(e)}</code>`).join(", ")}.` : "";
    return `<tr><td><code>${esc(name)}</code>${req.has(name) ? ' <span class="req">required</span>' : ""}</td><td>${esc(String(type))}</td><td>${p.description ? md(String(p.description)) : ""}${extra}</td></tr>`;
  });
  return rows.length ? `<table><thead><tr><th>Field</th><th>Type</th><th>About</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : "";
}

/** A readable reference page built from the spec, with no outside scripts, so it works anywhere. */
export function docsHtml(): string {
  const spec = openApiSpec();
  const all = spec.components.schemas;
  const ops: string[] = [];
  const nav: string[] = [];
  for (const tag of spec.tags.map((t) => t.name)) {
    const items: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, raw] of Object.entries(methods as Record<string, Schema>)) {
        const o = raw as Schema & { tags: string[]; summary: string; parameters?: Schema[]; requestBody?: Schema; responses: Record<string, Schema> };
        if (!o.tags.includes(tag)) continue;
        const id = `${method}-${path.replace(/[^a-z0-9]+/gi, "-")}`;
        nav.push(`<li><a href="#${id}"><span class="m ${method}">${method.toUpperCase()}</span> ${esc(path)}</a></li>`);
        const params = (o.parameters ?? []).filter((p) => p.in !== "path");
        const body = o.requestBody ? ((o.requestBody.content as Schema)["application/json"] as Schema).schema as Schema : null;
        const okCode = Object.keys(o.responses).find((c) => c.startsWith("2"))!;
        const ok = ((o.responses[okCode]!.content as Schema | undefined)?.["application/json"] as Schema | undefined)?.schema as Schema | undefined;
        items.push(`<section class="op" id="${id}">
  <h3><span class="m ${method}">${method.toUpperCase()}</span> <code>${esc(path)}</code></h3>
  <p class="sum">${esc(o.summary)}</p>
  ${o.description ? `<p>${md(String(o.description))}</p>` : '<p class="muted">Any valid key.</p>'}
  ${params.length ? `<h4>Parameters</h4><table><thead><tr><th>Name</th><th>In</th><th>About</th></tr></thead><tbody>${params.map((p) => `<tr><td><code>${esc(String(p.name))}</code>${p.required ? ' <span class="req">required</span>' : ""}</td><td>${esc(String(p.in))}</td><td>${md(String(p.description ?? ""))}</td></tr>`).join("")}</tbody></table>` : ""}
  ${body ? `<h4>Body</h4>${schemaTable(body, all)}` : ""}
  ${ok ? `<h4>Answer (${okCode})</h4>${ok.$ref ? `<p>A <a href="#schema-${String(ok.$ref).split("/").pop()}">${String(ok.$ref).split("/").pop()}</a>.</p>` : schemaTable(ok, all)}` : ""}
</section>`);
      }
    }
    if (items.length) ops.push(`<h2 id="tag-${tag}">${tag}</h2>${items.join("")}`);
  }
  const models = Object.keys(all)
    .filter((n) => !n.endsWith("Input"))
    .map((n) => `<section class="op" id="schema-${n}"><h3>${n}</h3>${schemaTable(ref(n), all)}</section>`)
    .join("");
  const scopes = Object.entries(SCOPES).map(([k, v]) => `<tr><td><code>${k}</code></td><td>${esc(v)}</td></tr>`).join("");
  const events = Object.entries(EVENT_TYPES).map(([k, v]) => `<tr><td><code>${k}</code></td><td>${esc(v)}</td></tr>`).join("");
  const intro = spec.info.description
    .split("\n\n")
    .map((p) => `<p>${md(p)}</p>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>POS API reference</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --line:#e2e1dc; --card:#fff; --accent:#0f766e; --code:#f0efea; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ecebe6; --muted:#a3a29c; --line:#2e2d2a; --card:#1c1c1a; --accent:#2dd4bf; --code:#262522; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
.wrap { display:grid; grid-template-columns: 260px minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
nav { position: sticky; top:0; height:100vh; overflow:auto; padding:24px 16px; border-right:1px solid var(--line); font-size:13px; }
nav ul { list-style:none; padding:0; margin:0 0 16px; } nav li a { display:block; padding:3px 0; color:var(--fg); text-decoration:none; }
nav h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:16px 0 4px; }
main { padding: 32px 40px 80px; min-width:0; }
h1 { margin-top:0; } h2 { margin-top:40px; border-bottom:1px solid var(--line); padding-bottom:6px; }
.op { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin:16px 0; }
.op h3 { margin:0 0 4px; font-size:16px; } .sum { margin:0 0 8px; font-weight:600; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--code); padding:1px 5px; border-radius:4px; overflow-wrap:anywhere; }
table { width:100%; border-collapse:collapse; font-size:14px; margin:8px 0; display:block; overflow-x:auto; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); text-transform:uppercase; }
.m { display:inline-block; min-width:48px; text-align:center; font:700 11px ui-monospace, monospace; padding:2px 4px; border-radius:4px; color:#fff; background:#2563eb; }
.m.post { background:#16a34a; } .m.patch { background:#d97706; }
.req { font-size:11px; color:#b91c1c; } .muted { color:var(--muted); }
pre { background:var(--code); padding:12px; border-radius:8px; overflow-x:auto; font-size:13px; }
a { color: var(--accent); }
@media (max-width: 800px) { .wrap { display:block; } nav { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); } main { padding:20px 16px 60px; } }
</style></head>
<body><div class="wrap">
<nav aria-label="Contents"><strong>POS API</strong> <span class="muted">${esc(spec.info.version)}</span>
<h2>Start</h2><ul><li><a href="#intro">Overview</a></li><li><a href="#scopes">Scopes</a></li><li><a href="#webhooks">Webhooks</a></li><li><a href="/v1/openapi.json">OpenAPI JSON</a></li></ul>
<h2>Endpoints</h2><ul>${nav.join("")}</ul>
<h2>Models</h2><ul>${Object.keys(all).filter((n) => !n.endsWith("Input")).map((n) => `<li><a href="#schema-${n}">${n}</a></li>`).join("")}</ul>
</nav>
<main>
<h1 id="intro">${esc(spec.info.title)}</h1>
${intro}
<pre>curl https://YOUR-POS-SERVER/v1/products?limit=10 \\
  -H "Authorization: Bearer pos_live_..."</pre>
<h2 id="scopes">Scopes</h2><table><tbody>${scopes}</tbody></table>
<h2 id="webhooks">Webhooks</h2>
<table><tbody>${events}</tbody></table>
<p>Checking a signature in Node.js:</p>
<pre>const [t, v1] = req.headers["pos-signature"].split(",").map((p) =&gt; p.split("=")[1]);
const expected = crypto.createHmac("sha256", SECRET).update(t + "." + rawBody).digest("hex");
const fresh = Math.abs(Date.now() / 1000 - Number(t)) &lt; 300;
const valid = fresh &amp;&amp; crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));</pre>
${ops.join("")}
<h2 id="models">Models</h2>${models}
</main></div></body></html>`;
}
