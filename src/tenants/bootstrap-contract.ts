import { randomUUID } from 'crypto';
import { z } from 'zod';
import { DVDS_BASELINE_VERSION } from '../config/baselines/dvds-baseline';
import { normalizePhoneNumber } from '../config/tenants';
import type { ClientFaq, ClientHours, SubscriptionStatus } from '../db/queries';
import { stableHash } from './stable-hash';

export type TenantBootstrapSource = 'onboarding_voice' | 'admin_manual' | 'api';

export type BootstrapState = 'draft' | 'pending_checkout' | 'checkout_created' | 'active' | 'failed';

export interface TenantBootstrapOverrides {
  business: {
    businessName: string;
    businessDescription: string;
  };
  contact: {
    ownerName: string | null;
    ownerEmail: string;
    ownerPhone: string | null;
    transferNumber: string | null;
  };
  routing: {
    areaCode: string | null;
  };
  operations: {
    hours: ClientHours;
    faqs: ClientFaq[];
  };
  script: {
    greetingOpening: string | null;
    customBusinessRules: string[];
  };
}

export interface TenantBootstrapRequestInput {
  requestId?: string;
  source: TenantBootstrapSource;
  tenantKey?: string;
  baselineVersion?: string;
  overrides: {
    business: {
      businessName: string;
      businessDescription?: string | null;
    };
    contact: {
      ownerName?: string | null;
      ownerEmail: string;
      ownerPhone?: string | null;
      transferNumber?: string | null;
    };
    routing?: {
      areaCode?: string | null;
    };
    operations?: {
      hours?: Record<string, string> | null;
      faqs?: Array<{ q: string; a?: string }> | null;
    };
    script?: {
      greetingOpening?: string | null;
      customBusinessRules?: string[] | null;
    };
  };
}

export interface NormalizedTenantBootstrapRequest {
  requestId: string;
  source: TenantBootstrapSource;
  tenantKey: string;
  baselineVersion: string;
  overrides: TenantBootstrapOverrides;
  overrideHash: string;
}

const TenantBootstrapInputSchema = z.object({
  requestId: z.string().uuid().optional(),
  source: z.enum(['onboarding_voice', 'admin_manual', 'api']),
  tenantKey: z.string().trim().optional(),
  baselineVersion: z.string().trim().min(1).optional(),
  overrides: z.object({
    business: z.object({
      businessName: z.string().trim().min(1).max(200),
      businessDescription: z.string().trim().max(4000).optional().nullable(),
    }).strict(),
    contact: z.object({
      ownerName: z.string().trim().max(200).optional().nullable(),
      ownerEmail: z.string().trim().email(),
      ownerPhone: z.string().trim().max(40).optional().nullable(),
      transferNumber: z.string().trim().max(40).optional().nullable(),
    }).strict(),
    routing: z.object({
      areaCode: z.string().trim().max(10).optional().nullable(),
    }).strict().optional(),
    operations: z.object({
      hours: z.record(z.string(), z.string()).optional().nullable(),
      faqs: z.array(z.object({
        q: z.string().trim().min(1).max(500),
        a: z.string().trim().max(2000).optional(),
      }).strict()).max(50).optional().nullable(),
    }).strict().optional(),
    script: z.object({
      greetingOpening: z.string().trim().max(240).optional().nullable(),
      customBusinessRules: z.array(z.string().trim().min(1).max(500)).max(20).optional().nullable(),
    }).strict().optional(),
  }).strict(),
}).strict();

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sanitizeTenantKey(value: string): string {
  const slug = slugify(value);
  if (!slug) return '';
  return slug.slice(0, 120);
}

function normalizeOptionalPhone(raw: string | null | undefined, label: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;

  const normalized = normalizePhoneNumber(trimmed);
  if (!normalized) {
    throw new Error(`${label} must be a valid E.164 or US 10-digit phone number`);
  }

  return normalized;
}

