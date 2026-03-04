UPDATE clients
SET subscription_status = 'pending'
WHERE subscription_status IS NULL
   OR subscription_status NOT IN ('pending', 'trial', 'active', 'past_due', 'canceled');

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_subscription_status_check;

ALTER TABLE clients
  ADD CONSTRAINT clients_subscription_status_check
  CHECK (subscription_status IN ('pending', 'trial', 'active', 'past_due', 'canceled'));
