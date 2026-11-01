-- Core schema. Money columns are integer minor units (fils). Quantities keep 3 decimals.

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  country char(2) NOT NULL DEFAULT 'AE',
  currency char(3) NOT NULL DEFAULT 'AED',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  name_ar text,
  address text,
  trn text,
  timezone text NOT NULL DEFAULT 'Asia/Dubai',
  cash_rounding_step int NOT NULL DEFAULT 25,
  receipt_footer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE registers (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  register_id uuid NOT NULL REFERENCES registers(id),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('till', 'display')),
  token_hash text NOT NULL UNIQUE,
  paired_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE pairing_codes (
  code text PRIMARY KEY,
  register_id uuid NOT NULL REFERENCES registers(id),
  role text NOT NULL CHECK (role IN ('till', 'display')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  email text,
  role text NOT NULL CHECK (role IN ('cashier', 'manager', 'owner')),
  pin_salt text NOT NULL,
  pin_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE taxes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  rate_bp int NOT NULL CHECK (rate_bp >= 0),
  price_included boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_id uuid REFERENCES categories(id),
  name text NOT NULL,
  name_ar text,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  category_id uuid REFERENCES categories(id),
  name text NOT NULL,
  name_ar text,
  uom text NOT NULL DEFAULT 'unit' CHECK (uom IN ('unit', 'kg')),
  tax_id uuid REFERENCES taxes(id),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE variants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  sku text,
  barcode text,
  attributes jsonb NOT NULL DEFAULT '{}',
  price int NOT NULL,
  cost int,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, barcode)
);

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cash', 'card', 'card_manual')),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  phone text,
  email text,
  trn text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone_idx ON customers (tenant_id, phone);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  register_id uuid NOT NULL REFERENCES registers(id),
  seq int NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  opened_by uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL,
  opening_cash int NOT NULL,
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  closing_cash_counted int,
  expected_cash int,
  note text,
  UNIQUE (register_id, seq)
);

CREATE TABLE cash_moves (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  kind text NOT NULL CHECK (kind IN ('in', 'out')),
  amount int NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  register_id uuid NOT NULL REFERENCES registers(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  number text NOT NULL,
  cashier_id uuid NOT NULL REFERENCES users(id),
  customer_id uuid REFERENCES customers(id),
  refund_of_order_id uuid REFERENCES orders(id),
  order_discount_bp int NOT NULL DEFAULT 0,
  amount_total int NOT NULL,
  discount_total int NOT NULL,
  subtotal_net int NOT NULL,
  tax_total int NOT NULL,
  total int NOT NULL,
  cash_rounding int NOT NULL DEFAULT 0,
  client_total int NOT NULL,
  totals_mismatch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX orders_store_created_idx ON orders (store_id, created_at);
CREATE INDEX orders_session_idx ON orders (session_id);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  line_no int NOT NULL,
  variant_id uuid NOT NULL REFERENCES variants(id),
  name text NOT NULL,
  qty numeric(12, 3) NOT NULL,
  unit_price int NOT NULL,
  discount_bp int NOT NULL DEFAULT 0,
  line_discount int NOT NULL,
  order_discount int NOT NULL,
  tax_id uuid REFERENCES taxes(id),
  tax_rate_bp int,
  net int NOT NULL,
  tax int NOT NULL,
  gross int NOT NULL,
  note text
);
CREATE INDEX order_lines_order_idx ON order_lines (order_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  method_id uuid NOT NULL REFERENCES payment_methods(id),
  kind text NOT NULL,
  amount int NOT NULL,
  tendered int,
  change int NOT NULL DEFAULT 0,
  reference text
);
CREATE INDEX payments_order_idx ON payments (order_id);

-- Stock is an append-only ledger; the on-hand quantity is the sum of moves.
CREATE TABLE stock_moves (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  qty numeric(12, 3) NOT NULL,
  reason text NOT NULL CHECK (reason IN ('sale', 'refund', 'adjust', 'receive', 'transfer')),
  ref_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_moves_variant_idx ON stock_moves (store_id, variant_id);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid,
  device_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  data jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
