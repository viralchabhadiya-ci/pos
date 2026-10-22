-- Back office sign-in for owners and managers. Cashiers keep using PINs on the till.
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
CREATE UNIQUE INDEX users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- Failed sign-ins, so repeated guesses on one email are slowed down.
CREATE TABLE login_attempts (
  email text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (lower(email), at);

CREATE INDEX orders_tenant_created_idx ON orders (tenant_id, created_at DESC);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, at DESC);
