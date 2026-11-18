-- The platform side: plans, the businesses (tenants) that subscribe to them, and the
-- operator's own staff who look after those businesses. Platform staff never share
-- the users table with tenants, so a tenant owner can never become a platform admin.

CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- Monthly price in fils, before VAT.
  price_monthly int NOT NULL CHECK (price_monthly >= 0),
  -- NULL means no limit.
  max_stores int CHECK (max_stores > 0),
  max_registers int CHECK (max_registers > 0),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (id, name, price_monthly, max_stores, max_registers, sort) VALUES
  ('starter', 'Starter', 14900, 1, 2, 1),
  ('growth', 'Growth', 29900, 3, 10, 2),
  ('pro', 'Pro', 59900, NULL, NULL, 3);

ALTER TABLE tenants
  ADD COLUMN plan_id text NOT NULL DEFAULT 'growth' REFERENCES plans(id),
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN business_type text,
  ADD COLUMN contact_email text,
  ADD COLUMN contact_phone text,
  -- Internal notes by platform staff; never shown to the business.
  ADD COLUMN notes text,
  ADD COLUMN status_changed_at timestamptz;

CREATE TABLE platform_users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  -- admin: everything, including plans and platform staff. support: businesses and support sign-in.
  role text NOT NULL CHECK (role IN ('admin', 'support')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_users_email_idx ON platform_users (lower(email));

CREATE TABLE platform_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  platform_user_id uuid NOT NULL REFERENCES platform_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- What platform staff did, across all businesses.
CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  platform_user_id uuid REFERENCES platform_users(id),
  tenant_id uuid REFERENCES tenants(id),
  action text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_tenant_idx ON platform_audit (tenant_id, at DESC);
CREATE INDEX platform_audit_at_idx ON platform_audit (at DESC);

-- A support sign-in opens a short back office session as the business owner, marked with
-- the platform user who opened it, so the business sees it in its own audit log.
ALTER TABLE admin_sessions ADD COLUMN support_by uuid REFERENCES platform_users(id);
ALTER TABLE admin_sessions ADD COLUMN support_reason text;

-- Self sign-up: attempts per address, to slow down scripted sign-ups.
CREATE TABLE signup_attempts (
  ip text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_attempts_ip_idx ON signup_attempts (ip, at);
