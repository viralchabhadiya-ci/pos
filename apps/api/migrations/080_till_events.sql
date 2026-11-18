-- Till events (voids, drawer opens with no sale, manager overrides) land in the audit log.
-- The till may send one again after a dropped connection, so each is kept once.
CREATE UNIQUE INDEX audit_log_till_event ON audit_log (tenant_id, entity_id) WHERE entity = 'till_event';
