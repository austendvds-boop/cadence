import type { TenantConfig } from '../config/tenants';
import { createClient, getClientByOwnerEmail, updateClient, type ClientFaq, type ClientHours } from '../db/queries';
import { sendSms, transferToHuman } from '../twilio/service';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

type ToolContext = {
  callSid: string;
  callerNumber?: string;
  tenant: TenantConfig;
  onboardingFields: Record<string, string>;
};

const ONBOARDING_TENANT_ID = 'cadence-onboarding';
const REQUIRED_ONBOARDING_FIELDS = [
  'business_name',
  'owner_name',
  'owner_email',
  'owner_phone',
  'business_description',
  'hours',
  'faqs',
  'transfer_number',
  'area_code',
] as const;

const ONBOARDING_FIELD_ALIASES: Record<(typeof REQUIRED_ONBOARDING_FIELDS)[number], string[]> = {
  business_name: ['business_name'],
  owner_name: ['owner_name'],
  owner_email: ['owner_email', 'email'],
  owner_phone: ['owner_phone', 'phone', 'phone_number', 'sms_phone'],
  business_description: ['business_description', 'what_business_does', 'description'],
  hours: ['hours', 'business_hours'],
  faqs: ['faqs', 'common_questions', 'common_caller_questions'],
  transfer_number: ['transfer_number', 'human_transfer_number'],
  area_code: ['area_code', 'preferred_area_code'],
};

const ONBOARDING_PAYMENT_SMS_TEMPLATE = (checkoutUrl: string) =>
  `Complete your Cadence setup: ${checkoutUrl} — Your AI receptionist will be live in minutes after payment.`;

const ONBOARDING_COMPLETION_VOICE_LINE =
  "Perfect — I've got everything I need. I'm texting you a link right now to complete your payment. Once you pay, your AI receptionist number will be live in about 2 minutes. Pretty cool, right?";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isE164PhoneNumber(value: string): boolean {
  return /^\+[0-9]+$/.test(value);
}

function isToolEnabledForTenant(name: string, tenant: TenantConfig): boolean {
  return tenant.tools.includes(name);
}

function isOnboardingTenant(tenant: TenantConfig): boolean {
  return tenant.id === ONBOARDING_TENANT_ID;
}

function getOnboardingField(fields: Record<string, string>, key: (typeof REQUIRED_ONBOARDING_FIELDS)[number]): string {
  const aliases = ONBOARDING_FIELD_ALIASES[key] || [key];
  for (const alias of aliases) {
    const value = asTrimmedString(fields[alias]);
    if (value) return value;
  }
  return '';
}

function hasCollectedOnboardingField(fields: Record<string, string>, key: (typeof REQUIRED_ONBOARDING_FIELDS)[number]): boolean {
  const aliases = ONBOARDING_FIELD_ALIASES[key] || [key];
  return aliases.some((alias) => asTrimmedString(fields[alias]).length > 0);
}

function listMissingOnboardingFields(fields: Record<string, string>): string[] {
  return REQUIRED_ONBOARDING_FIELDS.filter((key) => !hasCollectedOnboardingField(fields, key));
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = asTrimmedString(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeAreaCode(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 3 ? digits : '';
}

function normalizePhoneNumber(value: string): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return '';

  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return digits ? `+${digits}` : '';
  }

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

function isProvidedValue(value: string): boolean {
  const normalized = asTrimmedString(value).toLowerCase();
  return Boolean(normalized && normalized !== 'not provided');
}

function buildClientSystemPrompt(businessName: string, businessDescription: string, faqs: ClientFaq[]): string {
  const summary = isProvidedValue(businessDescription)
    ? businessDescription
    : 'Provide friendly, concise help to callers and route urgent calls to a human when needed.';

  const faqLines = faqs
    .filter((faq) => faq.q.trim())
    .slice(0, 6)
    .map((faq) => `- ${faq.q.trim()}${faq.a.trim() ? `: ${faq.a.trim()}` : ''}`);

  const faqBlock = faqLines.length > 0
    ? `\n\nCommon caller questions:\n${faqLines.join('\n')}`
    : '';

  return `You are Cadence, the AI receptionist for ${businessName}. Be warm, concise, and helpful on phone calls.\n\nBusiness summary: ${summary}${faqBlock}`;
}

function parseHours(value: string): ClientHours {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const output: ClientHours = {};
      for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof raw === 'string' && raw.trim()) {
          output[key] = raw.trim();
        }
      }
      if (Object.keys(output).length > 0) {
        return output;
      }
    }
  } catch {
    // fall through to simple text storage
  }

  return { general: value };
}

