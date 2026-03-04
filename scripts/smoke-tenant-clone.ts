import { DVDS_BASELINE } from '../src/config/baselines/dvds-baseline';
import { compileTenantFromBaseline } from '../src/tenants/clone-from-baseline';
import { normalizeTenantBootstrapRequest } from '../src/tenants/bootstrap-contract';
import { stableStringify } from '../src/tenants/stable-hash';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function runSmoke(): void {
  const requestInput = {
    requestId: '00000000-0000-4000-8000-000000000123',
    source: 'api' as const,
    tenantKey: 'smoke-tenant-clone',
    overrides: {
      business: {
        businessName: 'Smoke Clone Co',
        businessDescription: 'We provide same-day home services with live dispatch support.',
      },
      contact: {
        ownerName: 'Smoke Owner',
        ownerEmail: 'smoke-clone@example.com',
        ownerPhone: '+16025550123',
        transferNumber: '+16025550999',
      },
      routing: {
        areaCode: '480',
      },
      operations: {
        hours: {
          mon: '9am-5pm',
          tue: '9am-5pm',
        },
        faqs: [
          { q: 'Do you offer emergency service?', a: 'Yes, 24/7 emergency dispatch is available.' },
          { q: 'Can I book over the phone?', a: 'Yes, we can help schedule while on the call.' },
        ],
      },
      script: {
        greetingOpening: 'Thanks for calling Smoke Clone Co!',
        customBusinessRules: ['Always confirm the caller city before quoting availability.'],
      },
    },
  };

  const normalizedFirst = normalizeTenantBootstrapRequest(requestInput);
  const normalizedSecond = normalizeTenantBootstrapRequest(requestInput);

  assert(
    normalizedFirst.overrideHash === normalizedSecond.overrideHash,
    'Override hash changed between identical normalization runs'
  );

  const compiledFirst = compileTenantFromBaseline({
    request: normalizedFirst,
    subscriptionStatus: 'pending',
  });
  const compiledSecond = compileTenantFromBaseline({
    request: normalizedSecond,
    subscriptionStatus: 'pending',
  });

  assert(
    stableStringify(compiledFirst) === stableStringify(compiledSecond),
    'Compiled tenant clone output changed between identical runs'
  );

  assert(compiledFirst.ttsModel === DVDS_BASELINE.voiceDefaults.ttsModel, 'TTS model did not match DVDS baseline defaults');
  assert(compiledFirst.sttModel === DVDS_BASELINE.voiceDefaults.sttModel, 'STT model did not match DVDS baseline defaults');
  assert(compiledFirst.llmModel === DVDS_BASELINE.voiceDefaults.llmModel, 'LLM model did not match DVDS baseline defaults');
  assert(
    stableStringify(compiledFirst.toolsAllowed) === stableStringify([...DVDS_BASELINE.toolDefaults]),
    'Allowed tools did not match DVDS baseline defaults'
  );

  assert(
    compiledFirst.systemPrompt.includes('Call behavior (DVDS baseline core):'),
    'System prompt did not include DVDS baseline call behavior block'
  );
  assert(
    compiledFirst.systemPrompt.includes('Always confirm the caller city before quoting availability.'),
    'System prompt did not include tenant-specific custom script override'
  );
  assert(
    compiledFirst.greeting.includes('Thanks for calling Smoke Clone Co!'),
    'Greeting override did not render correctly'
  );

  console.log('[SMOKE] tenant clone baseline smoke passed');
  console.log(JSON.stringify({
    baselineVersion: compiledFirst.baselineVersion,
    baselineHash: compiledFirst.baselineHash,
    overrideHash: compiledFirst.overrideHash,
    bootstrapState: compiledFirst.bootstrapState,
    toolsAllowed: compiledFirst.toolsAllowed,
  }, null, 2));
}

try {
  runSmoke();
} catch (error) {
  console.error('[SMOKE] tenant clone baseline smoke failed');
  console.error(error);
  process.exitCode = 1;
}
