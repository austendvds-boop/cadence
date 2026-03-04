import { CORE_TENANT_DEFAULTS } from '../src/config/core-tenant-defaults';
import { closeDbPool, withDbClient } from '../src/db/client';

const onboardingTenant = CORE_TENANT_DEFAULTS['cadence-onboarding'];
const dvdsTenant = CORE_TENANT_DEFAULTS.dvds;

async function resetOnboardingClient(): Promise<void> {
  await withDbClient(async (client) => {
    await client.query('BEGIN');

    try {
      const dvdsBefore = await client.query(
        'SELECT COUNT(*)::int AS count FROM clients WHERE twilio_number = $1',
        [dvdsTenant.twilioNumber]
      );

      const conflictingEmail = await client.query(
        `
          SELECT id, twilio_number
          FROM clients
          WHERE lower(owner_email) = lower($1)
            AND COALESCE(twilio_number, '') <> $2
          LIMIT 1
        `,
        [onboardingTenant.ownerEmail, onboardingTenant.twilioNumber]
      );

      if ((conflictingEmail.rowCount ?? 0) > 0) {
        const conflict = conflictingEmail.rows[0] as { id: string; twilio_number: string | null };
        throw new Error(
          `Owner email ${onboardingTenant.ownerEmail} already used by non-onboarding client ${conflict.id} (${conflict.twilio_number || 'no twilio number'})`
        );
      }

      const deleted = await client.query(
        'DELETE FROM clients WHERE twilio_number = $1 RETURNING id',
        [onboardingTenant.twilioNumber]
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
          RETURNING id, owner_email, subscription_status, twilio_number, tools_allowed, tts_model, stt_model, tenant_key
        `,
        [
          onboardingTenant.businessName,
          onboardingTenant.ownerName,
          onboardingTenant.ownerEmail,
          onboardingTenant.ownerCell,
          onboardingTenant.transferNumber || onboardingTenant.ownerCell,
          onboardingTenant.greeting,
          onboardingTenant.systemPrompt,
          onboardingTenant.twilioNumber,
          null,
          null,
          onboardingTenant.subscriptionStatus,
          onboardingTenant.grandfathered,
          onboardingTenant.ttsModel || 'aura-2-thalia-en',
          onboardingTenant.sttModel || 'nova-2',
          onboardingTenant.llmModel,
          onboardingTenant.tools,
          onboardingTenant.tenantKey,
          'active',
        ]
      );

      const onboardingRows = await client.query(
        `
          SELECT id, owner_email, subscription_status, twilio_number, tenant_key
          FROM clients
          WHERE twilio_number = $1
        `,
        [onboardingTenant.twilioNumber]
      );

      if ((onboardingRows.rowCount ?? 0) !== 1) {
        throw new Error(`Expected exactly one onboarding row for ${onboardingTenant.twilioNumber}, found ${onboardingRows.rowCount ?? 0}`);
      }

      const onboardingRow = onboardingRows.rows[0] as {
        owner_email: string;
        subscription_status: string;
        tenant_key: string | null;
      };

      if (onboardingRow.owner_email.toLowerCase() !== onboardingTenant.ownerEmail.toLowerCase()) {
        throw new Error(`Onboarding owner_email mismatch: expected ${onboardingTenant.ownerEmail}, got ${onboardingRow.owner_email}`);
      }

      if (onboardingRow.subscription_status !== onboardingTenant.subscriptionStatus) {
        throw new Error(`Onboarding subscription_status mismatch: expected ${onboardingTenant.subscriptionStatus}, got ${onboardingRow.subscription_status}`);
      }

      if ((onboardingRow.tenant_key || '') !== onboardingTenant.tenantKey) {
        throw new Error(`Onboarding tenant_key mismatch: expected ${onboardingTenant.tenantKey}, got ${onboardingRow.tenant_key || '<null>'}`);
      }

      const dvdsAfter = await client.query(
        'SELECT COUNT(*)::int AS count FROM clients WHERE twilio_number = $1',
        [dvdsTenant.twilioNumber]
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
            ownerEmail: onboardingTenant.ownerEmail,
            subscriptionStatus: onboardingTenant.subscriptionStatus,
            twilioNumber: onboardingTenant.twilioNumber,
            tenantKey: onboardingTenant.tenantKey,
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
