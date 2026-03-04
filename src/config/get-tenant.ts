import { normalizePhoneNumber, tenantRegistry, type TenantConfig } from './tenants';

export function getTenant(twilioNumber: string): TenantConfig | undefined {
  const normalizedTwilioNumber = normalizePhoneNumber(twilioNumber);
  if (!normalizedTwilioNumber) return undefined;
  return tenantRegistry[normalizedTwilioNumber];
}
