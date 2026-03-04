import { getTenant } from '../src/config/get-tenant';
import type { TenantConfig } from '../src/config/tenants';
import { closeDbPool } from '../src/db/client';
import { createClient, getClientByOwnerEmail, getClientByTwilioNumber, updateClient } from '../src/db/queries';

const DVDS_NUMBER = '+18773464394';
const ONBOARDING_NUMBER = '+14806313993';
const ADMIN_EMAIL = 'aust@autom8everything.com';

type SeedClientConfig = {
  label: string;
  tenant: TenantConfig;
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  transferNumber: string;
  subscriptionStatus: 'active';
  grandfathered: boolean;
  toolsAllowed: string[];
  ttsModel: string;
  sttModel: string;
};

function requireTenant(number: string, name: string): TenantConfig {
  const tenant = getTenant(number);
  if (!tenant) {
    throw new Error(`Unable to load tenant config for ${name} (${number})`);
  }
  return tenant;
}

async function upsertSeedClient(config: SeedClientConfig): Promise<void> {
  const existingByNumber = await getClientByTwilioNumber(config.tenant.twilioNumber);
  const existingByEmail = await getClientByOwnerEmail(config.ownerEmail);
  const existingClient = existingByNumber ?? existingByEmail;

  const payload = {
    businessName: config.businessName,
    ownerName: config.ownerName,
    ownerEmail: config.ownerEmail,
    ownerPhone: config.ownerPhone,
    transferNumber: config.transferNumber,
    twilioNumber: config.tenant.twilioNumber,
    systemPrompt: config.tenant.systemPrompt,
    greeting: config.tenant.greeting,
    ttsModel: config.ttsModel,
    sttModel: config.sttModel,
    toolsAllowed: config.toolsAllowed,
    subscriptionStatus: config.subscriptionStatus,
    grandfathered: config.grandfathered,
  };

  if (existingClient) {
    const updated = await updateClient(existingClient.id, payload);
    if (!updated) {
      throw new Error(`Failed to update ${config.label} client ${existingClient.id}`);
    }

    console.log(`Updated ${config.label} client ${updated.id} (${updated.twilioNumber || config.tenant.twilioNumber})`);
    return;
  }

  const created = await createClient({
    ...payload,
    stripeCustomerId: null,
  });

  console.log(`Created ${config.label} client ${created.id} (${created.twilioNumber || config.tenant.twilioNumber})`);
}

async function ensureAdminRecord(onboardingTenant: TenantConfig): Promise<void> {
  const existingAdmin = await getClientByOwnerEmail(ADMIN_EMAIL);
  if (existingAdmin) {
    console.log(`Admin login record already present on client ${existingAdmin.id} (${existingAdmin.businessName})`);
    return;
  }

  const created = await createClient({
    businessName: 'Cadence Admin',
    ownerName: 'Austen Salazar',
    ownerEmail: ADMIN_EMAIL,
    ownerPhone: '+16026633502',
    transferNumber: '+16026633502',
    systemPrompt: onboardingTenant.systemPrompt,
    greeting: onboardingTenant.greeting,
    stripeCustomerId: null,
    subscriptionStatus: 'active',
    grandfathered: true,
    ttsModel: 'aura-2-thalia-en',
    sttModel: 'nova-2',
    toolsAllowed: ['transfer_to_human', 'send_sms'],
  });

  console.log(`Created fallback admin login record ${created.id} (${created.ownerEmail})`);
}

async function seedClients(): Promise<void> {
  const dvdsTenant = requireTenant(DVDS_NUMBER, 'DVDS');
  const onboardingTenant = requireTenant(ONBOARDING_NUMBER, 'cadence-onboarding');

  await upsertSeedClient({
    label: 'DVDS',
    tenant: dvdsTenant,
    businessName: 'Deer Valley Driving School',
    ownerName: 'Austen Salazar',
    ownerEmail: 'austen.dvds@gmail.com',
    ownerPhone: '+16026633502',
    transferNumber: '+16026633502',
    subscriptionStatus: 'active',
    grandfathered: true,
    toolsAllowed: ['send_sms', 'transfer_to_human'],
    ttsModel: 'aura-2-thalia-en',
    sttModel: 'nova-2',
  });

  await upsertSeedClient({
    label: 'Cadence onboarding',
    tenant: onboardingTenant,
    businessName: 'Cadence by Autom8',
    ownerName: 'Austen Salazar',
    ownerEmail: ADMIN_EMAIL,
    ownerPhone: '+16026633502',
    transferNumber: '+16026633502',
    subscriptionStatus: 'active',
    grandfathered: true,
    toolsAllowed: onboardingTenant.tools,
    ttsModel: onboardingTenant.ttsModel || 'aura-2-thalia-en',
    sttModel: onboardingTenant.sttModel || 'nova-2',
  });

  await ensureAdminRecord(onboardingTenant);
}

seedClients()
  .catch((err) => {
    console.error('Client seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
