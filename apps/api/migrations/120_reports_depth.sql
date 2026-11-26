-- Reports depth: cost on every sold line (for margins) and scheduled email reports.

-- Cost per unit (fils, before VAT) at the moment of sale, so margins do not move when the
-- average cost changes later. Older lines take the product's current cost.
ALTER TABLE order_lines ADD COLUMN unit_cost int;
UPDATE order_lines ol SET unit_cost = v.cost FROM variants v WHERE v.id = ol.variant_id AND ol.unit_cost IS NULL;

-- A report emailed on a schedule: daily (yesterday), weekly (last Monday to Sunday) or
-- monthly (last calendar month), with the CSV attached.
CREATE TABLE report_schedules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  report text NOT NULL CHECK (report IN ('product', 'category', 'cashier', 'payment', 'day', 'margin', 'margin_category', 'staff', 'vat')),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  store_id uuid REFERENCES stores(id),
  recipients text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 20),
  send_hour int NOT NULL DEFAULT 7 CHECK (send_hour BETWEEN 0 AND 23),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_schedules_tenant_idx ON report_schedules (tenant_id);

-- One run per schedule and period; retried with backoff like the daily summary.
CREATE TABLE report_schedule_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  recipients text[] NOT NULL DEFAULT '{}',
  transport text,
  last_error text,
  row_count int,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (schedule_id, period_to)
);
CREATE INDEX report_schedule_runs_due_idx ON report_schedule_runs (next_attempt_at) WHERE status IN ('pending', 'sending');
