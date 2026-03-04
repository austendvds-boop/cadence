import { DVDS_BASELINE, renderDvdsCloneGreeting, renderDvdsCloneSystemPrompt } from '../config/baselines/dvds-baseline';
import type { SubscriptionStatus } from '../db/queries';
import { bootstrapStateFromSubscriptionStatus, type BootstrapState, type NormalizedTenantBootstrapRequest } from './bootstrap-contract';

export interface CompiledTenantBaselineConfig {
  tenantKey: string;
  baselineVersion: string;
  baselineHash: string;
  overrideHash: string;
  bootstrapState: BootstrapState;
  subscriptionStatus: SubscriptionStatus;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string;
  ownerPhone: string | null;
  transferNumber: string | null;
  areaCode: string | null;
  hours: Record<string, string>;
  faqs: Array<{ q: string; a: string }>;
  greeting: string;
  systemPrompt: string;
  ttsModel: string;
  sttModel: string;
  llmModel: string;
  toolsAllowed: string[];
}

function assertSupportedBaselineVersion(version: string): void {
  if (version !== DVDS_BASELINE.baselineVersion) {
    throw new Error(`Unsupported baseline version: ${version}. Expected ${DVDS_BASELINE.baselineVersion}`);
  }
}

export function compileTenantFromBaseline(input: {
  request: NormalizedTenantBootstrapRequest;
  subscriptionStatus: SubscriptionStatus;
}): CompiledTenantBaselineConfig {
  assertSupportedBaselineVersion(input.request.baselineVersion);

  const { overrides } = input.request;

  const greeting = renderDvdsCloneGreeting({
    businessName: overrides.business.businessName,
    businessDescription: overrides.business.businessDescription,
    hours: overrides.operations.hours,
    faqs: overrides.operations.faqs,
    greetingOpening: overrides.script.greetingOpening,
    customBusinessRules: overrides.script.customBusinessRules,
  });

  const systemPrompt = renderDvdsCloneSystemPrompt({
    businessName: overrides.business.businessName,
    businessDescription: overrides.business.businessDescription,
    hours: overrides.operations.hours,
    faqs: overrides.operations.faqs,
    greetingOpening: overrides.script.greetingOpening,
    customBusinessRules: overrides.script.customBusinessRules,
  });

  return {
    tenantKey: input.request.tenantKey,
    baselineVersion: input.request.baselineVersion,
    baselineHash: DVDS_BASELINE.baselineHash,
    overrideHash: input.request.overrideHash,
    bootstrapState: bootstrapStateFromSubscriptionStatus(input.subscriptionStatus),
    subscriptionStatus: input.subscriptionStatus,
    businessName: overrides.business.businessName,
    ownerName: overrides.contact.ownerName,
    ownerEmail: overrides.contact.ownerEmail,
    ownerPhone: overrides.contact.ownerPhone,
    transferNumber: overrides.contact.transferNumber,
    areaCode: overrides.routing.areaCode,
    hours: overrides.operations.hours,
    faqs: overrides.operations.faqs,
    greeting,
    systemPrompt,
    ttsModel: DVDS_BASELINE.voiceDefaults.ttsModel,
    sttModel: DVDS_BASELINE.voiceDefaults.sttModel,
    llmModel: DVDS_BASELINE.voiceDefaults.llmModel,
    toolsAllowed: [...DVDS_BASELINE.toolDefaults],
  };
}
