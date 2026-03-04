import type { TenantConfig } from '../config/tenants';
import { sendSms, transferToHuman } from '../twilio/service';
import { logger } from '../utils/logger';

type ToolContext = {
  callSid: string;
  callerNumber?: string;
  tenant: TenantConfig;
  onboardingFields: Record<string, string>;
};

const ONBOARDING_TENANT_ID = 'cadence-onboarding';
const ONBOARDING_SUMMARY_NUMBER = '+16026633502';

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

function buildOnboardingSummary(ctx: ToolContext): string {
  const payload = {
    tenantId: ctx.tenant.id,
    callSid: ctx.callSid,
    callerNumber: ctx.callerNumber || 'unknown',
    submittedAt: new Date().toISOString(),
    fields: ctx.onboardingFields,
  };

  return JSON.stringify(payload);
}

export async function executeTool(name: string, args: unknown, ctx: ToolContext) {
  if (!isToolEnabledForTenant(name, ctx.tenant)) {
    logger.warn({ tool: name, tenantId: ctx.tenant.id }, 'tool blocked: not enabled for tenant');
    return { ok: false, error: 'This action is not enabled for this business.' };
  }

  switch (name) {
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, {
        ownerCell: ctx.tenant.ownerCell,
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
      const value = asTrimmedString(parsedArgs.value) || 'not provided';

      if (!field) {
        return { ok: false, error: 'Missing required field name.' };
      }

      ctx.onboardingFields[field] = value;
      return { ok: true, field, value, message: `Saved onboarding field: ${field}` };
    }

    case 'complete_onboarding': {
      if (!isOnboardingTenant(ctx.tenant)) {
        return { ok: false, error: 'Onboarding completion is only available for onboarding calls.' };
      }

      const summary = buildOnboardingSummary(ctx);
      await sendSms(ONBOARDING_SUMMARY_NUMBER, `Cadence onboarding summary: ${summary}`);
      return {
        ok: true,
        sentTo: ONBOARDING_SUMMARY_NUMBER,
        fieldsSaved: Object.keys(ctx.onboardingFields).length,
        message: 'Onboarding data sent successfully.'
      };
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