function normalizeAreaCode(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length !== 3) {
    throw new Error('areaCode must be a 3-digit area code');
  }

  return digits;
}

function normalizeHours(hours: Record<string, string> | null | undefined): ClientHours {
  if (!hours || typeof hours !== 'object') return {};

  const normalized: ClientHours = {};
  for (const key of Object.keys(hours).sort((a, b) => a.localeCompare(b))) {
    const value = typeof hours[key] === 'string' ? hours[key].trim() : '';
    if (!value) continue;
    normalized[key.trim()] = value;
  }

  return normalized;
}

function normalizeFaqs(faqs: Array<{ q: string; a?: string }> | null | undefined): ClientFaq[] {
  if (!Array.isArray(faqs)) return [];

  return faqs
    .map((faq) => ({
      q: faq.q.trim(),
      a: (faq.a || '').trim(),
    }))
    .filter((faq) => faq.q.length > 0);
}

function normalizeCustomRules(rules: string[] | null | undefined): string[] {
  if (!Array.isArray(rules)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawRule of rules) {
    const rule = rawRule.trim();
    if (!rule) continue;
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(rule);
  }

  return normalized;
}

function deriveTenantKey(input: {
  tenantKey?: string;
  businessName: string;
  ownerEmail: string;
}): string {
  const explicit = sanitizeTenantKey(input.tenantKey || '');
  if (explicit) return explicit;

  const emailLocal = sanitizeTenantKey(input.ownerEmail.split('@')[0] || '');
  const business = sanitizeTenantKey(input.businessName);
  const fallback = sanitizeTenantKey([business, emailLocal].filter(Boolean).join('-'));

  return fallback || `tenant-${randomUUID().slice(0, 8)}`;
}

export function bootstrapStateFromSubscriptionStatus(status: SubscriptionStatus): BootstrapState {
  switch (status) {
    case 'pending':
      return 'pending_checkout';
    case 'trial':
      return 'checkout_created';
    case 'active':
      return 'active';
    case 'past_due':
    case 'canceled':
      return 'failed';
    default:
      return 'draft';
  }
}

export function normalizeTenantBootstrapRequest(input: TenantBootstrapRequestInput): NormalizedTenantBootstrapRequest {
  const parsed = TenantBootstrapInputSchema.parse(input);

  const businessName = parsed.overrides.business.businessName.trim();
  const ownerEmail = parsed.overrides.contact.ownerEmail.trim().toLowerCase();

  const overrides: TenantBootstrapOverrides = {
    business: {
      businessName,
      businessDescription: (parsed.overrides.business.businessDescription || '').trim(),
    },
    contact: {
      ownerName: (parsed.overrides.contact.ownerName || '').trim() || null,
      ownerEmail,
      ownerPhone: normalizeOptionalPhone(parsed.overrides.contact.ownerPhone, 'ownerPhone'),
      transferNumber: normalizeOptionalPhone(parsed.overrides.contact.transferNumber, 'transferNumber'),
    },
    routing: {
      areaCode: normalizeAreaCode(parsed.overrides.routing?.areaCode),
    },
    operations: {
      hours: normalizeHours(parsed.overrides.operations?.hours || undefined),
      faqs: normalizeFaqs(parsed.overrides.operations?.faqs || undefined),
    },
    script: {
      greetingOpening: (parsed.overrides.script?.greetingOpening || '').trim() || null,
      customBusinessRules: normalizeCustomRules(parsed.overrides.script?.customBusinessRules || undefined),
    },
  };

  const tenantKey = deriveTenantKey({
    tenantKey: parsed.tenantKey,
    businessName: overrides.business.businessName,
    ownerEmail: overrides.contact.ownerEmail,
  });

  return {
    requestId: parsed.requestId || randomUUID(),
    source: parsed.source,
    tenantKey,
    baselineVersion: parsed.baselineVersion || DVDS_BASELINE_VERSION,
    overrides,
    overrideHash: stableHash(overrides),
  };
}
