import { closeDbPool } from '../src/db/client';
import { getClientById, getClientByOwnerEmail, getClientByTenantKey, type Client } from '../src/db/queries';
import { DVDS_BASELINE } from '../src/config/baselines/dvds-baseline';
import { stableStringify } from '../src/tenants/stable-hash';

const DEFAULT_AUTOM8_OWNER_EMAIL = 'aust@autom8everything.com';

type Options = {
  tenantKey?: string;
  ownerEmail?: string;
  clientId?: string;
  expectScriptContains?: string;
  expectBusinessName?: string;
};

type CheckResult = {
  name: string;
  pass: boolean;
  details?: string;
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
  const options: Options = {};

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
    if (arg === '--expect-script-contains') {
      options.expectScriptContains = asTrimmed(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--expect-business-name') {
      options.expectBusinessName = asTrimmed(argv[i + 1]);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function resolveClient(options: Options): Promise<Client> {
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

function runChecks(client: Client, options: Options): CheckResult[] {
  const checks: CheckResult[] = [];

  checks.push({
    name: 'baseline_version_matches',
    pass: client.baselineVersion === DVDS_BASELINE.baselineVersion,
    details: `expected=${DVDS_BASELINE.baselineVersion} actual=${client.baselineVersion || '<null>'}`,
  });

  checks.push({
    name: 'baseline_hash_matches',
    pass: client.baselineHash === DVDS_BASELINE.baselineHash,
    details: `expected=${DVDS_BASELINE.baselineHash} actual=${client.baselineHash || '<null>'}`,
  });

  checks.push({
    name: 'models_match_baseline',
    pass:
      client.ttsModel === DVDS_BASELINE.voiceDefaults.ttsModel
      && client.sttModel === DVDS_BASELINE.voiceDefaults.sttModel
      && client.llmModel === DVDS_BASELINE.voiceDefaults.llmModel,
    details: `tts=${client.ttsModel} stt=${client.sttModel} llm=${client.llmModel}`,
  });

  checks.push({
    name: 'tools_match_baseline',
    pass: stableStringify(client.toolsAllowed) === stableStringify([...DVDS_BASELINE.toolDefaults]),
    details: `tools=${JSON.stringify(client.toolsAllowed)}`,
  });

  checks.push({
    name: 'system_prompt_has_baseline_block',
    pass: asTrimmed(client.systemPrompt).includes('Call behavior (DVDS baseline core):'),
  });

  checks.push({
    name: 'tenant_key_present',
    pass: asTrimmed(client.tenantKey).length > 0,
    details: `tenant_key=${client.tenantKey || '<null>'}`,
  });

  if (options.expectBusinessName) {
    checks.push({
      name: 'business_name_matches_expectation',
      pass: client.businessName === options.expectBusinessName,
      details: `expected=${options.expectBusinessName} actual=${client.businessName}`,
    });
  }

  if (options.expectScriptContains) {
    checks.push({
      name: 'script_override_contains_expected_text',
      pass: asTrimmed(client.systemPrompt).toLowerCase().includes(options.expectScriptContains.toLowerCase()),
      details: `expected snippet=${options.expectScriptContains}`,
    });
  }

  return checks;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = await resolveClient(options);
  const checks = runChecks(client, options);
  const passed = checks.every((check) => check.pass);

  console.log(JSON.stringify({
    client_id: client.id,
    tenant_key: client.tenantKey,
    business_name: client.businessName,
    subscription_status: client.subscriptionStatus,
    checks,
    passed,
  }, null, 2));

  if (!passed) {
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error('[VERIFY] tenant baseline verification failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
