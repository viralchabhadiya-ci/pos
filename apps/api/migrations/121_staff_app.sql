-- Staff app: a phone paired to a store as a "staff" device, where staff sign in with their PIN
-- to check prices, count stock, receive deliveries and ask for labels.

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_role_check;
ALTER TABLE devices ADD CONSTRAINT devices_role_check CHECK (role IN ('till', 'display', 'staff'));
ALTER TABLE pairing_codes DROP CONSTRAINT IF EXISTS pairing_codes_role_check;
ALTER TABLE pairing_codes ADD CONSTRAINT pairing_codes_role_check CHECK (role IN ('till', 'display', 'staff'));

-- A person signed in on a staff phone. Only the token's SHA-256 is kept.
CREATE TABLE staff_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  device_id uuid NOT NULL REFERENCES devices(id),
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX staff_sessions_device_idx ON staff_sessions (device_id);

-- Labels asked for from the shop floor; printed from the back office (Scales & labels).
CREATE TABLE label_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  copies int NOT NULL CHECK (copies BETWEEN 1 AND 100),
  reason text,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  printed_at timestamptz
);
CREATE INDEX label_requests_open_idx ON label_requests (tenant_id, created_at) WHERE printed_at IS NULL;
