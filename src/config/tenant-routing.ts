import { getClientByTwilioNumber, type Client } from '../db/queries';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { getTenant } from './get-tenant';
import { normalizePhoneNumber, type TenantConfig } from './tenants';

const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

type CachedTenant = {
  tenant: TenantConfig | null;
  fetchedAt: number;
};

const tenantCache = new Map<string, CachedTenant>();

function getCachedTenant(normalizedTwilioNumber: string): TenantConfig | null | undefined {
  const cached = tenantCache.get(normalizedTwilioNumber);
  if (!cached) return undefined;

  const isExpired = Date.now() - cached.fetchedAt > TENANT_CACHE_TTL_MS;
  if (isExpired) {
    tenantCache.delete(normalizedTwilioNumber);
    return undefined;
  }

  return cached.tenant;
}

function setCachedTenant(normalizedTwilioNumber: string, tenant: TenantConfig | null): void {
  tenantCache.set(normalizedTwilioNumber, {
    tenant,
    fetchedAt: Date.now(),
  });
}

function mapClientToTenant(client: Client, normalizedTwilioNumber: string): TenantConfig {
  const businessName = client.businessName || 'Cadence Client';
  const transferNumber = normalizePhoneNumber(client.transferNumber || '');
  const ownerPhone = normalizePhoneNumber(client.ownerPhone || '');

  return {
    id: `client-${client.id}`,
    businessName,
    twilioNumber: normalizedTwilioNumber,
    systemPrompt:
      client.systemPrompt?.trim()
      || `You are Cadence, the AI receptionist for ${businessName}. Be warm, concise, and helpful.`,
    greeting:
      client.greeting?.trim()
      || `Hi, thanks for calling ${businessName}! This is Cadence, how can I help you today?`,
    ownerCell: ownerPhone || transferNumber,
    transferNumber: transferNumber || undefined,
    tools: client.toolsAllowed.length > 0 ? client.toolsAllowed : ['transfer_to_human', 'send_sms'],
    ttsModel: client.ttsModel || undefined,
    sttModel: client.sttModel || undefined,
  };
}

async function getTenantFromDatabase(normalizedTwilioNumber: string): Promise<TenantConfig | undefined> {
  if (!env.DATABASE_URL) {
    return undefined;
  }

  const client = await getClientByTwilioNumber(normalizedTwilioNumber);
  if (!client || client.subscriptionStatus === 'canceled') {
    return undefined;
  }

  return mapClientToTenant(client, normalizedTwilioNumber);
}

export async function resolveTenantForIncomingNumber(twilioNumber: string): Promise<TenantConfig | undefined> {
  const normalizedTwilioNumber = normalizePhoneNumber(twilioNumber);
  if (!normalizedTwilioNumber) {
    return undefined;
  }

  const cached = getCachedTenant(normalizedTwilioNumber);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  let tenant: TenantConfig | undefined;

  try {
    tenant = await getTenantFromDatabase(normalizedTwilioNumber);
  } catch (err) {
    logger.warn(
      { err, toNumber: normalizedTwilioNumber },
      'DB tenant lookup failed; falling back to in-memory registry'
    );
  }

  if (!tenant) {
    tenant = getTenant(normalizedTwilioNumber);
  }

  setCachedTenant(normalizedTwilioNumber, tenant ?? null);
  return tenant;
}

export const resolveTenantByTwilioNumber = resolveTenantForIncomingNumber;

export function invalidateTenantCacheByTwilioNumber(twilioNumber: string | null | undefined): void {
  if (!twilioNumber) return;

  const normalizedTwilioNumber = normalizePhoneNumber(twilioNumber);
  if (!normalizedTwilioNumber) return;

  tenantCache.delete(normalizedTwilioNumber);
}

export function invalidateTenantCache(): void {
  tenantCache.clear();
}
