-- Core tenant seed rows are DB-backed so runtime routing is config-only.
-- System prompts are hydrated by scripts/seed-core-tenants.ts.

INSERT INTO clients (
  business_name,
  owner_name,
  owner_email,
  owner_phone,
  transfer_number,
  twilio_number,
  greeting,
  system_prompt,
  subscription_status,
  grandfathered,
  tools_allowed,
  tts_model,
  stt_model,
  llm_model,
  tenant_key,
  bootstrap_state
) VALUES (
  'Deer Valley Driving School',
  'Austen Salazar',
  'austen.dvds@gmail.com',
  '+16026633502',
  '+16026633502',
  '+18773464394',
  'Hi, thanks for calling Deer Valley Driving School! This is Cadence, how can I help you today?',
  NULL,
  'active',
  true,
  ARRAY['send_sms', 'transfer_to_human'],
  'aura-2-thalia-en',
  'nova-2',
  'gpt-4o-mini',
  'dvds',
  'active'
)
ON CONFLICT (twilio_number) DO NOTHING;

INSERT INTO clients (
  business_name,
  owner_name,
  owner_email,
  owner_phone,
  transfer_number,
  twilio_number,
  greeting,
  system_prompt,
  subscription_status,
  grandfathered,
  tools_allowed,
  tts_model,
  stt_model,
  llm_model,
  tenant_key,
  bootstrap_state
) VALUES (
  'Cadence by Autom8',
  'Austen Salazar',
  'aust@autom8everything.com',
  '+16026633502',
  '+16026633502',
  '+14806313993',
  'Hi! Welcome to Cadence. I''m your AI receptionist demo — and by the end of this call, I can have your own AI receptionist up and running. Let me ask you a few quick questions to get started.',
  NULL,
  'active',
  true,
  ARRAY['save_onboarding_field', 'complete_onboarding'],
  'aura-2-thalia-en',
  'nova-2',
  'gpt-4o-mini',
  'cadence-onboarding',
  'active'
)
ON CONFLICT (twilio_number) DO NOTHING;
