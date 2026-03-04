-- Update onboarding tenant contact routing to Austen's personal number.
-- This keeps DB-backed tenant metadata aligned with complete_onboarding summary destination.

UPDATE clients
SET
  owner_phone = '+16026633503',
  transfer_number = '+16026633503',
  updated_at = NOW()
WHERE tenant_key = 'autom8-onboarding'
   OR twilio_number = '+14806313993';
