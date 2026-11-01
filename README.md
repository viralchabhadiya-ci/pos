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
```

Open the till, enter the pairing code, sign in with PIN `1234` (cashier) and open a shift.
The manager PIN `9999` approves price changes, discounts above 10% and voids.
A new pairing code: `pnpm --filter @pos/api pair <registerId>`.

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
pnpm test        # core engine, ESC/POS, API and hub integration (need Postgres), till logic
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

Integrated card terminal, customer display pairing, Arabic raster receipts, back office web app,
owner app. See the roadmap in the PRD.
