import type { QueryResultRow } from 'pg';
import { dbQuery } from './client';

export type SubscriptionStatus = 'pending' | 'trial' | 'active' | 'past_due' | 'canceled';
export type BootstrapState = 'draft' | 'pending_checkout' | 'checkout_created' | 'active' | 'failed';
export type ClientStatusFilter = SubscriptionStatus | 'all';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ClientHours = Record<string, string>;
export type ClientFaq = { q: string; a: string };

export interface Client {
  id: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string;
  ownerPhone: string | null;
  transferNumber: string | null;
  areaCode: string | null;
  hours: ClientHours;
  faqs: ClientFaq[];
  greeting: string | null;
  systemPrompt: string | null;
  twilioNumber: string | null;
  twilioNumberSid: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
  grandfathered: boolean;
  ttsModel: string;
  sttModel: string;
  llmModel: string;
  toolsAllowed: string[];
  tenantKey: string | null;
  baselineVersion: string | null;
  baselineHash: string | null;
  overrideHash: string | null;
  bootstrapState: BootstrapState;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateClientInput {
  businessName: string;
  ownerEmail: string;
  ownerName?: string | null;
  ownerPhone?: string | null;
  transferNumber?: string | null;
  areaCode?: string | null;
  hours?: ClientHours | null;
  faqs?: ClientFaq[] | null;
  greeting?: string | null;
  systemPrompt?: string | null;
  twilioNumber?: string | null;
  twilioNumberSid?: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  grandfathered?: boolean;
  ttsModel?: string;
  sttModel?: string;
  llmModel?: string;
  toolsAllowed?: string[];
  tenantKey?: string | null;
  baselineVersion?: string | null;
  baselineHash?: string | null;
  overrideHash?: string | null;
  bootstrapState?: BootstrapState;
}

export interface UpdateClientInput {
  businessName?: string;
  ownerName?: string | null;
  ownerEmail?: string;
  ownerPhone?: string | null;
  transferNumber?: string | null;
  areaCode?: string | null;
  hours?: ClientHours;
  faqs?: ClientFaq[];
  greeting?: string | null;
  systemPrompt?: string | null;
  twilioNumber?: string | null;
  twilioNumberSid?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  grandfathered?: boolean;
  ttsModel?: string;
  sttModel?: string;
  llmModel?: string;
  toolsAllowed?: string[];
  tenantKey?: string | null;
  baselineVersion?: string | null;
  baselineHash?: string | null;
  overrideHash?: string | null;
  bootstrapState?: BootstrapState;
}

export interface CallLog {
  id: number;
  clientId: string;
  callSid: string;
  callerNumber: string | null;
  durationSeconds: number | null;
  transcriptSummary: string | null;
  toolCalls: JsonValue | null;
  createdAt: Date;
}

export interface LogCallInput {
  clientId: string;
  callSid: string;
  callerNumber?: string | null;
  durationSeconds?: number | null;
  transcriptSummary?: string | null;
  toolCalls?: JsonValue | null;
}

export interface GetCallLogsOptions {
  limit?: number;
  offset?: number;
}

export interface ClientSubscription {
  clientId: string;
  status: string;
  trialStart: Date | null;
  trialEnd: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  updatedAt: Date;
}

export interface ClientStats {
  totalClients: number;
  pendingClients: number;
  activeClients: number;
  trialClients: number;
  pastDueClients: number;
  canceledClients: number;
  churnedClients: number;
  totalCallsToday: number;
}

interface ClientRow extends QueryResultRow {
  id: string;
  business_name: string;
  owner_name: string | null;
  owner_email: string;
  owner_phone: string | null;
  transfer_number: string | null;
  area_code: string | null;
  hours: unknown;
  faqs: unknown;
  greeting: string | null;
  system_prompt: string | null;
  twilio_number: string | null;
  twilio_number_sid: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  grandfathered: boolean;
  tts_model: string;
  stt_model: string;
  llm_model: string;
  tools_allowed: unknown;
  tenant_key: string | null;
  baseline_version: string | null;
  baseline_hash: string | null;
  override_hash: string | null;
  bootstrap_state: BootstrapState;
  created_at: Date;
  updated_at: Date;
}

interface CallLogRow extends QueryResultRow {
  id: number;
  client_id: string;
  call_sid: string;
  caller_number: string | null;
  duration_seconds: number | null;
  transcript_summary: string | null;
  tool_calls: unknown;
  created_at: Date;
}

interface ClientSubscriptionRow extends QueryResultRow {
  client_id: string;
  status: string;
  trial_start: Date | null;
  trial_end: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  updated_at: Date;
}

interface ClientStatsRow extends QueryResultRow {
  total_clients: number;
  pending_clients: number;
  active_clients: number;
  trial_clients: number;
  past_due_clients: number;
  canceled_clients: number;
  churned_clients: number;
  total_calls_today: number;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asHours(value: unknown): ClientHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const output: ClientHours = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      output[key] = raw;
    }
  }
  return output;
}

