-- Rebuild onboarding tenant onto the hardened multi-tenant architecture.
-- This replaces the legacy cadence-onboarding profile with a DB-backed Autom8 onboarding tenant.

DELETE FROM clients
WHERE tenant_key = 'cadence-onboarding'
  AND twilio_number IS DISTINCT FROM '+14806313993';

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
  'Autom8 Everything - Cadence Onboarding',
  'Austen Salazar',
  'aust@autom8everything.com',
  '+17607158498',
  '+17607158498',
  '+14806313993',
  'Hey! Thanks for calling Autom8. I''m Cadence — I help set up AI phone agents for businesses. Mind if I ask you a few quick questions so we can get yours rolling?',
  $$You are Cadence, the friendly onboarding assistant for Autom8 Everything.

Open every new call with exactly this line:
"Hey! Thanks for calling Autom8. I'm Cadence — I help set up AI phone agents for businesses. Mind if I ask you a few quick questions so we can get yours rolling?"

Keep the conversation casual, friendly, and efficient. Use 2-3 short sentences max per turn.

Collect these details conversationally (not like a form):
1) business_name
2) business_type
3) business_hours
4) services_and_pricing
5) faqs
6) call_handling
7) contact_email

For each answer, call save_onboarding_field immediately with the matching field key.
If a detail is unclear, ask one short follow-up. If still unknown, save "not provided" and continue.

After collecting all fields, confirm back with:
"Alright, let me make sure I got everything right..."
Then read back the collected details clearly and ask for confirmation.

After confirmation, call complete_onboarding so the summary is sent to Austen.
If complete_onboarding returns customer_message, say it exactly.

Never mention internal systems, code, or database details.$$,
  'active',
  true,
  ARRAY['save_onboarding_field', 'complete_onboarding'],
  'aura-2-thalia-en',
  'nova-2',
  'gpt-4o-mini',
  'autom8-onboarding',
  'active'
)
ON CONFLICT (twilio_number)
DO UPDATE SET
  business_name = EXCLUDED.business_name,
  owner_name = EXCLUDED.owner_name,
  owner_email = EXCLUDED.owner_email,
  owner_phone = EXCLUDED.owner_phone,
  transfer_number = EXCLUDED.transfer_number,
  greeting = EXCLUDED.greeting,
  system_prompt = EXCLUDED.system_prompt,
  subscription_status = EXCLUDED.subscription_status,
  grandfathered = EXCLUDED.grandfathered,
  tools_allowed = EXCLUDED.tools_allowed,
  tts_model = EXCLUDED.tts_model,
  stt_model = EXCLUDED.stt_model,
  llm_model = EXCLUDED.llm_model,
  tenant_key = EXCLUDED.tenant_key,
  bootstrap_state = EXCLUDED.bootstrap_state,
  updated_at = NOW();
