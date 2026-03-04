const ONBOARDING_NUMBER = '+14806313993';
const DEFAULT_CHECKOUT_BASE_URL = 'https://cadence-m48n.onrender.com';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function runSmoke(): Promise<void> {
  const checkoutBaseUrl = process.env.SMOKE_CHECKOUT_BASE_URL || process.env.BASE_URL || DEFAULT_CHECKOUT_BASE_URL;
  process.env.BASE_URL = checkoutBaseUrl;

  const [{ resolveTenantForIncomingNumber }, { getTenant }, { getEffectiveDeepgramSttConfig }, { env }, { executeTool }, { closeDbPool }] = await Promise.all([
    import('../src/config/tenant-routing'),
    import('../src/config/get-tenant'),
    import('../src/stt/deepgram'),
    import('../src/utils/env'),
    import('../src/tools/executor'),
    import('../src/db/client'),
  ]);

  const summary: Record<string, unknown> = {};

  try {
    const defaultTenant = getTenant(ONBOARDING_NUMBER);
    assert(defaultTenant, `Missing in-memory onboarding tenant for ${ONBOARDING_NUMBER}`);
    assert(defaultTenant.id === 'cadence-onboarding', `Expected cadence-onboarding defaults, got ${defaultTenant.id}`);

    const dvdsTenant = getTenant('+18773464394');
    assert(dvdsTenant, 'Missing DVDS tenant defaults');
    assert(defaultTenant.sttModel === dvdsTenant.sttModel, 'Onboarding STT model diverged from DVDS baseline');
    assert(defaultTenant.ttsModel === dvdsTenant.ttsModel, 'Onboarding TTS model diverged from DVDS baseline');

    const resolvedTenant = await resolveTenantForIncomingNumber(ONBOARDING_NUMBER);
    assert(resolvedTenant, `Tenant did not resolve for ${ONBOARDING_NUMBER}`);
    assert(asString(resolvedTenant.twilioNumber) === ONBOARDING_NUMBER, `Resolved tenant number mismatch: ${resolvedTenant.twilioNumber}`);
    assert(resolvedTenant.tools.includes('save_onboarding_field'), 'Resolved tenant missing save_onboarding_field tool');
    assert(resolvedTenant.tools.includes('complete_onboarding'), 'Resolved tenant missing complete_onboarding tool');
    summary.tenant = {
      id: resolvedTenant.id,
      twilioNumber: resolvedTenant.twilioNumber,
      tools: resolvedTenant.tools,
      ttsModel: resolvedTenant.ttsModel,
      sttModel: resolvedTenant.sttModel,
    };
    summary.parity = {
      onboardingSttModel: defaultTenant.sttModel,
      onboardingTtsModel: defaultTenant.ttsModel,
      dvdsSttModel: dvdsTenant.sttModel,
      dvdsTtsModel: dvdsTenant.ttsModel,
    };

    const effectiveSttConfig = getEffectiveDeepgramSttConfig({
      model: resolvedTenant.sttModel,
      utteranceEndMs: env.UTTERANCE_END_MS,
      endpointingMs: env.ENDPOINTING_MS,
    });

    assert(effectiveSttConfig.model.length > 0, 'Effective STT model is empty');
    assert(effectiveSttConfig.utteranceEndMs >= 1000, `UTTERANCE_END_MS clamp failed: ${effectiveSttConfig.utteranceEndMs}`);
    assert(effectiveSttConfig.endpointingMs >= 10, `ENDPOINTING_MS clamp failed: ${effectiveSttConfig.endpointingMs}`);
    summary.stt = effectiveSttConfig;

    const smokeEmail = `smoke+onboarding-${Date.now()}@autom8everything.com`;
    const checkoutResponse = await fetch(`${checkoutBaseUrl.replace(/\/$/, '')}/api/stripe/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: smokeEmail,
        businessName: 'Onboarding Smoke Test Business',
        ownerName: 'Smoke Test Owner',
        ownerPhone: '+15005550006',
        transferNumber: '+16026633502',
        areaCode: '480',
        subscriptionStatus: 'pending',
      }),
    });

    const checkoutBody = await checkoutResponse.json().catch(() => ({}));
    const checkoutUrl = asString((checkoutBody as Record<string, unknown>).url);
    assert(checkoutResponse.ok, `Checkout endpoint failed: ${checkoutResponse.status}`);
    assert(/^https?:\/\//.test(checkoutUrl), `Checkout URL missing/invalid: ${checkoutUrl || '<empty>'}`);
    summary.checkout = {
      baseUrl: checkoutBaseUrl,
      status: checkoutResponse.status,
      urlPrefix: checkoutUrl.slice(0, 40),
    };

    const onboardingResult = await executeTool('complete_onboarding', {}, {
      callSid: `SMOKE-${Date.now()}`,
      callerNumber: '+15005550006',
      tenant: resolvedTenant,
      onboardingFields: {
        business_name: 'Onboarding Smoke Test Business',
        owner_name: 'Smoke Test Owner',
        owner_email: smokeEmail,
        owner_phone: '+15005550006',
        business_description: 'We run a local service business and need a receptionist.',
        hours: 'Mon-Fri 9am-5pm',
        faqs: 'What do you charge?\nDo you offer weekend service?',
        transfer_number: '+16026633502',
        area_code: '480',
      },
    });

    assert(onboardingResult && typeof onboardingResult === 'object', 'complete_onboarding did not return an object');
    const resultRecord = onboardingResult as Record<string, unknown>;
    assert(resultRecord.ok === true, `complete_onboarding did not return success: ${JSON.stringify(resultRecord)}`);
    assert(typeof resultRecord.clientId === 'string' && resultRecord.clientId.length > 0, 'complete_onboarding missing clientId');
    assert(typeof resultRecord.checkout_url === 'string' && asString(resultRecord.checkout_url).startsWith('http'), 'complete_onboarding missing checkout_url');
    assert(typeof resultRecord.customer_message === 'string' && asString(resultRecord.customer_message).length > 0, 'complete_onboarding missing customer_message');
    assert('sms_attempted' in resultRecord, 'complete_onboarding missing sms_attempted');
    assert('sms_sent' in resultRecord, 'complete_onboarding missing sms_sent');
    summary.completeOnboarding = {
      ok: resultRecord.ok,
      clientId: resultRecord.clientId,
      smsAttempted: resultRecord.sms_attempted,
      smsSent: resultRecord.sms_sent,
      hasSmsError: Boolean(asString(resultRecord.sms_error)),
    };

    console.log('[SMOKE] onboarding checks passed');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeDbPool();
  }
}

runSmoke().catch((error) => {
  console.error('[SMOKE] onboarding checks failed');
  console.error(error);
  process.exitCode = 1;
});
