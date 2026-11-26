-- Online store with click-and-collect. Customers order on the business's shop page and pay
-- at pickup; the cashier rings the order up on the till, so VAT, stock, receipts and
-- e-invoices go through the normal sale.

ALTER TABLE products ADD COLUMN online boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN description text;

CREATE TABLE online_stores (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- The shop's address: <shop app>/#/<slug>
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  enabled boolean NOT NULL DEFAULT false,
  -- Stores customers can collect from.
  pickup_store_ids uuid[] NOT NULL DEFAULT '{}',
  notice text,
  min_order int NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  -- What the shop page promises: ready within this many minutes in opening hours.
  ready_minutes int NOT NULL DEFAULT 30 CHECK (ready_minutes BETWEEN 5 AND 1440),
  -- Off for shops whose stock figures are not kept up to date: everything shows as available.
  check_stock boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  seq int NOT NULL,
  number text NOT NULL,
  customer_id uuid REFERENCES customers(id),
  name text NOT NULL,
  phone text NOT NULL,
  email text,
  note text,
  -- What the customer saw: [{variantId, productId, name, qty, unitPrice, taxId}]
  lines jsonb NOT NULL,
  subtotal_net int NOT NULL,
  tax_total int NOT NULL,
  total int NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'ready', 'collected', 'cancelled')),
  -- For the customer's status page.
  token text NOT NULL UNIQUE,
  -- Said at the counter so the right person gets the bag.
  pickup_code text NOT NULL,
  -- The till sale that handed it over.
  order_id uuid REFERENCES orders(id),
  cancel_reason text,
  -- Where the order came from, to limit orders per network.
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  collected_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (tenant_id, seq)
);
CREATE INDEX web_orders_open_idx ON web_orders (tenant_id, store_id, created_at) WHERE status IN ('new', 'accepted', 'ready');
CREATE INDEX web_orders_tenant_idx ON web_orders (tenant_id, created_at DESC);
CREATE INDEX web_orders_phone_idx ON web_orders (tenant_id, phone, created_at DESC);
CREATE INDEX web_orders_ip_idx ON web_orders (ip, created_at DESC);

ALTER TABLE orders ADD COLUMN web_order_id uuid REFERENCES web_orders(id);
CREATE UNIQUE INDEX orders_web_order_idx ON orders (web_order_id) WHERE web_order_id IS NOT NULL;