function parseFaqs(value: string): ClientFaq[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      const faqs: ClientFaq[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const q = asTrimmedString((item as Record<string, unknown>).q);
        const a = asTrimmedString((item as Record<string, unknown>).a);
        if (q) {
          faqs.push({ q, a });
        }
      }
      if (faqs.length > 0) {
        return faqs;
      }
    }
  } catch {
    // fall through to line split
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  if (lines.length === 0) return [];
  return lines.map((line) => ({ q: line, a: '' }));
}

async function upsertPendingClient(fields: Record<string, string>, callerNumber?: string) {
  const businessName = firstNonEmpty(getOnboardingField(fields, 'business_name'), 'Cadence Client');
  const ownerName = firstNonEmpty(getOnboardingField(fields, 'owner_name'), 'Cadence Customer');
  const ownerEmail = getOnboardingField(fields, 'owner_email').toLowerCase();
  const ownerPhone = firstNonEmpty(
    normalizePhoneNumber(getOnboardingField(fields, 'owner_phone')),
    normalizePhoneNumber(asTrimmedString(callerNumber))
  );
  const transferNumber = normalizePhoneNumber(getOnboardingField(fields, 'transfer_number'));
  const areaCode = normalizeAreaCode(getOnboardingField(fields, 'area_code'));
  const businessDescription = getOnboardingField(fields, 'business_description');
  const hours = parseHours(getOnboardingField(fields, 'hours'));
  const faqs = parseFaqs(getOnboardingField(fields, 'faqs'));

  if (!isProvidedValue(ownerEmail)) {
    throw new Error('Owner email is required before completing onboarding.');
  }

  const existingClient = await getClientByOwnerEmail(ownerEmail);
  const input = {
    businessName,
    ownerName: ownerName || null,
    ownerPhone: ownerPhone || null,
    transferNumber: transferNumber || null,
    areaCode: areaCode || null,
    hours,
    faqs,
    greeting: `Hi, thanks for calling ${businessName}! This is Cadence, how can I help you today?`,
    systemPrompt: buildClientSystemPrompt(businessName, businessDescription, faqs),
    subscriptionStatus: 'pending' as const,
  };

  if (existingClient) {
    const updated = await updateClient(existingClient.id, input);
    return updated ?? existingClient;
  }

  return createClient({
    ...input,
    ownerEmail,
    stripeCustomerId: null,
  });
}

