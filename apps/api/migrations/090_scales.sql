-- Scales: the item code (PLU) a product has on the shop's scale, and how the business's
-- scales print their barcodes (prefix, weight or price, item code length).
ALTER TABLE variants ADD COLUMN plu text;
CREATE UNIQUE INDEX variants_plu ON variants (tenant_id, plu) WHERE plu IS NOT NULL;

CREATE TABLE scale_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  rules jsonb NOT NULL DEFAULT '[{"prefix": "21", "kind": "weight", "pluLength": 5}, {"prefix": "22", "kind": "price", "pluLength": 5}]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO scale_settings (tenant_id) SELECT id FROM tenants;
