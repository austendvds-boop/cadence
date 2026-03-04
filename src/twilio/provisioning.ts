import { normalizePhoneNumber } from '../config/tenants';
import { logger } from '../utils/logger';
import { twilioClient } from './service';

const PROVISION_VOICE_WEBHOOK_URL = 'https://cadence-m48n.onrender.com/incoming-call';
const PROTECTED_TWILIO_NUMBERS = new Set<string>(['+18773464394', '+14806313993']);
const DEFAULT_NEARBY_AREA_CODES = ['480', '602', '623', '520', '928'];

const NEARBY_AREA_CODES: Record<string, string[]> = {
  '480': ['602', '623', '520', '928'],
  '602': ['480', '623', '520', '928'],
  '623': ['602', '480', '520', '928'],
  '520': ['928', '623', '480', '602'],
  '928': ['520', '623', '602', '480'],
};

type TwilioErrorShape = {
  status?: number;
  code?: number;
  message?: string;
};

export type ProvisionNumberResult = {
  sid: string;
  phoneNumber: string;
  areaCode: string | null;
};

export type ReleaseNumberResult = {
  released: boolean;
  skipped: boolean;
  reason?: string;
  phoneNumber?: string;
};

function normalizeAreaCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length === 3 ? digits : null;
}

function extractAreaCode(phoneNumber: string): string | null {
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length === 10) {
    return digits.slice(0, 3);
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1, 4);
  }
  return null;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }

  return output;
}

function buildAreaCodePriority(preferredAreaCode: string | null | undefined): string[] {
  const preferred = normalizeAreaCode(preferredAreaCode);
  if (!preferred) {
    return [...DEFAULT_NEARBY_AREA_CODES];
  }

  const nearby = NEARBY_AREA_CODES[preferred] ?? [];
  return unique([preferred, ...nearby, ...DEFAULT_NEARBY_AREA_CODES]);
}

function asTwilioError(error: unknown): TwilioErrorShape {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const candidate = error as TwilioErrorShape;
  return {
    status: typeof candidate.status === 'number' ? candidate.status : undefined,
    code: typeof candidate.code === 'number' ? candidate.code : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
  };
}

function isTwilioNumberUnavailable(error: unknown): boolean {
  const twilioError = asTwilioError(error);
  if (twilioError.status === 400 || twilioError.status === 409) {
    return true;
  }

  return twilioError.code === 21452 || twilioError.code === 21422 || twilioError.code === 21450;
}

function isTwilioNotFound(error: unknown): boolean {
  const twilioError = asTwilioError(error);
  return twilioError.status === 404 || twilioError.code === 20404;
}

function ensureTwilioClient() {
  if (!twilioClient) {
    throw new Error('Twilio provisioning is not configured');
  }

  return twilioClient;
}

async function listAvailableLocalNumbers(areaCode: string | null): Promise<string[]> {
  const client = ensureTwilioClient();

  const options: {
    areaCode?: number;
    voiceEnabled: boolean;
    smsEnabled: boolean;
    limit: number;
  } = {
    voiceEnabled: true,
    smsEnabled: true,
    limit: 20,
  };

  if (areaCode) {
    options.areaCode = Number(areaCode);
  }

  const available = await client.availablePhoneNumbers('US').local.list(options);

  return available
    .map((number) => normalizePhoneNumber(number.phoneNumber || ''))
    .filter((phoneNumber): phoneNumber is string => Boolean(phoneNumber) && !PROTECTED_TWILIO_NUMBERS.has(phoneNumber));
}

async function purchasePhoneNumber(candidatePhoneNumber: string, attemptedAreaCode: string | null): Promise<ProvisionNumberResult> {
  const client = ensureTwilioClient();
  const purchase = await client.incomingPhoneNumbers.create({
    phoneNumber: candidatePhoneNumber,
    voiceUrl: PROVISION_VOICE_WEBHOOK_URL,
    voiceMethod: 'POST',
  });

  const normalizedPhoneNumber = normalizePhoneNumber(purchase.phoneNumber || candidatePhoneNumber) || candidatePhoneNumber;

  return {
    sid: purchase.sid,
    phoneNumber: normalizedPhoneNumber,
    areaCode: attemptedAreaCode ?? extractAreaCode(normalizedPhoneNumber),
  };
}

async function tryPurchaseForAreaCode(areaCode: string | null): Promise<ProvisionNumberResult | null> {
  const availableNumbers = await listAvailableLocalNumbers(areaCode);

  for (const phoneNumber of availableNumbers) {
    try {
      return await purchasePhoneNumber(phoneNumber, areaCode);
    } catch (error) {
      if (isTwilioNumberUnavailable(error)) {
        logger.warn({ error, phoneNumber, areaCode }, 'Twilio number became unavailable during purchase; trying next candidate');
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function provisionIncomingNumber(preferredAreaCode?: string | null): Promise<ProvisionNumberResult> {
  const areaCodePriority = buildAreaCodePriority(preferredAreaCode ?? null);

  for (const areaCode of areaCodePriority) {
    const provisioned = await tryPurchaseForAreaCode(areaCode);
    if (provisioned) {
      return provisioned;
    }
  }

  const fallbackProvisioned = await tryPurchaseForAreaCode(null);
  if (fallbackProvisioned) {
    return fallbackProvisioned;
  }

  throw new Error('No available Twilio local numbers found in the US');
}

export async function releaseNumber(twilioNumberSid: string): Promise<ReleaseNumberResult> {
  const sid = twilioNumberSid.trim();
  if (!sid) {
    throw new Error('Twilio number SID is required');
  }

  const client = ensureTwilioClient();
  let normalizedPhoneNumber: string | undefined;

  try {
    const incomingNumber = await client.incomingPhoneNumbers(sid).fetch();
    normalizedPhoneNumber = normalizePhoneNumber(incomingNumber.phoneNumber || '') || undefined;

    if (normalizedPhoneNumber && PROTECTED_TWILIO_NUMBERS.has(normalizedPhoneNumber)) {
      return {
        released: false,
        skipped: true,
        reason: 'protected_number',
        phoneNumber: normalizedPhoneNumber,
      };
    }

    await client.incomingPhoneNumbers(sid).remove();

    return {
      released: true,
      skipped: false,
      phoneNumber: normalizedPhoneNumber,
    };
  } catch (error) {
    if (isTwilioNotFound(error)) {
      return {
        released: false,
        skipped: true,
        reason: 'not_found',
        phoneNumber: normalizedPhoneNumber,
      };
    }

    throw error;
  }
}
