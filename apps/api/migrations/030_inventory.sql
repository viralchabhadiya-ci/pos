-- Inventory: suppliers, purchase orders and goods receipts, transfers between stores,
-- stock counts, lots with expiry dates and reorder settings.
--
-- Stock stays an append-only ledger (stock_moves). Every document below writes its
-- effect there, with ref_id pointing back at the document.

ALTER TABLE stock_moves DROP CONSTRAINT IF EXISTS stock_moves_reason_check;
ALTER TABLE stock_moves ADD CONSTRAINT stock_moves_reason_check
  CHECK (reason IN ('sale', 'refund', 'adjust', 'receive', 'transfer', 'count', 'waste'));
-- Cost per unit in fils (excluding VAT) for goods coming in; used for the moving average cost.
ALTER TABLE stock_moves ADD COLUMN unit_cost int;
ALTER TABLE stock_moves ADD COLUMN lot_id uuid;
ALTER TABLE stock_moves ADD COLUMN user_id uuid;
ALTER TABLE stock_moves ADD COLUMN note text;
CREATE INDEX stock_moves_tenant_at_idx ON stock_moves (tenant_id, at DESC);
CREATE INDEX stock_moves_ref_idx ON stock_moves (ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX stock_moves_lot_idx ON stock_moves (lot_id) WHERE lot_id IS NOT NULL;

-- Running numbers for documents (PO-000001, GRN-000001, TR-000001, SC-000001), per business.
CREATE TABLE doc_sequences (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL,
  next int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  contact_name text,
  phone text,
  email text,
  trn text,
  address text,
  -- Days after delivery the supplier expects payment; shown on the PO.
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  -- Days from ordering to delivery; reorder suggestions cover this gap.
  lead_time_days int NOT NULL DEFAULT 3 CHECK (lead_time_days BETWEEN 0 AND 120),
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_name_idx ON suppliers (tenant_id, lower(name));

-- What a supplier sells us: their code and last agreed cost.
CREATE TABLE supplier_items (
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  supplier_sku text,
  unit_cost int CHECK (unit_cost >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, variant_id)
);
CREATE INDEX supplier_items_variant_idx ON supplier_items (variant_id);

-- Inventory settings that sit beside the product's price and barcodes.
ALTER TABLE variants ADD COLUMN reorder_qty numeric(12, 3) CHECK (reorder_qty >= 0);
ALTER TABLE variants ADD COLUMN preferred_supplier_id uuid REFERENCES suppliers(id);
ALTER TABLE variants ADD COLUMN track_expiry boolean NOT NULL DEFAULT false;

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'partial', 'received', 'closed', 'cancelled')),
  expected_on date,
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ordered_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX purchase_orders_tenant_idx ON purchase_orders (tenant_id, created_at DESC);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY,
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  variant_id uuid NOT NULL REFERENCES variants(id),
  qty_ordered numeric(12, 3) NOT NULL CHECK (qty_ordered > 0),
  qty_received numeric(12, 3) NOT NULL DEFAULT 0,
  -- Fils per unit, excluding VAT, as on the supplier's invoice.
  unit_cost int NOT NULL CHECK (unit_cost >= 0),
  tax_rate_bp int NOT NULL DEFAULT 500 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  UNIQUE (po_id, variant_id)
);

-- Goods arriving at a store, against a purchase order or not.
CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  po_id uuid REFERENCES purchase_orders(id),
  supplier_id uuid REFERENCES suppliers(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  supplier_invoice text,
  notes text,
  received_by uuid REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX goods_receipts_po_idx ON goods_receipts (po_id);

CREATE TABLE lots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  code text NOT NULL,
  expires_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, variant_id, code)
);
CREATE INDEX lots_expiry_idx ON lots (tenant_id, expires_on);
ALTER TABLE stock_moves ADD CONSTRAINT stock_moves_lot_fk FOREIGN KEY (lot_id) REFERENCES lots(id);

CREATE TABLE goods_receipt_lines (
  id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES goods_receipts(id),
  po_line_id uuid REFERENCES purchase_order_lines(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  qty numeric(12, 3) NOT NULL CHECK (qty > 0),
  unit_cost int NOT NULL CHECK (unit_cost >= 0),
  lot_id uuid REFERENCES lots(id)
);
CREATE INDEX goods_receipt_lines_receipt_idx ON goods_receipt_lines (receipt_id);

-- Stock sent from one store to another. Leaves the source when sent, arrives when received.
CREATE TABLE transfers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  from_store_id uuid NOT NULL REFERENCES stores(id),
  to_store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid REFERENCES users(id),
  sent_at timestamptz,
  received_by uuid REFERENCES users(id),
  received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_store_id <> to_store_id),
  UNIQUE (tenant_id, number)
);
CREATE INDEX transfers_tenant_idx ON transfers (tenant_id, created_at DESC);

CREATE TABLE transfer_lines (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  variant_id uuid NOT NULL REFERENCES variants(id),
  qty numeric(12, 3) NOT NULL CHECK (qty > 0),
  qty_received numeric(12, 3),
  UNIQUE (transfer_id, variant_id)
);

-- A stock count (stock take). Each line remembers when it was counted, so sales made while
-- counting are not double counted: the correction is counted minus what the ledger held then.
CREATE TABLE stock_counts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  name text NOT NULL,
  category_id uuid REFERENCES categories(id),
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES users(id),
  completed_at timestamptz,
  UNIQUE (tenant_id, number)
);
CREATE INDEX stock_counts_tenant_idx ON stock_counts (tenant_id, created_at DESC);

CREATE TABLE stock_count_lines (
  count_id uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES variants(id),
  expected numeric(12, 3) NOT NULL,
  counted numeric(12, 3) CHECK (counted >= 0),
  counted_at timestamptz,
  -- Filled when the count is completed: what was written to the ledger.
  adjustment numeric(12, 3),
  PRIMARY KEY (count_id, variant_id)
);
