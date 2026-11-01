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

## Tests

```bash
pnpm test        # core engine, API integration (needs Postgres), till logic
pnpm typecheck
```

API tests use `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/pos_test`) and
recreate its schema on each run.

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

Store hub for LAN sync between tills, ESC/POS printing and cash drawer, integrated card terminal,
customer display pairing, back office web app, owner app. See the roadmap in the PRD.
