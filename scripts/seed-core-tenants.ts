import { CORE_TENANT_LIST, type CoreTenantDefaults } from '../src/config/core-tenant-defaults';
import { closeDbPool } from '../src/db/client';
import {
  createClient,
  getClientByOwnerEmail,
  getClientByTenantKey,
  getClientByTwilioNumber,
  updateClient,
} from '../src/db/queries';

async function resolveExistingCoreTenant(seed: CoreTenantDefaults) {
  const existingByTenantKey = await getClientByTenantKey(seed.tenantKey);
  if (existingByTenantKey) return existingByTenantKey;

  const existingByNumber = await getClientByTwilioNumber(seed.twilioNumber);
  if (existingByNumber) return existingByNumber;

  return getClientByOwnerEmail(seed.ownerEmail);
}

async function upsertCoreTenant(seed: CoreTenantDefaults): Promise<void> {
  const existing = await resolveExistingCoreTenant(seed);

  const payload = {
    businessName: seed.businessName,
    ownerName: seed.ownerName,
    ownerEmail: seed.ownerEmail,
    ownerPhone: seed.ownerCell,
    transferNumber: seed.transferNumber || seed.ownerCell,
    twilioNumber: seed.twilioNumber,
    greeting: seed.greeting,
    systemPrompt: seed.systemPrompt,
    subscriptionStatus: seed.subscriptionStatus,
    grandfathered: seed.grandfathered,
    toolsAllowed: seed.tools,
    ttsModel: seed.ttsModel || 'aura-2-thalia-en',
    sttModel: seed.sttModel || 'nova-2',
    llmModel: seed.llmModel,
    tenantKey: seed.tenantKey,
    bootstrapState: 'active' as const,
  };

  if (existing) {
    const updated = await updateClient(existing.id, payload);
    if (!updated) {
      throw new Error(`Failed to update ${seed.tenantKey} core tenant (${existing.id})`);
    }

    console.log(`Updated core tenant ${seed.tenantKey} (${updated.id})`);
    return;
  }

  const created = await createClient({
    ...payload,
    stripeCustomerId: null,
  });

  console.log(`Created core tenant ${seed.tenantKey} (${created.id})`);
}

async function seedCoreTenants(): Promise<void> {
  for (const tenant of CORE_TENANT_LIST) {
    await upsertCoreTenant(tenant);
  }
}

seedCoreTenants()
  .catch((error) => {
    console.error('Core tenant seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
