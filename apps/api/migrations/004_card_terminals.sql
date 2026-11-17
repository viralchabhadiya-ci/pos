-- Integrated card terminals. The till asks the cloud to start a payment on the register's
-- terminal and polls its status; the payment id is made on the till, so a retry after a
-- lost answer asks about the same payment instead of charging the card again.

CREATE TABLE payment_terminals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  register_id uuid NOT NULL REFERENCES registers(id),
  name text NOT NULL,
  provider text NOT NULL,
  -- The provider's own id for the device, e.g. a terminal serial or POI id.
  terminal_ref text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One working terminal per register keeps the till's choice obvious.
CREATE UNIQUE INDEX payment_terminals_register_idx ON payment_terminals (register_id) WHERE active;

CREATE TABLE card_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  register_id uuid NOT NULL REFERENCES registers(id),
  terminal_id uuid NOT NULL REFERENCES payment_terminals(id),
  kind text NOT NULL CHECK (kind IN ('sale', 'refund')),
  amount int NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'AED',
  -- The order the till was taking payment for; it may reach the server later.
  order_id uuid,
  refund_of uuid REFERENCES card_transactions(id),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'failed', 'unknown')),
  provider_ref text,
  auth_code text,
  card_brand text,
  card_last4 text,
  message text,
  requested_by uuid REFERENCES users(id),
  -- Set when a manager confirms a charge that never reached a bill was dealt with another way.
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_transactions_tenant_idx ON card_transactions (tenant_id, created_at DESC);
CREATE INDEX card_transactions_order_idx ON card_transactions (order_id);

ALTER TABLE payments ADD COLUMN card_transaction_id uuid REFERENCES card_transactions(id);
