-- Restaurant mode: tables and open tabs shared by the store's tills, modifiers on products
-- (sizes, extras, "no onion") and kitchen tickets sent from the till.

CREATE TABLE modifier_groups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  name_ar text,
  -- How many options the cashier must and may pick; max_choices 0 means any number.
  min_choices int NOT NULL DEFAULT 0 CHECK (min_choices BETWEEN 0 AND 20),
  max_choices int NOT NULL DEFAULT 1 CHECK (max_choices BETWEEN 0 AND 20),
  -- [{id, name, nameAr, price}] with price in fils added to the item (0 for "no onion").
  options jsonb NOT NULL DEFAULT '[]',
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_choices = 0 OR max_choices >= min_choices)
);
CREATE INDEX modifier_groups_sync_idx ON modifier_groups (tenant_id, updated_at);

ALTER TABLE products ADD COLUMN modifier_group_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE dining_tables (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  area text NOT NULL DEFAULT 'Main',
  name text NOT NULL,
  seats int NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 100),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dining_tables_name_idx ON dining_tables (store_id, lower(name)) WHERE active;
CREATE INDEX dining_tables_sync_idx ON dining_tables (store_id, updated_at);

-- An open bill at a table (or a named tab, e.g. a takeaway waiting to pay). The cart is the
-- till's own; version stops two tills overwriting each other's changes.
CREATE TABLE tabs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  table_id uuid REFERENCES dining_tables(id),
  name text,
  guests int CHECK (guests BETWEEN 0 AND 500),
  cart jsonb NOT NULL,
  total int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cleared')),
  opened_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text,
  order_id uuid
);
CREATE UNIQUE INDEX tabs_table_open_idx ON tabs (table_id) WHERE status = 'open' AND table_id IS NOT NULL;
CREATE INDEX tabs_open_idx ON tabs (store_id) WHERE status = 'open';

-- What the till sent to the kitchen: printed on the kitchen printer and shown on kitchen screens.
CREATE TABLE kitchen_tickets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  register_id uuid REFERENCES registers(id),
  tab_id uuid REFERENCES tabs(id),
  -- "Table 5", "Takeaway 12" or the sale's number.
  label text NOT NULL,
  guests int,
  -- [{lineId, name, qty, modifiers: [name], note}]
  lines jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'done')),
  ready_at timestamptz,
  done_at timestamptz
);
CREATE INDEX kitchen_tickets_open_idx ON kitchen_tickets (store_id, created_at) WHERE status <> 'done';

ALTER TABLE order_lines ADD COLUMN modifiers jsonb;
ALTER TABLE orders ADD COLUMN tab_id uuid;
