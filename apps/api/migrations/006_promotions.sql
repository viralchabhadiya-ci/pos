-- Price lists (wholesale, VIP or per-store prices) and promotions (automatic offers and
-- coupons). Both reach the tills with the catalog sync, so they work offline.

CREATE TABLE price_lists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- An item is switched off rather than deleted, so tills learn about the removal on their
-- next incremental sync.
CREATE TABLE price_list_items (
  price_list_id uuid NOT NULL REFERENCES price_lists(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  price int NOT NULL CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (price_list_id, variant_id)
);
CREATE INDEX price_list_items_sync_idx ON price_list_items (tenant_id, updated_at);

-- A customer's list wins over the store's; with neither, the product's own price applies.
ALTER TABLE customers ADD COLUMN price_list_id uuid REFERENCES price_lists(id);
ALTER TABLE stores ADD COLUMN price_list_id uuid REFERENCES price_lists(id);

CREATE TABLE promotions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent_off', 'buy_x_get_y', 'multi_buy', 'order_percent_off', 'order_amount_off')),
  target_all boolean NOT NULL DEFAULT false,
  category_ids uuid[] NOT NULL DEFAULT '{}',
  product_ids uuid[] NOT NULL DEFAULT '{}',
  percent_bp int CHECK (percent_bp BETWEEN 1 AND 10000),
  buy_qty int CHECK (buy_qty >= 1),
  get_qty int CHECK (get_qty >= 1),
  bundle_qty int CHECK (bundle_qty >= 2),
  bundle_price int CHECK (bundle_price >= 0),
  amount int CHECK (amount > 0),
  min_subtotal int CHECK (min_subtotal >= 0),
  min_qty int CHECK (min_qty >= 1),
  -- A coupon code; stored upper case. NULL for automatic promotions.
  code text,
  starts_at timestamptz,
  ends_at timestamptz,
  days int[],
  start_time text CHECK (start_time ~ '^\d{2}:\d{2}$'),
  end_time text CHECK (end_time ~ '^\d{2}:\d{2}$'),
  store_ids uuid[],
  priority int NOT NULL DEFAULT 100,
  -- Sales it may be used on in all. Tills work offline, so the limit can be passed by the
  -- sales rung up before they last synced; once reached, the promotion stops syncing as on.
  max_uses int CHECK (max_uses >= 1),
  uses int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotions_sync_idx ON promotions (tenant_id, updated_at);
-- Two running coupons with one code would be ambiguous at the till.
CREATE UNIQUE INDEX promotions_code_idx ON promotions (tenant_id, code) WHERE code IS NOT NULL AND active;

ALTER TABLE order_lines
  ADD COLUMN promo_discount int NOT NULL DEFAULT 0,
  ADD COLUMN promotion_id uuid REFERENCES promotions(id);

-- The promotions used on each sale, with the amount each one took off.
CREATE TABLE order_promotions (
  order_id uuid NOT NULL REFERENCES orders(id),
  promotion_id uuid NOT NULL REFERENCES promotions(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text,
  amount int NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, promotion_id)
);
CREATE INDEX order_promotions_promo_idx ON order_promotions (promotion_id, created_at);
