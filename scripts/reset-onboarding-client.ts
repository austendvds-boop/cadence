import { getTenant } from '../src/config/get-tenant';
import { closeDbPool, withDbClient } from '../src/db/client';

const ONBOARDING_NUMBER = '+14806313993';
const DVDS_NUMBER = '+18773464394';
const ONBOARDING_OWNER_EMAIL = 'aust@autom8everything.com';

async function resetOnboardingClient(): Promise<void> {
  const onboardingTenant = getTenant(ONBOARDING_NUMBER);
  if (!onboardingTenant || onboardingTenant.id !== 'cadence-onboarding') {
    throw new Error(`Unable to load cadence-onboarding defaults for ${ONBOARDING_NUMBER}`);
  }

  await withDbClient(async (client) => {
    await client.query('BEGIN');

    try {
      const dvdsBefore = await client.query(
        'SELECT COUNT(*)::int AS count FROM clients WHERE twilio_number = $1',
        [DVDS_NUMBER]
      );

      const conflictingEmail = await client.query(
        `
          SELECT id, twilio_number
          FROM clients
          WHERE lower(owner_email) = lower($1)
            AND COALESCE(twilio_number, '') <> $2
          LIMIT 1
        `,
        [ONBOARDING_OWNER_EMAIL, ONBOARDING_NUMBER]
      );

      if ((conflictingEmail.rowCount ?? 0) > 0) {
        const conflict = conflictingEmail.rows[0] as { id: string; twilio_number: string | null };
        throw new Error(
          `Owner email ${ONBOARDING_OWNER_EMAIL} already used by non-onboarding client ${conflict.id} (${conflict.twilio_number || 'no twilio number'})`
        );
      }

      const deleted = await client.query(
        'DELETE FROM clients WHERE twilio_number = $1 RETURNING id',
        [ONBOARDING_NUMBER]
      );

      const inserted = await client.query(
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
            tools_allowed
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15::text[]
          )
          RETURNING id, owner_email, subscription_status, twilio_number, tools_allowed, tts_model, stt_model
        `,
        [
          onboardingTenant.businessName,
          'Austen Salazar',
          ONBOARDING_OWNER_EMAIL,
          onboardingTenant.ownerCell,
          onboardingTenant.transferNumber || onboardingTenant.ownerCell,
          onboardingTenant.greeting,
          onboardingTenant.systemPrompt,
          onboardingTenant.twilioNumber,
          null,
          null,
          'active',
          true,
          onboardingTenant.ttsModel || 'aura-2-thalia-en',
          onboardingTenant.sttModel || 'nova-2',
          onboardingTenant.tools,
        ]
      );

      const onboardingRows = await client.query(
        `
          SELECT id, owner_email, subscription_status, twilio_number
          FROM clients
          WHERE twilio_number = $1
        `,
        [ONBOARDING_NUMBER]
      );

      if ((onboardingRows.rowCount ?? 0) !== 1) {
        throw new Error(`Expected exactly one onboarding row for ${ONBOARDING_NUMBER}, found ${onboardingRows.rowCount ?? 0}`);
      }

      const onboardingRow = onboardingRows.rows[0] as {
        owner_email: string;
        subscription_status: string;
      };

      if (onboardingRow.owner_email.toLowerCase() !== ONBOARDING_OWNER_EMAIL) {
        throw new Error(`Onboarding owner_email mismatch: expected ${ONBOARDING_OWNER_EMAIL}, got ${onboardingRow.owner_email}`);
      }

      if (onboardingRow.subscription_status !== 'active') {
        throw new Error(`Onboarding subscription_status mismatch: expected active, got ${onboardingRow.subscription_status}`);
      }

      const dvdsAfter = await client.query(
        'SELECT COUNT(*)::int AS count FROM clients WHERE twilio_number = $1',
        [DVDS_NUMBER]
      );

      if ((dvdsBefore.rows[0] as { count: number }).count !== (dvdsAfter.rows[0] as { count: number }).count) {
        throw new Error('DVDS row count changed unexpectedly while resetting onboarding client');
      }

      await client.query('COMMIT');

      console.log(
        JSON.stringify(
          {
            deletedCount: deleted.rowCount ?? 0,
            onboardingClientId: (inserted.rows[0] as { id: string }).id,
            ownerEmail: ONBOARDING_OWNER_EMAIL,
            subscriptionStatus: 'active',
            twilioNumber: ONBOARDING_NUMBER,
            verifiedCount: onboardingRows.rowCount,
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
