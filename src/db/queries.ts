import type { QueryResultRow } from 'pg';
import { dbQuery } from './client';

export type SubscriptionStatus = 'pending' | 'trial' | 'active' | 'past_due' | 'canceled';

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
  ttsModel: string;
  sttModel: string;
  llmModel: string;
  toolsAllowed: string[];
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
  hours?: ClientHours;
  faqs?: ClientFaq[];
  greeting?: string | null;
  systemPrompt?: string | null;
  twilioNumber?: string | null;
  twilioNumberSid?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  ttsModel?: string;
  sttModel?: string;
  llmModel?: string;
  toolsAllowed?: string[];
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
  ttsModel?: string;
  sttModel?: string;
  llmModel?: string;
  toolsAllowed?: string[];
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
  activeClients: number;
  trialClients: number;
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
  tts_model: string;
  stt_model: string;
  llm_model: string;
  tools_allowed: unknown;
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
  active_clients: number;
  trial_clients: number;
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
    ttsModel: row.tts_model,
    sttModel: row.stt_model,
    llmModel: row.llm_model,
    toolsAllowed: asStringArray(row.tools_allowed),
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

function mapClientStatsRow(row: ClientStatsRow): ClientStats {
  return {
    totalClients: asNumber(row.total_clients),
    activeClients: asNumber(row.active_clients),
    trialClients: asNumber(row.trial_clients),
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
        tts_model,
        stt_model,
        llm_model,
        tools_allowed
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19::text[]
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
      input.hours ?? {},
      input.faqs ?? [],
      input.greeting ?? null,
      input.systemPrompt ?? null,
      input.twilioNumber ?? null,
      input.twilioNumberSid ?? null,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.subscriptionStatus ?? 'trial',
      input.ttsModel ?? 'aura-2-thalia-en',
      input.sttModel ?? 'nova-2',
      input.llmModel ?? 'gpt-4o-mini',
      input.toolsAllowed ?? ['transfer_to_human', 'send_sms'],
    ]
  );

  return mapClientRow(result.rows[0]);
}

export async function updateClient(clientId: string, input: UpdateClientInput): Promise<Client | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const pushSet = (column: string, value: unknown) => {
    if (value === undefined) return;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  };

  pushSet('business_name', input.businessName);
  pushSet('owner_name', input.ownerName);
  pushSet('owner_email', input.ownerEmail);
  pushSet('owner_phone', input.ownerPhone);
  pushSet('transfer_number', input.transferNumber);
  pushSet('area_code', input.areaCode);
  pushSet('hours', input.hours);
  pushSet('faqs', input.faqs);
  pushSet('greeting', input.greeting);
  pushSet('system_prompt', input.systemPrompt);
  pushSet('twilio_number', input.twilioNumber);
  pushSet('twilio_number_sid', input.twilioNumberSid);
  pushSet('stripe_customer_id', input.stripeCustomerId);
  pushSet('stripe_subscription_id', input.stripeSubscriptionId);
  pushSet('subscription_status', input.subscriptionStatus);
  pushSet('tts_model', input.ttsModel);
  pushSet('stt_model', input.sttModel);
  pushSet('llm_model', input.llmModel);
  pushSet('tools_allowed', input.toolsAllowed);

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
      SET subscription_status = 'canceled'
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

export async function getCallLogs(clientId: string, limit = 50): Promise<CallLog[]> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;

  const result = await dbQuery<CallLogRow>(
    `
      SELECT *
      FROM call_logs
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [clientId, safeLimit]
  );

  return result.rows.map(mapCallLogRow);
}

export async function listClients(options: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Client[]> {
  const safeLimit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit as number))) : 100;
  const safeOffset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset as number)) : 0;

  const status = options.status;
  const hasStatusFilter = status === 'pending' || status === 'trial' || status === 'active' || status === 'past_due' || status === 'canceled';

  const result = hasStatusFilter
    ? await dbQuery<ClientRow>(
      `
        SELECT *
        FROM clients
        WHERE subscription_status = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [status, safeLimit, safeOffset]
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
        COUNT(*) FILTER (WHERE subscription_status = 'active')::int AS active_clients,
        COUNT(*) FILTER (WHERE subscription_status = 'trial')::int AS trial_clients,
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
    activeClients: 0,
    trialClients: 0,
    churnedClients: 0,
    totalCallsToday: 0,
  };
}
