-- Multi-store HQ: store-scoped staff, products a store does not sell, and franchise
-- stores that pay HQ a royalty on their sales.

-- A person with no rows here works at every store. With rows, a cashier only signs in on
-- those stores' tills and a manager only sees and runs those stores in the back office.
-- Owners always see every store.
CREATE TABLE user_stores (
  user_id uuid NOT NULL REFERENCES users(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (user_id, store_id)
);
CREATE INDEX user_stores_store_idx ON user_stores (store_id);

-- The catalog is central; a store can leave a product out of its range. Tills of that
-- store then get the product as switched off.
CREATE TABLE store_hidden_products (
  store_id uuid NOT NULL REFERENCES stores(id),
  product_id uuid NOT NULL REFERENCES products(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (store_id, product_id)
);
CREATE INDEX store_hidden_products_product_idx ON store_hidden_products (product_id);

-- Owned stores belong to the business. A franchise store is run by a franchisee who pays
-- a royalty and a marketing fee, as a share of net sales before VAT.
ALTER TABLE stores
  ADD COLUMN ownership text NOT NULL DEFAULT 'owned' CHECK (ownership IN ('owned', 'franchise')),
  ADD COLUMN franchisee text,
  ADD COLUMN royalty_bp int NOT NULL DEFAULT 0 CHECK (royalty_bp BETWEEN 0 AND 10000),
  ADD COLUMN marketing_fee_bp int NOT NULL DEFAULT 0 CHECK (marketing_fee_bp BETWEEN 0 AND 10000);
