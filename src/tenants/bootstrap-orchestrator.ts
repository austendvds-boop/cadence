import {
  createClient,
  getClientById,
  getClientByOwnerEmail,
  getClientByTenantKey,
  updateClient,
  type Client,
  type SubscriptionStatus,
  type UpdateClientInput,
} from '../db/queries';
import { logger } from '../utils/logger';
import { compileTenantFromBaseline, type CompiledTenantBaselineConfig } from './clone-from-baseline';
import {
  normalizeTenantBootstrapRequest,
  type BootstrapState,
  type NormalizedTenantBootstrapRequest,
  type TenantBootstrapRequestInput,
} from './bootstrap-contract';
import { stableStringify } from './stable-hash';

export interface TenantBootstrapSystemOverrides {
  clientId?: string;
  subscriptionStatus?: SubscriptionStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  twilioNumber?: string | null;
  twilioNumberSid?: string | null;
  grandfathered?: boolean;
  bootstrapState?: BootstrapState;
}

export interface BootstrapTenantFromBaselineInput {
  request: TenantBootstrapRequestInput;
  system?: TenantBootstrapSystemOverrides;
}

export interface BootstrapTenantFromBaselineResult {
  client: Client;
  normalizedRequest: NormalizedTenantBootstrapRequest;
  compiled: CompiledTenantBaselineConfig;
  created: boolean;
  updated: boolean;
  idempotent: boolean;
  changedFields: string[];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function pushIfChanged(changedFields: string[], field: string, current: unknown, next: unknown): void {
  if (!valuesEqual(current, next)) {
    changedFields.push(field);
  }
}

function setIfDefined<T extends keyof UpdateClientInput>(
  update: UpdateClientInput,
  key: T,
  value: UpdateClientInput[T] | undefined
): void {
  if (value !== undefined) {
    update[key] = value;
  }
}

async function findExistingClient(system: TenantBootstrapSystemOverrides, normalized: NormalizedTenantBootstrapRequest): Promise<Client | null> {
  if (system.clientId) {
    const byId = await getClientById(system.clientId);
    if (byId) return byId;
  }

  const byTenantKey = await getClientByTenantKey(normalized.tenantKey);
  if (byTenantKey) return byTenantKey;

  return getClientByOwnerEmail(normalized.overrides.contact.ownerEmail);
}

function resolveTargetStatus(system: TenantBootstrapSystemOverrides, existing: Client | null): SubscriptionStatus {
  if (system.subscriptionStatus) {
    return system.subscriptionStatus;
  }

  if (existing?.subscriptionStatus) {
    return existing.subscriptionStatus;
  }

  return 'pending';
}

function buildBaseUpdatePayload(
  compiled: CompiledTenantBaselineConfig,
  system: TenantBootstrapSystemOverrides
): UpdateClientInput {
  const update: UpdateClientInput = {
    businessName: compiled.businessName,
    ownerName: compiled.ownerName,
    ownerEmail: compiled.ownerEmail,
    ownerPhone: compiled.ownerPhone,
    transferNumber: compiled.transferNumber,
    areaCode: compiled.areaCode,
    hours: compiled.hours,
    faqs: compiled.faqs,
    greeting: compiled.greeting,
    systemPrompt: compiled.systemPrompt,
    ttsModel: compiled.ttsModel,
    sttModel: compiled.sttModel,
    llmModel: compiled.llmModel,
    toolsAllowed: [...compiled.toolsAllowed],
    subscriptionStatus: compiled.subscriptionStatus,
    tenantKey: compiled.tenantKey,
    baselineVersion: compiled.baselineVersion,
    baselineHash: compiled.baselineHash,
    overrideHash: compiled.overrideHash,
    bootstrapState: system.bootstrapState || compiled.bootstrapState,
  };

  setIfDefined(update, 'stripeCustomerId', system.stripeCustomerId);
  setIfDefined(update, 'stripeSubscriptionId', system.stripeSubscriptionId);
  setIfDefined(update, 'twilioNumber', system.twilioNumber);
  setIfDefined(update, 'twilioNumberSid', system.twilioNumberSid);
  setIfDefined(update, 'grandfathered', system.grandfathered);

  return update;
}

function diffClientAgainstUpdate(existing: Client, update: UpdateClientInput): string[] {
  const changedFields: string[] = [];

  pushIfChanged(changedFields, 'businessName', existing.businessName, update.businessName);
  pushIfChanged(changedFields, 'ownerName', existing.ownerName, update.ownerName);
  pushIfChanged(changedFields, 'ownerEmail', existing.ownerEmail, update.ownerEmail);
  pushIfChanged(changedFields, 'ownerPhone', existing.ownerPhone, update.ownerPhone);
  pushIfChanged(changedFields, 'transferNumber', existing.transferNumber, update.transferNumber);
  pushIfChanged(changedFields, 'areaCode', existing.areaCode, update.areaCode);
  pushIfChanged(changedFields, 'hours', existing.hours, update.hours);
  pushIfChanged(changedFields, 'faqs', existing.faqs, update.faqs);
  pushIfChanged(changedFields, 'greeting', existing.greeting, update.greeting);
  pushIfChanged(changedFields, 'systemPrompt', existing.systemPrompt, update.systemPrompt);
  pushIfChanged(changedFields, 'subscriptionStatus', existing.subscriptionStatus, update.subscriptionStatus);
  pushIfChanged(changedFields, 'ttsModel', existing.ttsModel, update.ttsModel);
  pushIfChanged(changedFields, 'sttModel', existing.sttModel, update.sttModel);
  pushIfChanged(changedFields, 'llmModel', existing.llmModel, update.llmModel);
  pushIfChanged(changedFields, 'toolsAllowed', existing.toolsAllowed, update.toolsAllowed);
  pushIfChanged(changedFields, 'tenantKey', existing.tenantKey, update.tenantKey);
  pushIfChanged(changedFields, 'baselineVersion', existing.baselineVersion, update.baselineVersion);
  pushIfChanged(changedFields, 'baselineHash', existing.baselineHash, update.baselineHash);
  pushIfChanged(changedFields, 'overrideHash', existing.overrideHash, update.overrideHash);
  pushIfChanged(changedFields, 'bootstrapState', existing.bootstrapState, update.bootstrapState);

  if (update.stripeCustomerId !== undefined) {
    pushIfChanged(changedFields, 'stripeCustomerId', existing.stripeCustomerId, update.stripeCustomerId);
  }
  if (update.stripeSubscriptionId !== undefined) {
    pushIfChanged(changedFields, 'stripeSubscriptionId', existing.stripeSubscriptionId, update.stripeSubscriptionId);
  }
  if (update.twilioNumber !== undefined) {
    pushIfChanged(changedFields, 'twilioNumber', existing.twilioNumber, update.twilioNumber);
  }
  if (update.twilioNumberSid !== undefined) {
    pushIfChanged(changedFields, 'twilioNumberSid', existing.twilioNumberSid, update.twilioNumberSid);
  }
  if (update.grandfathered !== undefined) {
    pushIfChanged(changedFields, 'grandfathered', existing.grandfathered, update.grandfathered);
  }

  return changedFields;
}

export async function bootstrapTenantFromBaseline(input: BootstrapTenantFromBaselineInput): Promise<BootstrapTenantFromBaselineResult> {
  const normalizedRequest = normalizeTenantBootstrapRequest(input.request);
  const system = input.system || {};
  const existing = await findExistingClient(system, normalizedRequest);
  const subscriptionStatus = resolveTargetStatus(system, existing);
  const compiled = compileTenantFromBaseline({
    request: normalizedRequest,
    subscriptionStatus,
  });

  const updatePayload = buildBaseUpdatePayload(compiled, system);

  if (existing) {
    const changedFields = diffClientAgainstUpdate(existing, updatePayload);
    if (changedFields.length === 0) {
      logger.info(
        {
          requestId: normalizedRequest.requestId,
          source: normalizedRequest.source,
          tenantKey: normalizedRequest.tenantKey,
          clientId: existing.id,
        },
        'Tenant bootstrap no-op (idempotent)'
      );

      return {
        client: existing,
        normalizedRequest,
        compiled,
        created: false,
        updated: false,
        idempotent: true,
        changedFields,
      };
    }

    const updated = await updateClient(existing.id, updatePayload);
    if (!updated) {
      throw new Error(`Failed to update client ${existing.id} during tenant bootstrap`);
    }

    logger.info(
      {
        requestId: normalizedRequest.requestId,
        source: normalizedRequest.source,
        tenantKey: normalizedRequest.tenantKey,
        clientId: updated.id,
        changedFields,
      },
      'Tenant bootstrap updated existing client'
    );

    return {
      client: updated,
      normalizedRequest,
      compiled,
      created: false,
      updated: true,
      idempotent: false,
      changedFields,
    };
  }

  const created = await createClient({
    businessName: compiled.businessName,
    ownerName: compiled.ownerName,
    ownerEmail: compiled.ownerEmail,
    ownerPhone: compiled.ownerPhone,
    transferNumber: compiled.transferNumber,
    areaCode: compiled.areaCode,
    hours: compiled.hours,
    faqs: compiled.faqs,
    greeting: compiled.greeting,
    systemPrompt: compiled.systemPrompt,
    twilioNumber: system.twilioNumber ?? null,
    twilioNumberSid: system.twilioNumberSid ?? null,
    stripeCustomerId: system.stripeCustomerId ?? null,
    stripeSubscriptionId: system.stripeSubscriptionId ?? null,
    subscriptionStatus: compiled.subscriptionStatus,
    grandfathered: system.grandfathered ?? false,
    ttsModel: compiled.ttsModel,
    sttModel: compiled.sttModel,
    llmModel: compiled.llmModel,
    toolsAllowed: [...compiled.toolsAllowed],
    tenantKey: compiled.tenantKey,
    baselineVersion: compiled.baselineVersion,
    baselineHash: compiled.baselineHash,
    overrideHash: compiled.overrideHash,
    bootstrapState: system.bootstrapState || compiled.bootstrapState,
  });

  logger.info(
    {
      requestId: normalizedRequest.requestId,
      source: normalizedRequest.source,
      tenantKey: normalizedRequest.tenantKey,
      clientId: created.id,
    },
    'Tenant bootstrap created new client'
  );

  return {
    client: created,
    normalizedRequest,
    compiled,
    created: true,
    updated: false,
    idempotent: false,
    changedFields: ['create'],
  };
}
