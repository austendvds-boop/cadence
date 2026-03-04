import type { ClientFaq, ClientHours } from '../../db/queries';
import { env } from '../../utils/env';
import { stableHash } from '../../tenants/stable-hash';

const FALLBACK_BASELINE_VERSION = 'dvds-v2026-03-04';

export const DVDS_BASELINE_VERSION = (env.BASELINE_VERSION_CURRENT || FALLBACK_BASELINE_VERSION).trim() || FALLBACK_BASELINE_VERSION;

const DVDS_BEHAVIOR_CORE = {
  persona: 'You are Cadence, the AI receptionist for {{BUSINESS_NAME}}.',
  styleRules: [
    'You are professional, warm, and concise.',
    'This is a phone call: keep every spoken response to one or two short sentences.',
    'Never speak in bullet points, numbered lists, or markdown.',
    'Always end with an open question or clear call to action.',
  ],
  toolRules: [
    'Use send_sms when the caller asks to be texted any link or information.',
    'Use transfer_to_human only when the caller explicitly asks for a person or callback.',
    'Never transfer a caller just to send a text message.',
  ],
  safetyRules: [
    'If information is missing, acknowledge uncertainty and offer a human follow-up.',
    'Do not invent pricing, policies, or business facts that are not in the tenant profile.',
  ],
};

const DVDS_VOICE_DEFAULTS = {
  ttsModel: 'aura-2-thalia-en',
  sttModel: 'nova-2',
  llmModel: 'gpt-4o-mini',
};

const DVDS_TOOL_DEFAULTS = ['send_sms', 'transfer_to_human'] as const;

const DVDS_BASELINE_PAYLOAD = {
  baselineVersion: DVDS_BASELINE_VERSION,
  behaviorCore: DVDS_BEHAVIOR_CORE,
  voiceDefaults: DVDS_VOICE_DEFAULTS,
  toolDefaults: DVDS_TOOL_DEFAULTS,
  greetingTemplate: 'Hi, thanks for calling {{BUSINESS_NAME}}! This is Cadence, how can I help you today?',
};

export const DVDS_BASELINE = {
  ...DVDS_BASELINE_PAYLOAD,
  baselineHash: stableHash(DVDS_BASELINE_PAYLOAD),
};

export type BaselineRenderInput = {
  businessName: string;
  businessDescription: string;
  hours: ClientHours;
  faqs: ClientFaq[];
  greetingOpening: string | null;
  customBusinessRules: string[];
};

const DAY_ORDER = ['mon', 'monday', 'tue', 'tuesday', 'wed', 'wednesday', 'thu', 'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday'];

function compareDayKeys(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  const aIndex = DAY_ORDER.indexOf(aLower);
  const bIndex = DAY_ORDER.indexOf(bLower);

  if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
  if (aIndex >= 0) return -1;
  if (bIndex >= 0) return 1;
  return aLower.localeCompare(bLower);
}

function formatHours(hours: ClientHours): string {
  const entries = Object.entries(hours)
    .map(([day, value]) => ({ day: day.trim(), value: value.trim() }))
    .filter((entry) => entry.day.length > 0 && entry.value.length > 0)
    .sort((a, b) => compareDayKeys(a.day, b.day));

  if (entries.length === 0) {
    return 'Hours not provided yet.';
  }

  return entries.map((entry) => `${entry.day}: ${entry.value}`).join('\n');
}

function formatFaqs(faqs: ClientFaq[]): string {
  if (!faqs.length) {
    return 'No FAQs provided yet.';
  }

  return faqs
    .slice(0, 12)
    .map((faq) => {
      const answer = faq.a.trim();
      return answer ? `Q: ${faq.q.trim()}\nA: ${answer}` : `Q: ${faq.q.trim()}`;
    })
    .join('\n\n');
}

function formatCustomRules(rules: string[]): string {
  if (!rules.length) {
    return 'No tenant-specific custom rules were supplied.';
  }

  return rules.map((rule) => `- ${rule}`).join('\n');
}

export function renderDvdsCloneGreeting(input: BaselineRenderInput): string {
  const opening = input.greetingOpening?.trim();
  if (opening) {
    return `${opening} This is Cadence, how can I help you today?`;
  }

  return DVDS_BASELINE.greetingTemplate.replace('{{BUSINESS_NAME}}', input.businessName);
}

export function renderDvdsCloneSystemPrompt(input: BaselineRenderInput): string {
  const businessDescription = input.businessDescription.trim() || `${input.businessName} is using Cadence as an AI receptionist.`;

  return [
    `You are Cadence, the AI receptionist for ${input.businessName}.`,
    '',
    'Call behavior (DVDS baseline core):',
    ...DVDS_BASELINE.behaviorCore.styleRules.map((rule) => `- ${rule}`),
    '',
    'Tool behavior (DVDS baseline core):',
    ...DVDS_BASELINE.behaviorCore.toolRules.map((rule) => `- ${rule}`),
    '',
    'Safety behavior (DVDS baseline core):',
    ...DVDS_BASELINE.behaviorCore.safetyRules.map((rule) => `- ${rule}`),
    '',
    `Business profile for ${input.businessName}:`,
    businessDescription,
    '',
    'Business hours:',
    formatHours(input.hours),
    '',
    'Frequently asked questions:',
    formatFaqs(input.faqs),
    '',
    'Tenant-specific script overrides (highest priority when conflicting with baseline defaults):',
    formatCustomRules(input.customBusinessRules),
  ].join('\n');
}
