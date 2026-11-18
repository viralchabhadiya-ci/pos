# POS

Offline-first point of sale for UAE retail. A till keeps selling with no internet,
VAT is calculated the same way on the till and the server, and every order syncs
exactly once when the connection returns.

Product spec: [POS Product PRD](https://claude.ai/artifact/FEeGFjWrHQxDk3v1dJCWTf) ·
Research: [Odoo POS Blueprint](https://claude.ai/artifact/1kkW4wY7pSKbTTkpX2akY4)

## What is in this repo

| Path | What it is |
| --- | --- |
| `packages/core` | Shared money, pricing and VAT engine, payment checks, receipt numbers, wire schemas. Runs on the till and the server. |
| `apps/api` | Backend API: Fastify + PostgreSQL. Device pairing, catalog sync, shifts and cash control, idempotent order sync, refunds, stock ledger, daily report, audit log. |
| `apps/till` | Till app: React + Vite PWA with a local IndexedDB database and an outbox. Pair, PIN login, open shift, sell, split payment, bilingual tax invoice, refund, cash in/out, close shift. |
| `apps/hub` | Store hub: a small Node service on one PC in the shop. Tills connect to it; it forwards to the cloud, queues everything while the internet is down, lets tills find each other's sales offline, and drives the LAN receipt printer and cash drawer. |
| `apps/backoffice` | Back office web app for owners and managers: sales dashboard, products and prices, categories, stock, staff and PINs, registers and device pairing, bill search and detail. Works on desktop and phone. |
| `apps/owner` | Owner app: a phone-first PWA for owners and managers. Live sales, alerts, approving till requests, and the daily summary email. Installs to the home screen. |
| `packages/escpos` | Printer-neutral receipt document and its ESC/POS encoding (text, rows, barcode, QR, cut, drawer kick) for 80 mm and 58 mm thermal printers. |

## Run it locally

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or `docker compose up -d db`).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # adjust DATABASE_URL if needed
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/pos_dev

pnpm --filter @pos/api seed    # demo Dubai minimart; prints a pairing code
pnpm dev:api                   # http://localhost:3000
pnpm dev:till                  # http://localhost:5173
pnpm dev:backoffice            # http://localhost:5174
pnpm dev:owner                 # http://localhost:5175
```

Open the till, enter the pairing code, sign in with PIN `1234` (cashier) and open a shift.
The manager PIN `9999` approves price changes, discounts above 10% and voids.
A new pairing code: `pnpm --filter @pos/api pair <registerId>`, or **Tills & devices → Pair a device** in the back office.

### On the till

- **Park a sale:** Park puts the cart aside so you can serve the next customer. Parked (with a count)
  brings it back. Parked sales stay on that till, even after a restart.
- **Line note:** select a line and tap Note (for example "no sugar"). It prints under the item and
  shows on the digital receipt.
- **X and Z reports:** Menu → Print X report prints the shift so far without closing it. Closing the
  shift prints the Z report with the cash count and difference. Both need the hub printer.
- **Digital receipt:** set `PUBLIC_URL` on the API to its public address. Every printed receipt then
  carries a QR code that opens `/r/<order id>`, a bilingual tax invoice page the customer can keep.
  The id is a random UUID, so only someone holding the receipt can open it.
- **Arabic:** the العربية / English button in the top bar switches the till between English and
  Arabic, right to left. Each till remembers its own choice. Keypads keep their usual order.
- **Customer display:** the screen the customer sees, with items in English and Arabic, totals, change
  and the receipt QR after payment. Two ways:
  - a second monitor on the same PC: Menu → Customer screen on this PC, then drag the window across;
  - a separate tablet: in the back office get a pairing code for the register with the role
    *display* and pair the tablet with it. It follows that register through the hub or the cloud.

### Back office

Sign in at http://localhost:5174 with `owner@demo.ae` / `demo1234`. Owners and managers sign in with
email and password; cashiers only use their PIN on the till. In development Vite forwards `/admin` to the
API on port 3000 (set `API_URL` to change it); a production build calls `VITE_API_URL`.

- **Dashboard:** the day's sales, bills, average bill, VAT, refunds, sales by hour, cash vs card,
  top products, the last 7 days and the latest bills. Days follow the store's timezone.
- **Products and categories:** price, barcode, Arabic name, VAT, per piece or per kg, hide from tills.
  Changes reach the tills on their next catalog sync, about a minute. Stock: goods received and corrections.
- **Staff:** add cashiers and managers, reset PINs, switch people off. PINs must be different for every
  active person, because the till knows who you are from the PIN alone. Managers can only manage cashiers.
- **Tills & devices:** add registers, get a 6-digit pairing code (15 minutes, works once), remove a lost
  device so its token stops working.
- **Sales:** search bills by number and date, open a bill to see items, VAT, payments and linked refunds.
- **Reports:** sales by product, category, cashier, payment method or day for any date range, and a
  VAT return view split like the FTA VAT 201 form (standard rated, zero rated, exempt), net of credit
  notes. Every report downloads as CSV.
- **Inventory:** stock in each store with its value at average cost, and every movement behind it.
  - *Suppliers:* contacts, TRN, payment terms and delivery time; each product can have several suppliers with
    their own code and last cost.
  - *Purchase orders:* draft, mark ordered, receive in one or more deliveries (with the supplier's invoice
    number), close short or cancel. Receiving books stock in, updates the moving average cost and remembers
    the supplier's price. Goods that come without an order can be received directly. Orders print.
  - *Reorder:* products at or below their reorder level (or, without one, below what the last 28 days of
    sales need over the supplier's delivery time), minus what is already ordered or in transit. Tick and
    turn them into one draft order per supplier.
  - *Transfers:* stock leaves the sending store when sent, shows as on its way, and comes in when the other
    store receives it. Anything that does not arrive is recorded as a difference.
  - *Stock counts:* the whole store or one category. Each figure is saved as it is typed and stamped with the
    time, so sales made while counting are not counted twice. Completing writes the corrections.
  - *Expiry:* products can track expiry dates, asked for when goods arrive. The Expiry tab lists batches
    expiring soon that are probably still on the shelf (oldest delivery assumed sold first) and writes them off.
  - *Corrections and write-offs* (expired, damaged, stolen) for several products at once, with a reason.
- **Products import and export:** a CSV with `name` and `price` plus optional `name_ar`, `category`,
  `barcode`, `extra_barcodes` (separated by `|`), `sku`, `cost`, `vat`, `unit`, `reorder_level`,
  `active`. The file is checked first; nothing is saved if any row has a problem. Rows match existing
  products by barcode, then SKU.
- **More barcodes per product** (old and new packs) and a **low stock alert level**; low items show
  on the dashboard and under Products → Low stock.
- **VAT rates:** standard, zero rated and exempt. Zero rated and exempt both charge 0% but are
  reported separately.
- **Customers:** search, add, edit, TRN for business customers, and their bills.
- **Audit log:** who changed what, from the back office and the tills.
- **Settings (owner):** store name, Arabic name, address, phone, TRN, cash rounding and receipt
  footer (`|` starts a new line). Tills pick the changes up with their next catalog sync.

Every change is written to the audit log with who made it.

### Promotions, coupons and price lists

Promotions are set up in the back office (Promotions) and applied by the till by itself, offline too.

- **Kinds:** percent off items, buy X get Y (the cheapest units are the discounted ones; 100% makes them
  free), multi-buy (3 for AED 10), and percent or amount off the bill from a minimum spend.
- **Targets and timing:** all products, categories or chosen products; start and end dates, days of the
  week, happy-hour times in the store's timezone (an end before the start runs past midnight), and stores.
- **Rules at the till:** each item gets at most one item promotion, the lowest priority number first,
  then the single best bill promotion. Lines with a hand discount or price change, and returns, take no
  promotion; a hand discount on the whole bill turns bill promotions off. Discounts never stack by accident.
- **Coupons:** a promotion with a code applies only when the cashier enters it (Coupon, above the cart).
  The till checks codes against what it has synced. A use limit stops a coupon once reached; a till that
  was offline can still ring a few more up before it syncs, and those sales stand.
- **Customer on the sale:** Customer, above the cart, finds a customer by name or the last digits of their
  phone, or adds one.
- **Price lists:** other prices for some products (Price lists). Give a list to a customer (Customers) or
  a store (Settings). On the till a customer's list wins over the store's; other products keep their price.
  A line whose price was changed by hand keeps it.
- **Refunds** carry each item's share of the promotions it was sold with, so a customer gets back what they
  paid. The server checks this and writes a short refund to the audit log. The bill's own hand discount
  applies to the refund too.
- **Figures:** each promotion shows its uses and the discount given; bills and receipts list the
  promotions used. Hand discounts stay in the audit log as before; promotions do not.

### New businesses and plans

- **Sign-up:** *Start a free trial* on the back office sign-in page (`#/signup`). One form creates the
  business with:
  - a 14-day trial on the Growth plan;
  - one store with register *Counter 1*, its receipt code taken from the emirate (e.g. `SHJ1`);
  - UAE VAT rates (standard, zero rated, exempt) and Cash, Card and Card (manual terminal);
  - the owner, with a password for the back office and a PIN for the till;
  - the categories of the chosen kind of shop (grocery, fashion, electronics, cosmetics, pharmacy,
    other), with sample products if wanted (no barcodes, so they never clash with real ones).

  It signs the owner straight in. A network can sign up at most 5 times an hour.
- **Plans:** Starter (1 store, 2 registers), Growth (3 stores, 10 registers) and Pro (no limits).
  - Adding a store or register beyond the plan is refused, with a message to move up.
  - Settings shows the plan, its status and usage, and **Add store**.
  - The back office shows a banner in the last week of a trial, or when a payment is overdue.
  - There is no online payment yet; plans are changed from the platform console.

### Platform console

The operator's own console, at `#/platform` on the back office address. It has its own staff and
sign-in, separate from every business. Create the first admin with:

```bash
pnpm --filter @pos/api platform-admin you@company.ae "Your Name"   # prints a password
```

The demo seed also creates `admin@platform.test` / `demo1234demo`.

- **Overview:** monthly revenue, trials, sign-ups, tills online, sales in the last 24 hours, and
  system health. Health covers database latency, card payments without an answer, stuck or failed
  e-invoices, and bills with a total mismatch.
- **Businesses:** search by name or owner email and filter by status. Each business shows its plan,
  stores and tills, owners, sales, notes and a history of everything staff changed.
- **Plan and status** (admins only). Support staff can only extend a trial and keep notes.
  - *Paused* or *Closed* signs the business out of the back office and stops new devices from
    pairing.
  - Tills already paired keep selling and syncing, so no sale is ever lost.
- **Sign in to help:** opens the business's back office as its owner for 60 minutes, in a new tab,
  with a reason.
  - The business sees a banner while it lasts.
  - It also sees `support.sign_in` and every change marked with the support person in its own
    audit log.
- **Plans** (edit price and limits) and **Team** (admins and support staff; switching someone off
  signs them out at once).

### Card terminal

Link a card terminal to a register in the back office (Tills & devices → Card terminals). The till's
**Card** button then sends the amount to the terminal, so the cashier never types it; **Card (manual
terminal)** stays for a separate machine confirmed by hand. A card payment needs the internet, through
the hub or direct; the hub never queues one.

- **Never charged twice.** The till makes the payment id and saves it before sending. If the answer is
  lost the payment shows *No answer* and is checked again by the same id, never re-sent as a new charge.
- **Cancel on terminal** stops a payment still waiting. If the customer already paid, the answer is
  Approved and the payment is kept.
- **Refunds** of a sale paid on the terminal go back to the same card, never more than was paid.
- **Charged but no sale** (the till closed while the customer paid): a banner on the till offers
  *Refund to card*, or *Already sorted* with a manager PIN, which the server records.
- **Reconciliation:** the back office lists every card payment with card, auth code and bill.
  *Needs a look* shows charges older than 10 minutes that are on no bill and were not refunded or
  sorted, and payments that never got an answer.

Only the **simulator** provider is built in, for testing and demos; real providers (Network
International, Magnati, Geidea and others) are added as adapters in `apps/api/src/payments` once a
merchant agreement gives API access. The simulator waits `CARD_SIMULATOR_DELAY_MS` (default 3000) as
if the customer were tapping, and picks the outcome from the amount's last two fils digits:

| Amount ends in | Outcome |
| --- | --- |
| `.13` | Declined, insufficient funds |
| `.14` | Slow customer (4 times the wait), useful to try Cancel |
| `.15` | The start request is lost, then the check finds it approved |
| `.16` | The first two status checks fail, then approved |
| anything else | Approved |

### Accounting export

Back office, **Accounting** (`#/accounting`):

- **Daily journals**: each store day becomes one balanced journal. Payments received are debited to cash, card clearing (or a per-method account), gift card, store credit or loyalty accounts; sales net of VAT are credited by VAT type; VAT output, cash rounding, refunds (sales returns), cash paid in/out and till over/short each get their own line. Anything left over (payments not matching bill totals) goes to the rounding account with a warning.
- **Exports**: Xero manual journals (tax-exclusive lines with Xero tax rate names, so Xero posts the VAT and it lands on Xero's VAT return; per-line rounding differences go to the rounding account), QuickBooks Online journal entries, Zoho Books manual journals, and a plain debit/credit CSV. Sales, VAT and payments day listings for the accountant. Every journal export is logged, and the page warns when dates were already exported.
- **VAT return**: the FTA VAT 201 boxes. Box 1a-1g by store emirate (set per store, falling back to the e-invoicing emirate), 4 zero rated, 5 exempt, 8 totals; box 9 from stock received in the POS at the purchase order VAT rate, plus other expenses typed in; 12-14 net VAT. Download as CSV.
- **Accounts**: the owner maps every line to their chart of accounts (code for Xero, name for QuickBooks and Zoho Books), sets the date format and Xero tax rate names. Migration `060_accounting.sql`.

Check the first import against bank and card statements and import as drafts; the account codes, Xero tax rate names and import column mapping must match the business's own setup.

### Owner app and daily email

Open http://localhost:5175 on a phone (or **Add to Home Screen**) and sign in with the back office
login. Four tabs:

- **Today:** sales so far per store, refreshed every 30 seconds; by hour, cash vs card, which tills
  have a shift open (and which have gone quiet), best sellers and the latest bills.
- **Alerts:** what needs a look, most urgent first: approval requests, card payments not on a bill,
  e-invoices not accepted, shifts closed AED 10 or more over or short, tills with an open shift that
  have not synced for 15 minutes, bills whose total differs from the till, low stock, and a daily
  email that could not be sent.
- **Approvals:** a till can ask for remote approval (`POST /approvals` with its own request id, then
  poll `GET /approvals/:id`, or cancel). The request shows here with a countdown (10 minutes by
  default); the owner or a manager approves or denies it, with an optional note for the cashier.
  With notifications on, a new request shows a phone notification while the app is open or in the
  background, and the app icon shows the count.
- **Reports:** any day's summary, a preview of the email, **Email me this**, and the daily email
  settings.

The **daily summary email** goes out each morning (08:00 shop time by default) and covers the day
before: sales against the same weekday last week, bills and average, VAT, refunds, things that need
attention, stores, payments, best sellers, cashiers, shifts closed with over/short, busiest hour and
approvals. Owners get it unless they turn it off; managers can turn it on for themselves; the owner can
add up to 10 more addresses (e.g. the accountant), change the hour or switch it off. Each business and
day is sent once, even with several API servers, and retried 5 times over about an hour and a quarter
before the owner app shows it as failed.

Mail settings on the API server:

| Variable | Meaning |
| --- | --- |
| `SMTP_URL` | Any SMTP server, e.g. `smtps://user:pass@email-smtp.me-central-1.amazonaws.com:465`. Without it, emails are only written to the log. |
| `MAIL_FROM` | Sender, e.g. `Daily summary <reports@yourdomain.ae>`. |
| `OWNER_APP_URL` | Link to the owner app in the email. |

Build the owner app with `VITE_API_URL` when the API is on another address, and
`VITE_BACKOFFICE_URL` to link alerts to the back office pages that deal with them.

### With a store hub

```bash
cp apps/hub/.env.example apps/hub/.env
CLOUD_URL=http://localhost:3000 PRINTER_HOST=192.168.1.50 pnpm dev:hub   # http://localhost:4100
```

On the pairing screen, set the server to the hub (`http://<hub-pc>:4100`) instead of the cloud.
Pairing needs the internet once; after that the till works through the hub with or without it.
The status pill shows `Online · hub`, or `Internet down · N waiting at hub` while the hub is queueing.

What the hub does:

- **Internet up:** forwards every call. Writes go straight to the cloud so the till sees the real answer.
- **Internet down:** accepts orders, shift open/close, cash moves and new customers into its SQLite
  queue and answers like the cloud would (`queued: true`). It serves the catalog and shift state from
  its own copy, and finds receipts and customers from any till in the shop (for refunds).
- **Back up:** sends the queue oldest first, every 5 seconds. Orders are keyed by their UUID, so a
  retry anywhere is a duplicate, never a second sale. Anything the cloud refuses is kept at
  `GET /hub/rejections` and shown on the tills as "N rejected at hub".
- **Printer:** `POST /hub/print` sends the receipt to a network printer on port 9100 (Epson, Star,
  Xprinter, Rongta in raw mode). After a sale the till prints by itself and a cash sale opens the
  drawer. Menu → Open drawer asks for a manager PIN. Receipts print in English and Arabic by default
  (Menu → Printed receipts switches a till to English only). Printer fonts have no Arabic, so the
  till draws the text with the bundled Noto Sans Arabic and sends it as raster images (ESC/POS
  `GS v 0`); barcodes and QR codes stay native. Plain-English documents still print as text.

The hub's data folder holds device tokens, so keep it on the store PC.

## Tests

```bash
pnpm test        # core engine, ESC/POS, API, back office API and hub integration (need Postgres), till logic
pnpm typecheck
```

API tests use `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/pos_test`) and
recreate its schema on each run. Hub tests create and use a `pos_hub_test` database next to it; they run
the real API, switch it off mid-shift, and check that every sale reaches it exactly once.

## Key design rules

- **Money is integer fils.** Never floats. VAT is rounded per line, half away from zero, so a refund
  reverses a sale to the fil.
- **The till writes locally first.** Every sale, shift event and cash move goes into IndexedDB and an
  outbox in one transaction, then syncs in order.
- **Order ids are UUIDs made on the device.** The server upserts by id, so retries never duplicate.
- **Receipt numbers are made on the device** as `STORE-REGISTER-SHIFT-ORDER` (e.g. `DXB1-R1-0005-0012`).
- **The server recomputes totals** with the same engine. A mismatch is stored and flagged, never dropped,
  because the customer has already paid.
- **Stock is a ledger** of moves, so sales from many offline tills simply add up.

## Next

Real card terminal providers, online subscription billing, loyalty, gift cards and store credit, web push for the owner app, purchasing,
Windows/Android packaging. See the roadmap in the PRD.
