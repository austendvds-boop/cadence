-- ============================================================
-- Cadence Neon schema (MVP multi-tenant foundation)
-- Safe for both fresh DBs and legacy pre-schema DBs
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- CLIENTS TABLE (create fresh shape when table does not exist)
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name          TEXT NOT NULL,
  owner_name             TEXT,
  owner_email            TEXT UNIQUE NOT NULL,
  owner_phone            TEXT,
  transfer_number        TEXT,
  hours                  JSONB NOT NULL DEFAULT '{}'::JSONB,
  faqs                   JSONB NOT NULL DEFAULT '[]'::JSONB,
  greeting               TEXT,
  system_prompt          TEXT,
  twilio_number          TEXT UNIQUE,
  twilio_number_sid      TEXT UNIQUE,
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  subscription_status    TEXT NOT NULL DEFAULT 'trial'
                           CHECK (subscription_status IN ('trial','active','past_due','canceled')),
  tts_model              TEXT NOT NULL DEFAULT 'aura-2-thalia-en',
  stt_model              TEXT NOT NULL DEFAULT 'nova-2',
  llm_model              TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  tools_allowed          TEXT[] NOT NULL DEFAULT ARRAY['transfer_to_human','send_sms'],
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Legacy compatibility: old schema used `phone_number`; rename it once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'phone_number'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'twilio_number'
  ) THEN
    ALTER TABLE clients RENAME COLUMN phone_number TO twilio_number;
  END IF;
END;
$$;

-- Add any missing columns for legacy clients table.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_phone TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS transfer_number TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS hours JSONB;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS faqs JSONB;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS greeting TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_number TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscription_status TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tts_model TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stt_model TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS llm_model TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tools_allowed TEXT[];
ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Backfill defaults for legacy rows.
UPDATE clients SET hours = '{}'::JSONB WHERE hours IS NULL;
UPDATE clients SET faqs = '[]'::JSONB WHERE faqs IS NULL;
UPDATE clients SET subscription_status = 'trial'
WHERE subscription_status IS NULL
   OR subscription_status NOT IN ('trial', 'active', 'past_due', 'canceled');
UPDATE clients SET tts_model = 'aura-2-thalia-en' WHERE tts_model IS NULL;
UPDATE clients SET stt_model = 'nova-2' WHERE stt_model IS NULL;
UPDATE clients SET llm_model = 'gpt-4o-mini' WHERE llm_model IS NULL;
UPDATE clients SET tools_allowed = ARRAY['transfer_to_human', 'send_sms'] WHERE tools_allowed IS NULL;
UPDATE clients SET created_at = NOW() WHERE created_at IS NULL;
UPDATE clients SET updated_at = NOW() WHERE updated_at IS NULL;

ALTER TABLE clients ALTER COLUMN hours SET DEFAULT '{}'::JSONB;
ALTER TABLE clients ALTER COLUMN faqs SET DEFAULT '[]'::JSONB;
ALTER TABLE clients ALTER COLUMN subscription_status SET DEFAULT 'trial';
ALTER TABLE clients ALTER COLUMN tts_model SET DEFAULT 'aura-2-thalia-en';
ALTER TABLE clients ALTER COLUMN stt_model SET DEFAULT 'nova-2';
ALTER TABLE clients ALTER COLUMN llm_model SET DEFAULT 'gpt-4o-mini';
ALTER TABLE clients ALTER COLUMN tools_allowed SET DEFAULT ARRAY['transfer_to_human','send_sms'];
ALTER TABLE clients ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE clients ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE clients ALTER COLUMN hours SET NOT NULL;
ALTER TABLE clients ALTER COLUMN faqs SET NOT NULL;
ALTER TABLE clients ALTER COLUMN subscription_status SET NOT NULL;
ALTER TABLE clients ALTER COLUMN tts_model SET NOT NULL;
ALTER TABLE clients ALTER COLUMN stt_model SET NOT NULL;
ALTER TABLE clients ALTER COLUMN llm_model SET NOT NULL;
ALTER TABLE clients ALTER COLUMN tools_allowed SET NOT NULL;
ALTER TABLE clients ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE clients ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_subscription_status_check'
      AND conrelid = 'clients'::regclass
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_subscription_status_check
      CHECK (subscription_status IN ('trial','active','past_due','canceled'));
  END IF;
END;
$$;

-- Unique indexes for nullable columns (safe for legacy + fresh DBs)
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_owner_email
  ON clients (owner_email) WHERE owner_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_twilio_number
  ON clients (twilio_number) WHERE twilio_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_twilio_number_sid
  ON clients (twilio_number_sid) WHERE twilio_number_sid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_stripe_customer_id
  ON clients (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_stripe_subscription_id
  ON clients (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_twilio_number       ON clients (twilio_number);
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer     ON clients (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_clients_subscription_status ON clients (subscription_status);
CREATE INDEX IF NOT EXISTS idx_clients_owner_email         ON clients (owner_email);

-- ============================================================
-- SUBSCRIPTIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      BIGSERIAL PRIMARY KEY,
  client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT NOT NULL UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,
  stripe_price_id         TEXT,
  status                  TEXT NOT NULL,
  trial_start             TIMESTAMPTZ,
  trial_end               TIMESTAMPTZ,
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE,
  last_payment_error      TEXT,
  last_invoice_id         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);

-- ============================================================
-- STRIPE EVENTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CALL LOGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS call_logs (
  id                 BIGSERIAL PRIMARY KEY,
  client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  call_sid           TEXT NOT NULL UNIQUE,
  caller_number      TEXT,
  duration_seconds   INTEGER,
  transcript_summary TEXT,
  tool_calls         JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_client_created ON call_logs (client_id, created_at DESC);

-- ============================================================
-- MAGIC LINK TOKENS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_link_token_hash ON magic_link_tokens (token_hash);

-- ============================================================
-- updated_at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_updated_at ON clients;
CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS subscriptions_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
