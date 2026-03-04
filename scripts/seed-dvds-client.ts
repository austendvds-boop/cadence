import { getTenant } from '../src/config/get-tenant';
import { closeDbPool } from '../src/db/client';
import { createClient, getClientByOwnerEmail, getClientByTwilioNumber, updateClient } from '../src/db/queries';

const DVDS_NUMBER = '+18773464394';
const DVDS_OWNER_EMAIL = 'aust@autom8everything.com';

async function seedDvdsClient(): Promise<void> {
  const dvdsTenant = getTenant(DVDS_NUMBER);
  if (!dvdsTenant) {
    throw new Error(`Unable to load legacy DVDS tenant config for ${DVDS_NUMBER}`);
  }

  const existingClient = (await getClientByTwilioNumber(dvdsTenant.twilioNumber))
    ?? (await getClientByOwnerEmail(DVDS_OWNER_EMAIL));

  if (existingClient) {
    const updated = await updateClient(existingClient.id, {
      businessName: 'Deer Valley Driving School',
      ownerEmail: DVDS_OWNER_EMAIL,
      ownerName: existingClient.ownerName || 'Austen',
      ownerPhone: existingClient.ownerPhone || dvdsTenant.ownerCell,
      transferNumber: dvdsTenant.transferNumber || dvdsTenant.ownerCell,
      twilioNumber: DVDS_NUMBER,
      systemPrompt: dvdsTenant.systemPrompt,
      greeting: dvdsTenant.greeting,
      ttsModel: dvdsTenant.ttsModel || 'aura-2-thalia-en',
      sttModel: dvdsTenant.sttModel || 'nova-2',
      toolsAllowed: dvdsTenant.tools,
      subscriptionStatus: 'active',
      grandfathered: true,
    });

    if (!updated) {
      throw new Error(`Failed to update DVDS client ${existingClient.id}`);
    }

    console.log(`Updated DVDS client ${updated.id} (${updated.twilioNumber || DVDS_NUMBER})`);
    return;
  }

  const created = await createClient({
    businessName: 'Deer Valley Driving School',
    ownerName: 'Austen',
    ownerEmail: DVDS_OWNER_EMAIL,
    ownerPhone: dvdsTenant.ownerCell,
    transferNumber: dvdsTenant.transferNumber || dvdsTenant.ownerCell,
    twilioNumber: DVDS_NUMBER,
    systemPrompt: dvdsTenant.systemPrompt,
    greeting: dvdsTenant.greeting,
    stripeCustomerId: null,
    ttsModel: dvdsTenant.ttsModel || 'aura-2-thalia-en',
    sttModel: dvdsTenant.sttModel || 'nova-2',
    toolsAllowed: dvdsTenant.tools,
    subscriptionStatus: 'active',
    grandfathered: true,
  });

  console.log(`Created DVDS client ${created.id} (${created.twilioNumber || DVDS_NUMBER})`);
}

seedDvdsClient()
  .catch((err) => {
    console.error('DVDS seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
