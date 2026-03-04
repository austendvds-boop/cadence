import type { TenantConfig } from '../config/tenants';

type PromptToken = 'BUSINESS_NAME' | 'TWILIO_NUMBER' | 'OWNER_CELL';

const PROMPT_TOKEN_PATTERN = /\{\{\s*([A-Z_]+)\s*\}\}/g;

function isPromptToken(value: string): value is PromptToken {
  return value === 'BUSINESS_NAME' || value === 'TWILIO_NUMBER' || value === 'OWNER_CELL';
}

export function buildSystemPrompt(tenant: TenantConfig): string {
  const replacements: Record<PromptToken, string> = {
    BUSINESS_NAME: tenant.businessName,
    TWILIO_NUMBER: tenant.twilioNumber,
    OWNER_CELL: tenant.ownerCell,
  };

  return tenant.systemPrompt.replace(PROMPT_TOKEN_PATTERN, (_match, tokenName: string) => {
    if (!isPromptToken(tokenName)) {
      return _match;
    }
    return replacements[tokenName];
  });
}