async function createCheckoutLink(payload: {
  businessName: string;
  ownerName: string | null;
  ownerEmail: string;
  ownerPhone: string | null;
  transferNumber: string | null;
  areaCode: string | null;
}): Promise<string> {
  const response = await fetch(`${env.BASE_URL}/api/stripe/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: payload.ownerEmail,
      businessName: payload.businessName,
      ownerName: payload.ownerName,
      ownerPhone: payload.ownerPhone,
      transferNumber: payload.transferNumber,
      areaCode: payload.areaCode,
      subscriptionStatus: 'pending',
    }),
  });

  const result = await response.json().catch(() => ({} as Record<string, unknown>));
  const checkoutUrl = asTrimmedString((result as Record<string, unknown>).url);

  if (!response.ok || !checkoutUrl) {
    throw new Error(`Failed to generate checkout link (${response.status})`);
  }

  return checkoutUrl;
}

export async function executeTool(name: string, args: unknown, ctx: ToolContext) {
  if (!isToolEnabledForTenant(name, ctx.tenant)) {
    logger.warn({ tool: name, tenantId: ctx.tenant.id }, 'tool blocked: not enabled for tenant');
    return { ok: false, error: 'This action is not enabled for this business.' };
  }

  switch (name) {
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, {
        ownerCell: ctx.tenant.transferNumber || ctx.tenant.ownerCell,
        reason: 'Caller requested human assistance',
      });

    case 'send_sms': {
      const parsedArgs = asRecord(args);
      const destination = asTrimmedString(parsedArgs.phone) || asTrimmedString(ctx.callerNumber);

      if (!destination || !isE164PhoneNumber(destination)) {
        return { ok: false, error: "I don't have a valid phone number to send the text to" };
      }

      const message = asTrimmedString(parsedArgs.message);

      try {
        return await sendSms(destination, message);
      } catch (err) {
        logger.error({ err, to: destination, tenantId: ctx.tenant.id }, 'send_sms tool failed');
        throw err;
      }
    }

    case 'save_onboarding_field': {
      if (!isOnboardingTenant(ctx.tenant)) {
        return { ok: false, error: 'Onboarding fields are only available for onboarding calls.' };
      }

      const parsedArgs = asRecord(args);
      const field = asTrimmedString(parsedArgs.field);
      const rawValue = asTrimmedString(parsedArgs.value);

      if (!field) {
        return { ok: false, error: 'Missing required field name.' };
      }

      let value = rawValue || 'not provided';
      if ((field === 'owner_phone' || field === 'transfer_number') && isProvidedValue(value)) {
        value = normalizePhoneNumber(value) || value;
      }
      if (field === 'area_code' && isProvidedValue(value)) {
        value = normalizeAreaCode(value) || value;
      }

      ctx.onboardingFields[field] = value;
      return { ok: true, field, value, message: `Saved onboarding field: ${field}` };
    }

    case 'complete_onboarding': {
      if (!isOnboardingTenant(ctx.tenant)) {
        return { ok: false, error: 'Onboarding completion is only available for onboarding calls.' };
      }

      try {
        const missingFields = listMissingOnboardingFields(ctx.onboardingFields);
        if (missingFields.length > 0) {
          return {
            ok: false,
            error: `Missing required onboarding fields: ${missingFields.join(', ')}`,
            missing_fields: missingFields,
          };
        }

        const pendingClient = await upsertPendingClient(ctx.onboardingFields, ctx.callerNumber);
        const checkoutUrl = await createCheckoutLink({
          businessName: pendingClient.businessName,
          ownerName: pendingClient.ownerName,
          ownerEmail: pendingClient.ownerEmail,
          ownerPhone: pendingClient.ownerPhone,
          transferNumber: pendingClient.transferNumber,
          areaCode: pendingClient.areaCode,
        });

        const destination = normalizePhoneNumber(firstNonEmpty(
          getOnboardingField(ctx.onboardingFields, 'owner_phone'),
          pendingClient.ownerPhone,
        ));

        if (!destination || !isE164PhoneNumber(destination)) {
          return {
            ok: false,
            error: 'Checkout link created but no valid owner_phone was available for SMS delivery.',
            checkout_url: checkoutUrl,
          };
        }

        const smsMessage = ONBOARDING_PAYMENT_SMS_TEMPLATE(checkoutUrl);
        await sendSms(destination, smsMessage);

        return {
          ok: true,
          clientId: pendingClient.id,
          checkout_url: checkoutUrl,
          sentTo: destination,
          message: 'Stripe checkout link sent via SMS.',
          customer_message: ONBOARDING_COMPLETION_VOICE_LINE,
        };
      } catch (error) {
        logger.error({ error, callSid: ctx.callSid, onboardingFields: ctx.onboardingFields }, 'complete_onboarding failed');
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to complete onboarding at the moment.',
        };
      }
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
