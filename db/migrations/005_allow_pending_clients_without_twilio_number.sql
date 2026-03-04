-- Pending/onboarding clients are created before provisioning, so twilio_number must be nullable.
ALTER TABLE clients ALTER COLUMN twilio_number DROP NOT NULL;
