export interface TenantConfig {
  id: string;
  businessName: string;
  twilioNumber: string;
  systemPrompt: string;
  greeting: string;
  ownerCell: string;
  transferNumber?: string;
  acuityUserId?: number;
  acuityCalendarIds?: number[];
  appointmentTypeIds?: Record<string, number>;
  tools: string[];
  ttsModel?: string;
  sttModel?: string;
  metadata?: Record<string, string>;
}

export function normalizePhoneNumber(phoneNumber: string): string {
  const trimmed = phoneNumber.trim();
  if (!trimmed) return '';

  const digitsWithPlus = trimmed.replace(/[^\d+]/g, '');
  if (!digitsWithPlus) return '';

  if (digitsWithPlus.startsWith('+')) {
    return `+${digitsWithPlus.slice(1).replace(/\D/g, '')}`;
  }

  const digitsOnly = digitsWithPlus.replace(/\D/g, '');
  return digitsOnly ? `+${digitsOnly}` : '';
}
