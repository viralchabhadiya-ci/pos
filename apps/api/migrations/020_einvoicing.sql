-- UAE e-invoicing (PINT AE). Every bill and refund becomes an e-invoice or credit note
-- that a background worker sends to the accredited service provider (ASP).

CREATE TABLE einvoice_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  -- 'b2b' sends only bills for customers with a TRN; 'all' sends every bill.
  scope text NOT NULL DEFAULT 'b2b' CHECK (scope IN ('b2b', 'all')),
  provider text NOT NULL DEFAULT 'simulator' CHECK (provider IN ('simulator', 'http')),
  -- How the built-in simulator answers, so retries and rejections can be tried safely.
  simulator_mode text NOT NULL DEFAULT 'accept' CHECK (simulator_mode IN ('accept', 'flaky', 'down', 'reject')),
  endpoint_url text,
  api_key text,
  -- Seller details as registered with the FTA. The TRN comes from the store.
  legal_name text,
  street text,
  city text,
  emirate text CHECK (emirate IN ('AUH', 'DXB', 'SHJ', 'AJM', 'UAQ', 'RAK', 'FUJ')),
  max_attempts int NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE einvoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  kind text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  -- pending: waiting to send · sending: a worker holds it · accepted: the ASP took it
  -- rejected: the ASP refused it · failed: gave up (retries used up or data missing)
  -- skipped: outside the chosen scope (e.g. a walk-in bill when only B2B is sent)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'accepted', 'rejected', 'failed', 'skipped')),
  -- Sent even when outside the scope, because someone asked for it from the bill.
  forced boolean NOT NULL DEFAULT false,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  provider text,
  provider_ref text,
  last_error text,
  xml text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);
CREATE INDEX einvoices_due_idx ON einvoices (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX einvoices_tenant_status_idx ON einvoices (tenant_id, status, created_at DESC);

CREATE TABLE einvoice_attempts (
  id bigserial PRIMARY KEY,
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'error')),
  message text,
  provider_ref text,
  duration_ms int
);
CREATE INDEX einvoice_attempts_doc_idx ON einvoice_attempts (einvoice_id, at);

-- Queue the e-invoice in the same transaction that stores the bill, so a bill is never
-- left without one, whichever code path inserts it.
CREATE FUNCTION einvoice_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO einvoices (id, tenant_id, order_id, kind)
  SELECT gen_random_uuid(), NEW.tenant_id, NEW.id,
         CASE WHEN NEW.refund_of_order_id IS NULL THEN 'invoice' ELSE 'credit_note' END
    FROM einvoice_settings s
   WHERE s.tenant_id = NEW.tenant_id AND s.enabled
  ON CONFLICT (order_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_einvoice_enqueue AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION einvoice_enqueue();
