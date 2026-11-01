-- Back office depth: extra barcodes, reorder levels, VAT kinds and store contact details.

-- A product can carry more than one barcode (e.g. a single can and a new pack design).
ALTER TABLE variants ADD COLUMN extra_barcodes text[] NOT NULL DEFAULT '{}';
CREATE INDEX variants_extra_barcodes_idx ON variants USING gin (extra_barcodes);

-- Warn when stock falls to this level or below. NULL means no alert.
ALTER TABLE variants ADD COLUMN reorder_level numeric(12, 3);

-- UAE VAT treats zero-rated and exempt supplies differently on the VAT return,
-- even though both charge 0%.
ALTER TABLE taxes ADD COLUMN kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'zero', 'exempt'));
UPDATE taxes SET kind = 'zero' WHERE rate_bp = 0;

INSERT INTO taxes (id, tenant_id, name, rate_bp, price_included, kind)
SELECT gen_random_uuid(), t.id, 'Zero-rated 0%', 0, true, 'zero' FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM taxes x WHERE x.tenant_id = t.id AND x.kind = 'zero');
INSERT INTO taxes (id, tenant_id, name, rate_bp, price_included, kind)
SELECT gen_random_uuid(), t.id, 'Exempt', 0, true, 'exempt' FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM taxes x WHERE x.tenant_id = t.id AND x.kind = 'exempt');

ALTER TABLE stores ADD COLUMN phone text;
ALTER TABLE stores ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity, entity_id);
CREATE INDEX order_lines_variant_idx ON order_lines (variant_id);
