-- Loyalty points and gift cards.
--
-- Both are append-only ledgers: a balance is the sum of its moves. The balance columns on
-- customers and gift_cards are a cache kept in the same transaction as every move, so lookups
-- at the till stay fast; the ledger is what reports and audits trust.
--
-- Store credit is a gift card: a refund can go onto a new card (or a card the customer already
-- has), which is then spent like any other.

-- Points and gift cards are ways to pay, not discounts: VAT is charged on the full price of the
-- goods. That is the safe reading for a shop's own points and for multi-purpose vouchers.
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
  CHECK (kind IN ('cash', 'card', 'card_manual', 'gift_card', 'points'));

INSERT INTO payment_methods (id, tenant_id, name, kind)
SELECT gen_random_uuid(), t.id, 'Gift card', 'gift_card' FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM payment_methods m WHERE m.tenant_id = t.id AND m.kind = 'gift_card');
INSERT INTO payment_methods (id, tenant_id, name, kind)
SELECT gen_random_uuid(), t.id, 'Points', 'points' FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM payment_methods m WHERE m.tenant_id = t.id AND m.kind = 'points');

-- One row per business. A missing row means the programme is off.
CREATE TABLE loyalty_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  -- Points earned for each AED 1 spent.
  points_per_aed int NOT NULL DEFAULT 1 CHECK (points_per_aed BETWEEN 1 AND 1000),
  -- What one point is worth when spent, in fils (1 means 100 points pay AED 1).
  point_value_fils int NOT NULL DEFAULT 1 CHECK (point_value_fils BETWEEN 1 AND 10000),
  min_redeem_points int NOT NULL DEFAULT 100 CHECK (min_redeem_points BETWEEN 0 AND 1000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO loyalty_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;

ALTER TABLE customers ADD COLUMN points int NOT NULL DEFAULT 0;

CREATE TABLE loyalty_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  points int NOT NULL CHECK (points <> 0),
  -- earn: on a sale; redeem: spent as a payment; refund_earn: earned points taken back by a
  -- refund; refund_redeem: points given back by a refund; adjust: by hand in the back office.
  kind text NOT NULL CHECK (kind IN ('earn', 'redeem', 'refund_earn', 'refund_redeem', 'adjust')),
  order_id uuid REFERENCES orders(id),
  user_id uuid REFERENCES users(id),
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_moves_customer_idx ON loyalty_moves (customer_id, at DESC);
CREATE INDEX loyalty_moves_order_idx ON loyalty_moves (order_id) WHERE order_id IS NOT NULL;

-- What the sale earned, for receipts and the bill page.
ALTER TABLE orders ADD COLUMN points_earned int NOT NULL DEFAULT 0;

CREATE TABLE gift_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  -- The number on the card (its barcode), upper case.
  code text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  balance int NOT NULL DEFAULT 0,
  -- Total ever loaded (sold, topped up, refunded onto or issued), for the card's page.
  loaded int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  customer_id uuid REFERENCES customers(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX gift_cards_tenant_idx ON gift_cards (tenant_id, created_at DESC);
CREATE INDEX gift_cards_customer_idx ON gift_cards (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE gift_card_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  gift_card_id uuid NOT NULL REFERENCES gift_cards(id),
  amount int NOT NULL CHECK (amount <> 0),
  -- sale: sold at a till (first load); topup: sold again onto a card that exists; issue: given
  -- out from the back office; redeem: spent at a till; redeem_void: a spend given back because
  -- the sale did not go ahead; refund: a refund paid onto the card (store credit); adjust: by hand.
  kind text NOT NULL CHECK (kind IN ('sale', 'topup', 'issue', 'redeem', 'redeem_void', 'refund', 'adjust')),
  order_id uuid REFERENCES orders(id),
  -- The till's payment id: a spend is taken when the cashier adds the payment, before the bill
  -- exists, and is tied to the bill when it syncs. Unique per kind, so a retry never spends twice.
  payment_id uuid,
  store_id uuid REFERENCES stores(id),
  user_id uuid REFERENCES users(id),
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gift_card_moves_payment_idx ON gift_card_moves (payment_id, kind) WHERE payment_id IS NOT NULL;
CREATE INDEX gift_card_moves_card_idx ON gift_card_moves (gift_card_id, at DESC);
CREATE INDEX gift_card_moves_unclaimed_idx ON gift_card_moves (tenant_id, at) WHERE kind = 'redeem' AND order_id IS NULL;

-- A gift card line sells stored value, not a product.
ALTER TABLE order_lines ALTER COLUMN variant_id DROP NOT NULL;
ALTER TABLE order_lines ADD COLUMN gift_card_code text;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_product_or_gift_card
  CHECK ((variant_id IS NULL) <> (gift_card_code IS NULL));

ALTER TABLE payments ADD COLUMN gift_card_id uuid REFERENCES gift_cards(id);
ALTER TABLE payments ADD COLUMN points int;
