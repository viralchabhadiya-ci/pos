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

Every change is written to the audit log with who made it.

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
  drawer. Menu → Open drawer asks for a manager PIN. Printer text is English only for now; Arabic
  needs raster printing.

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

Back office reports and imports, integrated card terminal, super admin (businesses, subscriptions,
support), loyalty and gift cards, owner app, purchasing, FTA e-invoicing, Arabic raster receipts,
Windows/Android packaging. See the roadmap in the PRD.
