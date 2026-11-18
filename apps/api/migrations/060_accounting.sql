-- Accounting export: the chart of accounts the daily POS journals post to, and a log of
-- what was exported, so the same days are not posted to the books twice.

-- One row per business. A missing row means the defaults in src/accounting/settings.ts.
CREATE TABLE accounting_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- Account codes and names, per-method accounts, Xero tax rate names, store emirates.
  config jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounting_exports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES users(id),
  format text NOT NULL,
  store_id uuid REFERENCES stores(id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  journals int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_exports_tenant_idx ON accounting_exports (tenant_id, created_at DESC);