function asFaqs(value: unknown): ClientFaq[] {
  if (!Array.isArray(value)) return [];

  const output: ClientFaq[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const q = (item as Record<string, unknown>).q;
    const a = (item as Record<string, unknown>).a;
    if (typeof q === 'string' && typeof a === 'string') {
      output.push({ q, a });
    }
  }
  return output;
}

function mapClientRow(row: ClientRow): Client {
  return {
    id: row.id,
    businessName: row.business_name,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    ownerPhone: row.owner_phone,
    transferNumber: row.transfer_number,
    areaCode: row.area_code,
    hours: asHours(row.hours),
    faqs: asFaqs(row.faqs),
    greeting: row.greeting,
    systemPrompt: row.system_prompt,
    twilioNumber: row.twilio_number,
    twilioNumberSid: row.twilio_number_sid,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    grandfathered: row.grandfathered,
    ttsModel: row.tts_model,
    sttModel: row.stt_model,
    llmModel: row.llm_model,
    toolsAllowed: asStringArray(row.tools_allowed),
    tenantKey: row.tenant_key,
    baselineVersion: row.baseline_version,
    baselineHash: row.baseline_hash,
    overrideHash: row.override_hash,
    bootstrapState: row.bootstrap_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCallLogRow(row: CallLogRow): CallLog {
  return {
    id: row.id,
    clientId: row.client_id,
    callSid: row.call_sid,
    callerNumber: row.caller_number,
    durationSeconds: row.duration_seconds,
    transcriptSummary: row.transcript_summary,
    toolCalls: (row.tool_calls ?? null) as JsonValue | null,
    createdAt: row.created_at,
  };
}

function mapClientSubscriptionRow(row: ClientSubscriptionRow): ClientSubscription {
  return {
    clientId: row.client_id,
    status: row.status,
    trialStart: row.trial_start,
    trialEnd: row.trial_end,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    updatedAt: row.updated_at,
  };
}

function asNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asSubscriptionStatus(value: unknown): SubscriptionStatus | undefined {
  if (value !== 'pending' && value !== 'trial' && value !== 'active' && value !== 'past_due' && value !== 'canceled') {
    return undefined;
  }
  return value;
}

function mapClientStatsRow(row: ClientStatsRow): ClientStats {
  return {
    totalClients: asNumber(row.total_clients),
    pendingClients: asNumber(row.pending_clients),
    activeClients: asNumber(row.active_clients),
    trialClients: asNumber(row.trial_clients),
    pastDueClients: asNumber(row.past_due_clients),
    canceledClients: asNumber(row.canceled_clients),
    churnedClients: asNumber(row.churned_clients),
    totalCallsToday: asNumber(row.total_calls_today),
  };
}

export async function getClientByTwilioNumber(twilioNumber: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      SELECT *
      FROM clients
      WHERE twilio_number = $1
      LIMIT 1
    `,
    [twilioNumber]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function getClientByOwnerEmail(ownerEmail: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      SELECT *
      FROM clients
      WHERE lower(owner_email) = lower($1)
      LIMIT 1
    `,
    [ownerEmail]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function getClientByTenantKey(tenantKey: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      SELECT *
      FROM clients
      WHERE tenant_key = $1
      LIMIT 1
    `,
    [tenantKey]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function getClientByStripeCustomerId(stripeCustomerId: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      SELECT *
      FROM clients
      WHERE stripe_customer_id = $1
      LIMIT 1
    `,
    [stripeCustomerId]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function getClientByStripeSubscriptionId(stripeSubscriptionId: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      SELECT *
      FROM clients
      WHERE stripe_subscription_id = $1
      LIMIT 1
    `,
    [stripeSubscriptionId]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function getClientById(clientId: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      SELECT *
      FROM clients
      WHERE id = $1
      LIMIT 1
    `,
    [clientId]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function createClient(input: CreateClientInput): Promise<Client> {
  const result = await dbQuery<ClientRow>(
    `
      INSERT INTO clients (
        business_name,
        owner_name,
        owner_email,
        owner_phone,
        transfer_number,
        area_code,
        hours,
        faqs,
        greeting,
        system_prompt,
        twilio_number,
        twilio_number_sid,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_status,
        grandfathered,
        tts_model,
        stt_model,
        llm_model,
        tools_allowed,
        tenant_key,
        baseline_version,
        baseline_hash,
        override_hash,
        bootstrap_state
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::text[],
        $21, $22, $23, $24, $25
      )
      RETURNING *
    `,
    [
      input.businessName,
      input.ownerName ?? null,
      input.ownerEmail,
      input.ownerPhone ?? null,
      input.transferNumber ?? null,
      input.areaCode ?? null,
      input.hours == null ? null : JSON.stringify(input.hours),
      input.faqs == null ? null : JSON.stringify(input.faqs),
      input.greeting ?? null,
      input.systemPrompt ?? null,
      input.twilioNumber ?? null,
      input.twilioNumberSid ?? null,
      input.stripeCustomerId,
      input.stripeSubscriptionId ?? null,
      input.subscriptionStatus ?? 'trial',
      input.grandfathered ?? false,
      input.ttsModel ?? 'aura-2-thalia-en',
      input.sttModel ?? 'nova-2',
      input.llmModel ?? 'gpt-4o-mini',
      input.toolsAllowed ?? ['transfer_to_human', 'send_sms'],
      input.tenantKey ?? null,
      input.baselineVersion ?? null,
      input.baselineHash ?? null,
      input.overrideHash ?? null,
      input.bootstrapState ?? 'draft',
    ]
  );

  return mapClientRow(result.rows[0]);
}

export async function updateClient(clientId: string, input: UpdateClientInput): Promise<Client | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const pushSet = (column: string, value: unknown, cast = '') => {
    if (value === undefined) return;
    values.push(value);
    setClauses.push(`${column} = $${values.length}${cast}`);
  };

  pushSet('business_name', input.businessName);
  pushSet('owner_name', input.ownerName);
  pushSet('owner_email', input.ownerEmail);
  pushSet('owner_phone', input.ownerPhone);
  pushSet('transfer_number', input.transferNumber);
  pushSet('area_code', input.areaCode);
  pushSet('hours', input.hours === undefined ? undefined : JSON.stringify(input.hours), '::jsonb');
  pushSet('faqs', input.faqs === undefined ? undefined : JSON.stringify(input.faqs), '::jsonb');
  pushSet('greeting', input.greeting);
  pushSet('system_prompt', input.systemPrompt);
  pushSet('twilio_number', input.twilioNumber);
  pushSet('twilio_number_sid', input.twilioNumberSid);
  pushSet('stripe_customer_id', input.stripeCustomerId);
  pushSet('stripe_subscription_id', input.stripeSubscriptionId);
  pushSet('subscription_status', input.subscriptionStatus);
  pushSet('grandfathered', input.grandfathered);
  pushSet('tts_model', input.ttsModel);
  pushSet('stt_model', input.sttModel);
  pushSet('llm_model', input.llmModel);
  pushSet('tools_allowed', input.toolsAllowed, '::text[]');
  pushSet('tenant_key', input.tenantKey);
  pushSet('baseline_version', input.baselineVersion);
  pushSet('baseline_hash', input.baselineHash);
  pushSet('override_hash', input.overrideHash);
  pushSet('bootstrap_state', input.bootstrapState);

  if (setClauses.length === 0) {
    return getClientById(clientId);
  }

  values.push(clientId);
  const result = await dbQuery<ClientRow>(
    `
      UPDATE clients
      SET ${setClauses.join(', ')}
      WHERE id = $${values.length}
      RETURNING *
    `,
    values
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function deactivateClient(clientId: string): Promise<Client | null> {
  const result = await dbQuery<ClientRow>(
    `
      UPDATE clients
      SET subscription_status = 'canceled',
          bootstrap_state = 'failed'
      WHERE id = $1
      RETURNING *
    `,
    [clientId]
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export async function logCall(input: LogCallInput): Promise<CallLog> {
  const result = await dbQuery<CallLogRow>(
    `
      INSERT INTO call_logs (
        client_id,
        call_sid,
        caller_number,
        duration_seconds,
        transcript_summary,
        tool_calls
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
    `,
    [
      input.clientId,
      input.callSid,
      input.callerNumber ?? null,
      input.durationSeconds ?? null,
      input.transcriptSummary ?? null,
      input.toolCalls ?? null,
    ]
  );

  return mapCallLogRow(result.rows[0]);
}

export async function upsertCallLog(input: LogCallInput): Promise<CallLog> {
  const result = await dbQuery<CallLogRow>(
    `
      INSERT INTO call_logs (
        client_id,
        call_sid,
        caller_number,
        duration_seconds,
        transcript_summary,
        tool_calls
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (call_sid)
      DO UPDATE SET
        caller_number = COALESCE(EXCLUDED.caller_number, call_logs.caller_number),
        duration_seconds = COALESCE(call_logs.duration_seconds, EXCLUDED.duration_seconds),
        transcript_summary = COALESCE(EXCLUDED.transcript_summary, call_logs.transcript_summary),
        tool_calls = COALESCE(EXCLUDED.tool_calls, call_logs.tool_calls)
      RETURNING *
    `,
    [
      input.clientId,
      input.callSid,
      input.callerNumber ?? null,
      input.durationSeconds ?? null,
      input.transcriptSummary ?? null,
      input.toolCalls ?? null,
    ]
  );

  return mapCallLogRow(result.rows[0]);
}

export async function updateCallDurationBySid(callSid: string, durationSeconds: number): Promise<CallLog | null> {
  const result = await dbQuery<CallLogRow>(
    `
      UPDATE call_logs
      SET duration_seconds = $2
      WHERE call_sid = $1
      RETURNING *
    `,
    [callSid, durationSeconds]
  );

  const row = result.rows[0];
  return row ? mapCallLogRow(row) : null;
}

export async function getCallLogs(clientId: string, limit = 50): Promise<CallLog[]> {
  return getCallLogsPage(clientId, { limit, offset: 0 });
}

export async function getCallLogsPage(clientId: string, options: GetCallLogsOptions = {}): Promise<CallLog[]> {
  const safeLimit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit as number))) : 50;
  const safeOffset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset as number)) : 0;

  const result = await dbQuery<CallLogRow>(
    `
      SELECT *
      FROM call_logs
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [clientId, safeLimit, safeOffset]
  );

  return result.rows.map(mapCallLogRow);
}

function normalizeClientStatusFilter(status?: string): SubscriptionStatus | undefined {
  if (!status || status === 'all') {
    return undefined;
  }

  return asSubscriptionStatus(status);
}

export async function listClients(options: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Client[]> {
  const safeLimit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit as number))) : 100;
  const safeOffset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset as number)) : 0;
  const statusFilter = normalizeClientStatusFilter(options.status);

  const result = statusFilter
    ? await dbQuery<ClientRow>(
      `
        SELECT *
        FROM clients
        WHERE subscription_status = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [statusFilter, safeLimit, safeOffset]
    )
    : await dbQuery<ClientRow>(
      `
        SELECT *
        FROM clients
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [safeLimit, safeOffset]
    );

  return result.rows.map(mapClientRow);
}

export async function listAllClients(options: {
  status?: ClientStatusFilter | string;
} = {}): Promise<Client[]> {
  const statusFilter = normalizeClientStatusFilter(options.status);

  const result = statusFilter
    ? await dbQuery<ClientRow>(
      `
        SELECT *
        FROM clients
        WHERE subscription_status = $1
        ORDER BY created_at DESC
      `,
      [statusFilter]
    )
    : await dbQuery<ClientRow>(
      `
        SELECT *
        FROM clients
        ORDER BY created_at DESC
      `
    );

  return result.rows.map(mapClientRow);
}

export async function getSubscriptionByClientId(clientId: string): Promise<ClientSubscription | null> {
  const result = await dbQuery<ClientSubscriptionRow>(
    `
      SELECT
        client_id,
        status,
        trial_start,
        trial_end,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        updated_at
      FROM subscriptions
      WHERE client_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [clientId]
  );

  const row = result.rows[0];
  return row ? mapClientSubscriptionRow(row) : null;
}

export async function getClientStats(): Promise<ClientStats> {
  const result = await dbQuery<ClientStatsRow>(
    `
      SELECT
        COUNT(*)::int AS total_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'pending')::int AS pending_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'active')::int AS active_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'trial')::int AS trial_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'past_due')::int AS past_due_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'canceled')::int AS canceled_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'canceled')::int AS churned_clients,
        (
          SELECT COUNT(*)::int
          FROM call_logs
          WHERE created_at >= date_trunc('day', NOW())
        ) AS total_calls_today
      FROM clients
    `
  );

  const row = result.rows[0];
  return row ? mapClientStatsRow(row) : {
    totalClients: 0,
    pendingClients: 0,
    activeClients: 0,
    trialClients: 0,
    pastDueClients: 0,
    canceledClients: 0,
    churnedClients: 0,
    totalCallsToday: 0,
  };
}
