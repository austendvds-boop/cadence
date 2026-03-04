-- Checkout only knows owner email/business details at pending-client creation time.
-- Drop NOT NULL constraints on fields populated later in onboarding/provisioning.
DO $$
DECLARE
  col_name TEXT;
BEGIN
  FOREACH col_name IN ARRAY ARRAY[
    'system_prompt',
    'greeting',
    'owner_name',
    'owner_phone',
    'transfer_number',
    'hours',
    'faqs'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = 'clients'::regclass
        AND attname = col_name
        AND attnum > 0
        AND NOT attisdropped
        AND attnotnull
    ) THEN
      EXECUTE format('ALTER TABLE clients ALTER COLUMN %I DROP NOT NULL', col_name);
    END IF;
  END LOOP;
END
$$;
