-- Delivery platforms (Talabat, Deliveroo, Careem, Noon Food, ...). Each store connects to a
-- platform as a "delivery channel". Orders arrive by webhook as web orders, the till accepts
-- them, the kitchen makes them, and when the rider collects, the till rings up the sale paid
-- by the platform. The menu, sold-out items and "busy" pauses go back to the platform.

CREATE TABLE delivery_channels (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  provider text NOT NULL CHECK (provider IN ('talabat', 'deliveroo', 'careem', 'noon', 'other')),
  -- Shown to staff: "Talabat", "Deliveroo JBR".
  name text NOT NULL,
  -- The platform's id for this branch, as their portal shows it.
  external_store_id text NOT NULL,
  -- Signs the platform's (or integration partner's) calls to us, and ours to them.
  secret text NOT NULL,
  -- Where our accept/reject/ready/menu calls go. Empty: simulated, kept in the activity log.
  callback_url text,
  active boolean NOT NULL DEFAULT true,
  -- New orders are accepted without a tap and go straight to the kitchen.
  auto_accept boolean NOT NULL DEFAULT false,
  -- Minutes to prepare, told to the platform on accepting.
  prep_minutes int NOT NULL DEFAULT 20 CHECK (prep_minutes BETWEEN 5 AND 120),
  -- What the platform keeps of each order, for the payout report.
  commission_bp int NOT NULL DEFAULT 0 CHECK (commission_bp BETWEEN 0 AND 10000),
  -- Menu prices on the platform are this much higher than in store (rounded up to 0.50).
  markup_bp int NOT NULL DEFAULT 0 CHECK (markup_bp BETWEEN 0 AND 10000),
  -- Busy: no new orders until then.
  paused_until timestamptz,
  menu_synced_at timestamptz,
  last_order_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_store_id)
);
CREATE INDEX delivery_channels_store_idx ON delivery_channels (store_id) WHERE active;

-- Items sold out for delivery at a store, until a time or until turned back on.
CREATE TABLE delivery_sold_out (
  store_id uuid NOT NULL REFERENCES stores(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, variant_id)
);

-- What went to and came from each platform, for the owner to check and for support.
CREATE TABLE delivery_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  channel_id uuid NOT NULL REFERENCES delivery_channels(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  kind text NOT NULL,
  -- sent, simulated, failed (ours); received, refused (theirs)
  outcome text NOT NULL,
  web_order_id uuid REFERENCES web_orders(id),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_channel_idx ON delivery_events (channel_id, created_at DESC);

ALTER TABLE web_orders DROP CONSTRAINT IF EXISTS web_orders_channel_check;
ALTER TABLE web_orders ADD CONSTRAINT web_orders_channel_check CHECK (channel IN ('online', 'table', 'kiosk', 'delivery'));
ALTER TABLE web_orders ADD COLUMN delivery_channel_id uuid REFERENCES delivery_channels(id);
-- The platform's order id, and the short code the rider shows at the counter.
ALTER TABLE web_orders ADD COLUMN external_id text;
ALTER TABLE web_orders ADD COLUMN external_code text;
-- The platform cancels the order if it is not accepted by then.
ALTER TABLE web_orders ADD COLUMN accept_by timestamptz;
ALTER TABLE web_orders ADD COLUMN prep_minutes int;
ALTER TABLE web_orders ADD COLUMN rider_name text;
ALTER TABLE web_orders ADD COLUMN rider_at timestamptz;
ALTER TABLE web_orders ADD COLUMN commission int;
CREATE UNIQUE INDEX web_orders_external_idx ON web_orders (delivery_channel_id, external_id) WHERE delivery_channel_id IS NOT NULL;

-- The kitchen ticket of a delivery order: Ready on the kitchen screen tells the platform.
ALTER TABLE kitchen_tickets ADD COLUMN web_order_id uuid REFERENCES web_orders(id);
-- The platform cancelled the order after the kitchen got it.
ALTER TABLE kitchen_tickets ADD COLUMN cancelled_at timestamptz;

-- Paid on the platform: the platform owes the money and pays it out later.
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
  CHECK (kind IN ('cash', 'card', 'card_manual', 'gift_card', 'points', 'delivery'));
