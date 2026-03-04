import { closeDbPool, withDbClient } from '../src/db/client';

const ONBOARDING_TWILIO_NUMBER = '+14806313993';
const ONBOARDING_TENANT_KEY = 'autom8-onboarding';
const ONBOARDING_TOOLS = ['save_onboarding_field', 'complete_onboarding'];
const ONBOARDING_OWNER_PHONE = '+16026633503';

const ONBOARDING_GREETING =
  "Hey! Thanks for calling Autom8. I'm Cadence — I help set up AI phone agents for businesses. Mind if I ask you a few quick questions so we can get yours rolling?";

const ONBOARDING_SYSTEM_PROMPT = `You are Cadence, the friendly onboarding assistant for Autom8 Everything.

Open every new call with exactly this line:
"Hey! Thanks for calling Autom8. I'm Cadence — I help set up AI phone agents for businesses. Mind if I ask you a few quick questions so we can get yours rolling?"

Keep the call conversational and efficient. Use 2-3 short sentences max per turn. Sound natural, not robotic.

Collect these onboarding details naturally throughout the conversation:
1) Business name
2) What type of business they run
3) Business hours
4) Main services/products and typical pricing
5) Common caller questions (FAQs)
6) How they want calls handled (take messages, book appointments, transfer, etc.)
7) Best contact email

For each answer, call save_onboarding_field immediately using these exact keys:
- business_name
- business_type
- business_hours
- services_and_pricing
- faqs
- call_handling
- contact_email

If the caller is unsure about a detail, ask one short follow-up. If they still do not know, save "not provided" and keep moving.

After all fields are captured, confirm with:
"Alright, let me make sure I got everything right..."
Then read back the collected details clearly and ask for confirmation.

When the caller confirms, call complete_onboarding.
If complete_onboarding returns customer_message, say that line exactly.

Do not mention internal systems, database logic, or implementation details.`;

async function resetOnboardingClient(): Promise<void> {
  await withDbClient(async (client) => {
    await client.query('BEGIN');

    try {
      await client.query(
        `
          DELETE FROM clients
          WHERE tenant_key = 'cadence-onboarding'
            AND twilio_number IS DISTINCT FROM $1
        `,
        [ONBOARDING_TWILIO_NUMBER]
      );

      const upserted = await client.query(
        `
          INSERT INTO clients (
            business_name,
            owner_name,
            owner_email,
            owner_phone,
            transfer_number,
            greeting,
            system_prompt,
            twilio_number,
            stripe_customer_id,
            stripe_subscription_id,
            subscription_status,
            grandfathered,
            tts_model,
            stt_model,
            llm_model,
            tools_allowed,
            tenant_key,
            bootstrap_state
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16::text[], $17, $18
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
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            stripe_subscription_id = EXCLUDED.stripe_subscription_id,
            subscription_status = EXCLUDED.subscription_status,
            grandfathered = EXCLUDED.grandfathered,
            tts_model = EXCLUDED.tts_model,
            stt_model = EXCLUDED.stt_model,
            llm_model = EXCLUDED.llm_model,
            tools_allowed = EXCLUDED.tools_allowed,
            tenant_key = EXCLUDED.tenant_key,
            bootstrap_state = EXCLUDED.bootstrap_state,
            updated_at = NOW()
          RETURNING
            id,
            business_name,
            owner_email,
            twilio_number,
            tenant_key,
            tools_allowed,
            subscription_status,
            bootstrap_state
        `,
        [
          'Autom8 Everything - Cadence Onboarding',
          'Austen Salazar',
          'aust@autom8everything.com',
          ONBOARDING_OWNER_PHONE,
          ONBOARDING_OWNER_PHONE,
          ONBOARDING_GREETING,
          ONBOARDING_SYSTEM_PROMPT,
          ONBOARDING_TWILIO_NUMBER,
          null,
          null,
          'active',
          true,
          'aura-2-thalia-en',
          'nova-2',
          'gpt-4o-mini',
          ONBOARDING_TOOLS,
          ONBOARDING_TENANT_KEY,
          'active',
        ]
      );

      const row = upserted.rows[0] as {
        id: string;
        business_name: string;
        owner_email: string;
        twilio_number: string;
        tenant_key: string | null;
        tools_allowed: string[];
        subscription_status: string;
        bootstrap_state: string;
      };

      if (row.twilio_number !== ONBOARDING_TWILIO_NUMBER) {
        throw new Error(`Onboarding twilio_number mismatch: ${row.twilio_number}`);
      }

      if (row.business_name !== 'Autom8 Everything - Cadence Onboarding') {
        throw new Error(`Onboarding business_name mismatch: ${row.business_name}`);
      }

      await client.query('COMMIT');

      console.log(
        JSON.stringify(
          {
            onboardingClientId: row.id,
            businessName: row.business_name,
            ownerEmail: row.owner_email,
            twilioNumber: row.twilio_number,
            tenantKey: row.tenant_key,
            toolsAllowed: row.tools_allowed,
            subscriptionStatus: row.subscription_status,
            bootstrapState: row.bootstrap_state,
          },
          null,
          2
        )
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

resetOnboardingClient()
  .catch((error) => {
    console.error('Failed to reset onboarding client:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
