import 'dotenv/config';

const ONBOARDING_NUMBER = '+14806313993';
const ONBOARDING_SUMMARY_SMS_TO = (process.env.ONBOARDING_SUMMARY_SMS_TO || '+16026633503').trim();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function runSmoke(): Promise<void> {
  const [{ resolveTenantForIncomingNumber }, { executeTool }, { closeDbPool }] = await Promise.all([
    import('../src/config/tenant-routing'),
    import('../src/tools/executor'),
    import('../src/db/client'),
  ]);

  const summary: Record<string, unknown> = {};

  try {
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

    const onboardingFields: Record<string, string> = {};
    const callSid = `SMOKE-${Date.now()}`;

    const seedFields: Array<[string, string]> = [
      ['business_name', 'Onboarding Smoke Test Business'],
      ['business_type', 'Residential cleaning service'],
      ['business_hours', 'Mon-Fri 8am-6pm'],
      ['services_and_pricing', 'Standard clean $120, deep clean $240'],
      ['faqs', 'Do you bring supplies? How far do you travel?'],
      ['call_handling', 'Take messages after hours and transfer urgent calls to owner'],
      ['contact_email', `smoke+onboarding-${Date.now()}@autom8everything.com`],
    ];

    for (const [field, value] of seedFields) {
      const saveResult = await executeTool('save_onboarding_field', { field, value }, {
        callSid,
        callerNumber: '+15005550006',
        tenant: resolvedTenant,
        onboardingFields,
      });

      const saveRecord = saveResult as Record<string, unknown>;
      assert(saveRecord.ok === true, `save_onboarding_field failed for ${field}: ${JSON.stringify(saveResult)}`);
      assert(onboardingFields[field] === value, `onboarding field did not persist for ${field}`);
    }

    const onboardingResult = await executeTool('complete_onboarding', {}, {
      callSid,
      callerNumber: '+15005550006',
      tenant: resolvedTenant,
      onboardingFields,
    });

    assert(onboardingResult && typeof onboardingResult === 'object', 'complete_onboarding did not return an object');
    const resultRecord = onboardingResult as Record<string, unknown>;
    assert(resultRecord.ok === true, `complete_onboarding did not return success: ${JSON.stringify(resultRecord)}`);
    assert(resultRecord.summary_sms_sent === true, `complete_onboarding summary SMS failed: ${JSON.stringify(resultRecord)}`);
    assert(asString(resultRecord.summary_sms_to) === ONBOARDING_SUMMARY_SMS_TO, `Unexpected summary_sms_to: ${resultRecord.summary_sms_to}`);
    assert(typeof resultRecord.customer_message === 'string' && asString(resultRecord.customer_message).length > 0, 'complete_onboarding missing customer_message');

    summary.completeOnboarding = {
      ok: resultRecord.ok,
      summarySmsSent: resultRecord.summary_sms_sent,
      summarySmsTo: resultRecord.summary_sms_to,
      customerMessage: resultRecord.customer_message,
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
