-- Owner app: remote approvals from the till and the daily summary email.

-- A till asks the owner or a manager to approve something (a large refund, a big discount)
-- and waits; the owner decides from the owner app on their phone.
CREATE TABLE approval_requests (
  -- Made on the till before sending, so a retry is the same request.
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  register_id uuid NOT NULL REFERENCES registers(id),
  device_id uuid REFERENCES devices(id),
  kind text NOT NULL CHECK (kind IN ('refund', 'discount', 'void', 'price_override', 'cash_out', 'no_sale', 'other')),
  -- Money involved, in fils, when there is one.
  amount int CHECK (amount IS NULL OR amount >= 0),
  reason text,
  -- Short, human text the owner reads: "Refund AED 450.00 on bill DXB1-R1-0003-0042".
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  requested_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_pending_idx ON approval_requests (tenant_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX approval_requests_tenant_idx ON approval_requests (tenant_id, created_at DESC);

-- One row per business. A missing row means the defaults: daily email on, at 08:00.
CREATE TABLE report_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  daily_enabled boolean NOT NULL DEFAULT true,
  -- Hour of the day (in the business's first store's timezone) to send yesterday's summary.
  send_hour int NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  -- Extra people who get the email without a back office login, e.g. the accountant.
  extra_emails text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Owners and managers choose for themselves whether the daily email comes to them.
-- A missing row means: owners get it, managers do not.
CREATE TABLE report_subscriptions (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  daily boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each daily summary is sent at most once per business and day, even with many API servers.
CREATE TABLE report_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('daily', 'manual')),
  report_date date NOT NULL,
  -- pending: waiting to send or to retry · sending: a worker holds it · sent: the mail server took it
  -- failed: gave up after retries · skipped: nobody to send to
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  recipients text[] NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  transport text,
  last_error text,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX report_deliveries_daily_idx ON report_deliveries (tenant_id, report_date) WHERE kind = 'daily';
CREATE INDEX report_deliveries_due_idx ON report_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX report_deliveries_tenant_idx ON report_deliveries (tenant_id, created_at DESC);
