-- Public API and webhooks: API keys a business creates for its own integrations (an online
-- shop, an ERP, a delivery app), per-key rate limits, and signed webhooks sent to the
-- business's own URLs with retries and a delivery log.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  -- The start of the key, shown in lists so the owner can tell keys apart. Never the whole key.
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  -- Requests per minute.
  rate_limit int NOT NULL DEFAULT 120 CHECK (rate_limit BETWEEN 1 AND 6000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id, created_at DESC);

-- One row per key per minute; old rows are removed by the webhook worker's housekeeping.
CREATE TABLE api_rate_windows (
  key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  count int NOT NULL,
  PRIMARY KEY (key_id, window_start)
);

-- Answers to POST requests sent with an Idempotency-Key, kept for 24 hours so a retry gets the
-- same answer instead of creating the record twice.
CREATE TABLE api_idempotency (
  key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idem_key text NOT NULL,
  request_hash text NOT NULL,
  status int,
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, idem_key)
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  url text NOT NULL,
  description text,
  -- Event types this endpoint receives; '*' for all.
  events text[] NOT NULL,
  -- Signing secret; the receiver checks the POS-Signature header with it.
  secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- Set when the system turned the endpoint off after it kept failing.
  disabled_reason text,
  -- When deliveries started failing with no success since; cleared by a success.
  failing_since timestamptz,
  last_success_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id) WHERE active;

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_tenant_idx ON webhook_events (tenant_id, created_at DESC);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  response_status int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

-- Every try, with what the receiver answered (cut short), for the delivery log.
CREATE TABLE webhook_attempts (
  id bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  response_status int,
  response_body text,
  error text,
  duration_ms int NOT NULL
);
CREATE INDEX webhook_attempts_delivery_idx ON webhook_attempts (delivery_id, at);
