ALTER TABLE clients ADD COLUMN IF NOT EXISTS grandfathered BOOLEAN;

UPDATE clients
SET grandfathered = TRUE
WHERE (grandfathered IS NULL OR grandfathered = FALSE)
  AND subscription_status = 'active'
  AND (stripe_subscription_id IS NULL OR btrim(stripe_subscription_id) = '');

UPDATE clients
SET grandfathered = FALSE
WHERE grandfathered IS NULL;

ALTER TABLE clients ALTER COLUMN grandfathered SET DEFAULT FALSE;
ALTER TABLE clients ALTER COLUMN grandfathered SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_grandfathered ON clients (grandfathered);
