ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_key TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS baseline_version TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS baseline_hash TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS override_hash TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bootstrap_state TEXT;

UPDATE clients
SET bootstrap_state = CASE
  WHEN subscription_status = 'pending' THEN 'pending_checkout'
  WHEN subscription_status = 'trial' THEN 'checkout_created'
  WHEN subscription_status = 'active' THEN 'active'
  WHEN subscription_status IN ('past_due', 'canceled') THEN 'failed'
  ELSE 'draft'
END
WHERE bootstrap_state IS NULL OR btrim(bootstrap_state) = '';

ALTER TABLE clients ALTER COLUMN bootstrap_state SET DEFAULT 'draft';
UPDATE clients SET bootstrap_state = 'draft' WHERE bootstrap_state IS NULL;
ALTER TABLE clients ALTER COLUMN bootstrap_state SET NOT NULL;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_bootstrap_state_check;
ALTER TABLE clients
  ADD CONSTRAINT clients_bootstrap_state_check
  CHECK (bootstrap_state IN ('draft', 'pending_checkout', 'checkout_created', 'active', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_tenant_key
  ON clients (tenant_key)
  WHERE tenant_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_baseline_version ON clients (baseline_version);
CREATE INDEX IF NOT EXISTS idx_clients_override_hash ON clients (override_hash);
