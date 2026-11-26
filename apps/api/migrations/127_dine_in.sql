-- Ordering by guests: a QR code on each table opens the menu for that table, and a self-order
-- kiosk takes orders paid at the counter. Both arrive on the tills as web orders.

-- The table's QR code; made when the back office first shows the codes.
ALTER TABLE dining_tables ADD COLUMN qr_token text UNIQUE;
-- Guests can order from the table QR code in this store.
ALTER TABLE stores ADD COLUMN table_ordering boolean NOT NULL DEFAULT false;

CREATE TABLE kiosks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  name text NOT NULL,
  token text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX kiosks_store_idx ON kiosks (store_id) WHERE active;

ALTER TABLE web_orders ADD COLUMN channel text NOT NULL DEFAULT 'online' CHECK (channel IN ('online', 'table', 'kiosk'));
ALTER TABLE web_orders ADD COLUMN table_id uuid REFERENCES dining_tables(id);
ALTER TABLE web_orders ADD COLUMN kiosk_id uuid REFERENCES kiosks(id);
-- The bill a table order was added to.
ALTER TABLE web_orders ADD COLUMN tab_id uuid REFERENCES tabs(id);
-- Guests at a table or a kiosk don't give a phone number.
ALTER TABLE web_orders ALTER COLUMN name DROP NOT NULL;
ALTER TABLE web_orders ALTER COLUMN phone DROP NOT NULL;
CREATE INDEX web_orders_table_idx ON web_orders (table_id) WHERE status = 'new';
