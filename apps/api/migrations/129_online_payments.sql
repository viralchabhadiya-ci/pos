-- Paying on the customer's own phone: Tabby and Tamara (buy now, pay later) and card payment
-- links. The till shows a QR code (also on the customer display) or texts the link, and waits
-- until the provider says it is paid. Apple Pay and Google Pay on the card terminal are noted.

-- How a card terminal payment was made: apple_pay, google_pay, or null for a card.
ALTER TABLE card_transactions ADD COLUMN wallet text;

ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
  CHECK (kind IN ('cash', 'card', 'card_manual', 'gift_card', 'points', 'delivery', 'bnpl', 'pay_link'));
-- Which provider a bnpl or pay_link method uses: tabby, tamara, link.
ALTER TABLE payment_methods ADD COLUMN provider text;

CREATE TABLE online_payment_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- Minutes a link stays open before it expires.
  link_minutes int NOT NULL DEFAULT 15 CHECK (link_minutes BETWEEN 5 AND 1440),
  -- Smallest and largest bill the pay-later providers take, in fils.
  bnpl_min int NOT NULL DEFAULT 10000 CHECK (bnpl_min >= 0),
  bnpl_max int NOT NULL DEFAULT 500000 CHECK (bnpl_max >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_links (
  -- Made on the till, so asking twice gives the one link.
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  register_id uuid REFERENCES registers(id),
  provider text NOT NULL CHECK (provider IN ('tabby', 'tamara', 'link')),
  kind text NOT NULL CHECK (kind IN ('sale', 'refund')),
  amount int NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'declined', 'expired', 'cancelled', 'failed')),
  -- The customer's page: <PUBLIC_URL>/pay/<token>
  token text NOT NULL UNIQUE,
  provider_ref text,
  -- Where the provider's own checkout is (when it is not the simulator).
  checkout_url text,
  phone text,
  -- The till sale it pays (set when the sale reaches the server), and the original link a refund goes back to.
  order_id uuid,
  refund_of uuid REFERENCES payment_links(id),
  created_by uuid REFERENCES users(id),
  message text,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_links_tenant_idx ON payment_links (tenant_id, created_at DESC);
CREATE INDEX payment_links_refund_idx ON payment_links (refund_of) WHERE refund_of IS NOT NULL;

ALTER TABLE payments ADD COLUMN pay_link_id uuid REFERENCES payment_links(id);
