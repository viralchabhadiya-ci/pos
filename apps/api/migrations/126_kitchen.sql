-- Kitchen display: a screen in the kitchen paired as a "kitchen" device shows the store's
-- kitchen tickets; cooks tick off items and bump tickets to ready and picked up.

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_role_check;
ALTER TABLE devices ADD CONSTRAINT devices_role_check CHECK (role IN ('till', 'display', 'staff', 'kitchen'));
ALTER TABLE pairing_codes DROP CONSTRAINT IF EXISTS pairing_codes_role_check;
ALTER TABLE pairing_codes ADD CONSTRAINT pairing_codes_role_check CHECK (role IN ('till', 'display', 'staff', 'kitchen'));

-- lineIds of the ticket the kitchen has ticked off.
ALTER TABLE kitchen_tickets ADD COLUMN done_lines text[] NOT NULL DEFAULT '{}';
ALTER TABLE kitchen_tickets ADD COLUMN started_at timestamptz;
ALTER TABLE kitchen_tickets ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX kitchen_tickets_day_idx ON kitchen_tickets (store_id, created_at);
