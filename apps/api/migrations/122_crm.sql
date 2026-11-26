-- CRM and marketing: birthdays, tags and marketing consent on customers, saved segments,
-- campaigns by email, SMS and WhatsApp, and birthday offers sent on the day.

ALTER TABLE customers ADD COLUMN birth_month smallint CHECK (birth_month BETWEEN 1 AND 12);
ALTER TABLE customers ADD COLUMN birth_day smallint CHECK (birth_day BETWEEN 1 AND 31);
ALTER TABLE customers ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
-- Marketing needs the customer's yes per channel. Receipts and other service messages do not.
ALTER TABLE customers ADD COLUMN consent_email boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN consent_sms boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN consent_whatsapp boolean NOT NULL DEFAULT false;
-- When and where the last consent change was recorded (till, back office, unsubscribe link).
ALTER TABLE customers ADD COLUMN consent_at timestamptz;
ALTER TABLE customers ADD COLUMN consent_source text;
CREATE INDEX customers_birthday_idx ON customers (tenant_id, birth_month, birth_day) WHERE birth_month IS NOT NULL;
CREATE INDEX customers_tags_idx ON customers USING gin (tags);

-- A saved group of customers, by rules evaluated when a campaign is sent.
CREATE TABLE customer_segments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  rules jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_segments_name_idx ON customer_segments (tenant_id, lower(name));

CREATE TABLE campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  -- one_off: sent once to a segment · birthday: sent every day to customers whose birthday it is
  kind text NOT NULL DEFAULT 'one_off' CHECK (kind IN ('one_off', 'birthday')),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  segment_id uuid REFERENCES customer_segments(id),
  subject text,
  message text NOT NULL,
  -- A coupon from Promotions to put in {coupon}.
  coupon_code text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'active', 'paused', 'cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_tenant_idx ON campaigns (tenant_id, created_at DESC);

-- One message to one customer. period keeps a birthday offer to once a year.
CREATE TABLE campaign_messages (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  period text NOT NULL DEFAULT '',
  channel text NOT NULL,
  to_address text NOT NULL,
  -- Random, for the unsubscribe link in the message.
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  error text,
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (campaign_id, customer_id, period)
);
CREATE INDEX campaign_messages_queue_idx ON campaign_messages (created_at) WHERE status = 'queued';
CREATE INDEX campaign_messages_campaign_idx ON campaign_messages (campaign_id, status);
