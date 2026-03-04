import { closeDbPool } from '../src/db/client';
import {
  getClientById,
  getClientByOwnerEmail,
  getClientByTenantKey,
  type Client,
  type SubscriptionStatus,
} from '../src/db/queries';
import { bootstrapTenantFromBaseline } from '../src/tenants/bootstrap-orchestrator';
import { compileTenantFromBaseline } from '../src/tenants/clone-from-baseline';
import { normalizeTenantBootstrapRequest, type TenantBootstrapRequestInput } from '../src/tenants/bootstrap-contract';
import { stableStringify } from '../src/tenants/stable-hash';

const DEFAULT_AUTOM8_OWNER_EMAIL = 'aust@autom8everything.com';
const PROTECTED_DVDS_NUMBER = '+18773464394';

type Options = {
  tenantKey?: string;
  ownerEmail?: string;
  clientId?: string;
  businessDescription?: string;
  greetingOpening?: string;
  customRules: string[];
  apply: boolean;
  allowProtected: boolean;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    customRules: [],
    apply: false,
    allowProtected: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant-key') {
      options.tenantKey = asTrimmed(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--owner-email') {
      options.ownerEmail = asTrimmed(argv[i + 1]).toLowerCase();
      i += 1;
      continue;
    }
    if (arg === '--client-id') {
      options.clientId = asTrimmed(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--business-description') {
      options.businessDescription = asTrimmed(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--greeting-opening') {
      options.greetingOpening = asTrimmed(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--custom-rule') {
      const rule = asTrimmed(argv[i + 1]);
      if (rule) options.customRules.push(rule);
      i += 1;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }
    if (arg === '--allow-protected') {
      options.allowProtected = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function extractBusinessDescriptionFromPrompt(prompt: string | null | undefined): string {
  const source = asTrimmed(prompt);
  if (!source) return '';

  const match = source.match(/Business profile for .*?:\n([\s\S]*?)\n\nBusiness hours:/i);
  return match?.[1]?.trim() || '';
}

function extractCustomRulesFromPrompt(prompt: string | null | undefined): string[] {
  const source = asTrimmed(prompt);
  if (!source) return [];

  const match = source.match(/Tenant-specific script overrides \(highest priority when conflicting with baseline defaults\):\n([\s\S]*)$/i);
  if (!match?.[1]) return [];

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== 'no tenant-specific custom rules were supplied.');
}

function extractGreetingOpening(greeting: string | null | undefined): string | null {
  const source = asTrimmed(greeting);
  if (!source) return null;

  const stripped = source.replace(/\s*This is Cadence, how can I help you today\?\s*$/i, '').trim();
  return stripped || null;
}

function mergeRules(existingRules: string[], cliRules: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const rule of [...existingRules, ...cliRules]) {
    const normalized = rule.trim();
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }

  return merged;
}

async function resolveTargetClient(options: Options): Promise<Client> {
  if (options.clientId) {
    const byId = await getClientById(options.clientId);
    assert(byId, `No client found for --client-id ${options.clientId}`);
    return byId;
  }

  if (options.tenantKey) {
    const byTenantKey = await getClientByTenantKey(options.tenantKey);
    assert(byTenantKey, `No client found for --tenant-key ${options.tenantKey}`);
    return byTenantKey;
  }

  const ownerEmail = options.ownerEmail || DEFAULT_AUTOM8_OWNER_EMAIL;
  const byOwnerEmail = await getClientByOwnerEmail(ownerEmail);
  assert(byOwnerEmail, `No client found for --owner-email ${ownerEmail}`);
  return byOwnerEmail;
}

function buildRebaseRequest(target: Client, options: Options): TenantBootstrapRequestInput {
  assert(target.ownerEmail, 'Target client must have owner_email to rebase from baseline');

  const existingDescription = extractBusinessDescriptionFromPrompt(target.systemPrompt);
  const existingRules = extractCustomRulesFromPrompt(target.systemPrompt);
  const mergedRules = mergeRules(existingRules, options.customRules);

  return {
    source: 'admin_manual',
    tenantKey: options.tenantKey || target.tenantKey || undefined,
    overrides: {
      business: {
        businessName: target.businessName,
        businessDescription: options.businessDescription || existingDescription,
      },
      contact: {
        ownerName: target.ownerName,
        ownerEmail: target.ownerEmail,
        ownerPhone: target.ownerPhone,
        transferNumber: target.transferNumber,
      },
      routing: {
        areaCode: target.areaCode,
      },
      operations: {
        hours: target.hours,
        faqs: target.faqs,
      },
      script: {
        greetingOpening: options.greetingOpening || extractGreetingOpening(target.greeting),
        customBusinessRules: mergedRules,
      },
    },
  };
}

function summarizeDiff(target: Client, request: TenantBootstrapRequestInput): {
  changedFields: string[];
  preview: Record<string, unknown>;
} {
  const normalized = normalizeTenantBootstrapRequest(request);
  const compiled = compileTenantFromBaseline({
    request: normalized,
    subscriptionStatus: target.subscriptionStatus as SubscriptionStatus,
  });

  const changedFields: string[] = [];
  const check = (field: string, current: unknown, next: unknown) => {
    if (stableStringify(current) !== stableStringify(next)) {
      changedFields.push(field);
    }
  };

  check('business_name', target.businessName, compiled.businessName);
  check('owner_name', target.ownerName, compiled.ownerName);
  check('owner_phone', target.ownerPhone, compiled.ownerPhone);
  check('transfer_number', target.transferNumber, compiled.transferNumber);
  check('area_code', target.areaCode, compiled.areaCode);
  check('hours', target.hours, compiled.hours);
  check('faqs', target.faqs, compiled.faqs);
  check('greeting', target.greeting, compiled.greeting);
  check('system_prompt', target.systemPrompt, compiled.systemPrompt);
  check('tts_model', target.ttsModel, compiled.ttsModel);
  check('stt_model', target.sttModel, compiled.sttModel);
  check('llm_model', target.llmModel, compiled.llmModel);
  check('tools_allowed', target.toolsAllowed, compiled.toolsAllowed);
  check('tenant_key', target.tenantKey, compiled.tenantKey);
  check('baseline_version', target.baselineVersion, compiled.baselineVersion);
  check('baseline_hash', target.baselineHash, compiled.baselineHash);
  check('override_hash', target.overrideHash, compiled.overrideHash);

  return {
    changedFields,
    preview: {
      client_id: target.id,
      tenant_key: compiled.tenantKey,
      baseline_version: compiled.baselineVersion,
      baseline_hash: compiled.baselineHash,
      override_hash: compiled.overrideHash,
      changed_fields: changedFields,
      subscription_status: target.subscriptionStatus,
      bootstrap_state: compiled.bootstrapState,
    },
  };
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = await resolveTargetClient(options);

  if ((target.twilioNumber || '') === PROTECTED_DVDS_NUMBER && !options.allowProtected) {
    throw new Error('Refusing to rebase protected DVDS tenant without --allow-protected');
  }

  const request = buildRebaseRequest(target, options);
  const diff = summarizeDiff(target, request);

  if (!options.apply) {
    console.log('[REBASE] dry-run only (no database writes)');
    console.log(JSON.stringify(diff.preview, null, 2));
    return;
  }

  const result = await bootstrapTenantFromBaseline({
    request,
    system: {
      clientId: target.id,
      subscriptionStatus: target.subscriptionStatus,
      stripeCustomerId: target.stripeCustomerId,
      stripeSubscriptionId: target.stripeSubscriptionId,
      twilioNumber: target.twilioNumber,
      twilioNumberSid: target.twilioNumberSid,
      grandfathered: target.grandfathered,
    },
  });

  console.log('[REBASE] applied');
  console.log(JSON.stringify({
    client_id: result.client.id,
    tenant_key: result.client.tenantKey,
    baseline_version: result.client.baselineVersion,
    baseline_hash: result.client.baselineHash,
    override_hash: result.client.overrideHash,
    changed_fields: result.changedFields,
    idempotent: result.idempotent,
    updated: result.updated,
  }, null, 2));
}

run()
  .catch((error) => {
    console.error('[REBASE] failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
