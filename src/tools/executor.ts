import type { TenantConfig } from '../config/tenants';
import { sendSms, transferToHuman } from '../twilio/service';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

type ToolContext = {
  callSid: string;
  callerNumber?: string;
  tenant: TenantConfig;
  onboardingFields: Record<string, string>;
};

const REQUIRED_ONBOARDING_FIELDS = [
  'business_name',
  'business_type',
  'business_hours',
  'services_and_pricing',
  'faqs',
  'call_handling',
  'contact_email',
] as const;

const ONBOARDING_FIELD_ALIASES: Record<(typeof REQUIRED_ONBOARDING_FIELDS)[number], string[]> = {
  business_name: ['business_name', 'company_name'],
  business_type: ['business_type', 'business_description', 'what_type_of_business'],
  business_hours: ['business_hours', 'hours'],
  services_and_pricing: ['services_and_pricing', 'services', 'products_and_prices'],
  faqs: ['faqs', 'common_questions', 'common_caller_questions'],
  call_handling: ['call_handling', 'call_flow', 'how_to_handle_calls'],
  contact_email: ['contact_email', 'owner_email', 'email'],
};

const ONBOARDING_SUMMARY_SMS_TO = (() => {
  const configured = (env.ONBOARDING_SUMMARY_SMS_TO || '').trim();
  return isE164PhoneNumber(configured) ? configured : '+16026633503';
})();
const ONBOARDING_COMPLETE_VOICE_LINE =
  "You're all set! Someone from our team will reach out within 24 hours to get your AI agent live. Thanks for choosing Autom8!";

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

function toolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown tool error';
}

function buildOnboardingSummary(ctx: ToolContext): string {
  const businessName = getOnboardingField(ctx.onboardingFields, 'business_name') || 'not provided';
  const businessType = getOnboardingField(ctx.onboardingFields, 'business_type') || 'not provided';
  const businessHours = getOnboardingField(ctx.onboardingFields, 'business_hours') || 'not provided';
  const servicesAndPricing = getOnboardingField(ctx.onboardingFields, 'services_and_pricing') || 'not provided';
  const faqs = getOnboardingField(ctx.onboardingFields, 'faqs') || 'not provided';
  const callHandling = getOnboardingField(ctx.onboardingFields, 'call_handling') || 'not provided';
  const contactEmail = getOnboardingField(ctx.onboardingFields, 'contact_email') || 'not provided';

  return [
    'New Cadence onboarding call intake',
    `Business name: ${businessName}`,
    `Business type: ${businessType}`,
    `Business hours: ${businessHours}`,
    `Services/products + pricing: ${servicesAndPricing}`,
    `Common caller FAQs: ${faqs}`,
    `Preferred call handling: ${callHandling}`,
    `Best contact email: ${contactEmail}`,
    `Caller number: ${firstNonEmpty(ctx.callerNumber, 'unknown')}`,
    `Call SID: ${ctx.callSid}`,
  ].join('\n');
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
      const parsedArgs = asRecord(args);
      const field = asTrimmedString(parsedArgs.field);
      const value = asTrimmedString(parsedArgs.value) || 'not provided';

      if (!field) {
        return { ok: false, error: 'Missing required field name.' };
      }

      ctx.onboardingFields[field] = value;
      return { ok: true, field, value, message: `Saved onboarding field: ${field}` };
    }

    case 'complete_onboarding': {
      try {
        const missingFields = listMissingOnboardingFields(ctx.onboardingFields);
        if (missingFields.length > 0) {
          logger.info({ callSid: ctx.callSid, missingFields }, '[ONBOARDING] complete_onboarding missing required fields');
          return {
            ok: false,
            error: `Missing required onboarding fields: ${missingFields.join(', ')}`,
            missing_fields: missingFields,
          };
        }

        const summaryBody = buildOnboardingSummary(ctx);
        await sendSms(ONBOARDING_SUMMARY_SMS_TO, summaryBody);

        const result = {
          ok: true,
          summary_sms_sent: true,
          summary_sms_to: ONBOARDING_SUMMARY_SMS_TO,
          message: 'Onboarding summary sent to Autom8 team.',
          customer_message: ONBOARDING_COMPLETE_VOICE_LINE,
        };

        logger.info(
          {
            callSid: ctx.callSid,
            summarySmsTo: ONBOARDING_SUMMARY_SMS_TO,
            tenantId: ctx.tenant.id,
          },
          '[ONBOARDING] complete_onboarding result'
        );

        return result;
      } catch (error) {
        logger.error({ error, callSid: ctx.callSid, onboardingFields: ctx.onboardingFields }, '[ONBOARDING] complete_onboarding failed');
        return {
          ok: false,
          summary_sms_sent: false,
          summary_sms_to: ONBOARDING_SUMMARY_SMS_TO,
          error: toolErrorMessage(error) || 'Unable to complete onboarding at the moment.',
        };
      }
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
