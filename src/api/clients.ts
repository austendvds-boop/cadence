import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { invalidateTenantCacheByTwilioNumber } from '../config/tenant-routing';
import {
  getClientById,
  getClientByOwnerEmail,
  updateClient,
  type Client,
  type ClientFaq,
  type ClientHours,
  type SubscriptionStatus,
  type UpdateClientInput,
} from '../db/queries';
import type { AuthenticatedRequest } from '../middleware/auth';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
  if (value === null) return null;
  const trimmed = asTrimmedString(value);
  return trimmed || null;
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function asHours(value: unknown): ClientHours | undefined {
  if (typeof value === 'string') {
    return asHours(parseJsonString(value));
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const parsed: ClientHours = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      parsed[key] = raw;
    }
  }

  return parsed;
}

function asFaqs(value: unknown): ClientFaq[] | undefined {
  if (typeof value === 'string') {
    return asFaqs(parseJsonString(value));
  }

  if (!Array.isArray(value)) return undefined;

  const parsed: ClientFaq[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const q = asTrimmedString((item as Record<string, unknown>).q);
    const a = asTrimmedString((item as Record<string, unknown>).a);
    if (q && a) {
      parsed.push({ q, a });
    }
  }

  return parsed;
}

function asToolsAllowed(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    return asToolsAllowed(parseJsonString(value));
  }

  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [];
}

function asSubscriptionStatus(value: unknown): SubscriptionStatus | undefined {
  if (value !== 'pending' && value !== 'trial' && value !== 'active' && value !== 'past_due' && value !== 'canceled') {
    return undefined;
  }
  return value;
}

function buildSelfUpdateInput(body: Record<string, unknown>): UpdateClientInput {
  const update: UpdateClientInput = {};

  if ('transfer_number' in body || 'transferNumber' in body) {
    update.transferNumber = asNullableString(body.transfer_number ?? body.transferNumber);
  }

  if ('hours' in body) {
    const parsedHours = asHours(body.hours);
    if (parsedHours) update.hours = parsedHours;
  }

  if ('faqs' in body) {
    const parsedFaqs = asFaqs(body.faqs);
    if (parsedFaqs) update.faqs = parsedFaqs;
  }

  if ('greeting' in body) {
    update.greeting = asNullableString(body.greeting);
  }

  return update;
}

function buildAdminUpdateInput(body: Record<string, unknown>): UpdateClientInput {
  const update: UpdateClientInput = { ...buildSelfUpdateInput(body) };

  if ('business_name' in body || 'businessName' in body) {
    const value = asNullableString(body.business_name ?? body.businessName);
    if (value) update.businessName = value;
  }

  if ('owner_name' in body || 'ownerName' in body) {
    update.ownerName = asNullableString(body.owner_name ?? body.ownerName);
  }

  if ('owner_email' in body || 'ownerEmail' in body) {
    const value = asNullableString(body.owner_email ?? body.ownerEmail);
    if (value) update.ownerEmail = value;
  }

  if ('owner_phone' in body || 'ownerPhone' in body) {
    update.ownerPhone = asNullableString(body.owner_phone ?? body.ownerPhone);
  }

  if ('area_code' in body || 'areaCode' in body) {
    update.areaCode = asNullableString(body.area_code ?? body.areaCode);
  }

  if ('system_prompt' in body || 'systemPrompt' in body) {
    update.systemPrompt = asNullableString(body.system_prompt ?? body.systemPrompt);
  }

  if ('twilio_number' in body || 'twilioNumber' in body) {
    update.twilioNumber = asNullableString(body.twilio_number ?? body.twilioNumber);
  }

  if ('twilio_number_sid' in body || 'twilioNumberSid' in body) {
    update.twilioNumberSid = asNullableString(body.twilio_number_sid ?? body.twilioNumberSid);
  }

  if ('stripe_customer_id' in body || 'stripeCustomerId' in body) {
    update.stripeCustomerId = asNullableString(body.stripe_customer_id ?? body.stripeCustomerId);
  }

  if ('stripe_subscription_id' in body || 'stripeSubscriptionId' in body) {
    update.stripeSubscriptionId = asNullableString(body.stripe_subscription_id ?? body.stripeSubscriptionId);
  }

  if ('subscription_status' in body || 'subscriptionStatus' in body) {
    const status = asSubscriptionStatus(body.subscription_status ?? body.subscriptionStatus);
    if (status) update.subscriptionStatus = status;
  }

  if ('tts_model' in body || 'ttsModel' in body) {
    const value = asNullableString(body.tts_model ?? body.ttsModel);
    if (value) update.ttsModel = value;
  }

  if ('stt_model' in body || 'sttModel' in body) {
    const value = asNullableString(body.stt_model ?? body.sttModel);
    if (value) update.sttModel = value;
  }

  if ('llm_model' in body || 'llmModel' in body) {
    const value = asNullableString(body.llm_model ?? body.llmModel);
    if (value) update.llmModel = value;
  }

  if ('tools_allowed' in body || 'toolsAllowed' in body) {
    const toolsAllowed = asToolsAllowed(body.tools_allowed ?? body.toolsAllowed);
    if (toolsAllowed) update.toolsAllowed = toolsAllowed;
  }

  return update;
}

function hasUpdates(input: UpdateClientInput): boolean {
  return Object.keys(input).length > 0;
}

function toClientResponse(client: Client) {
  return {
    id: client.id,
    business_name: client.businessName,
    owner_name: client.ownerName,
    owner_email: client.ownerEmail,
    owner_phone: client.ownerPhone,
    transfer_number: client.transferNumber,
    area_code: client.areaCode,
    twilio_number: client.twilioNumber,
    subscription_status: client.subscriptionStatus,
    hours: client.hours,
    faqs: client.faqs,
    greeting: client.greeting,
    created_at: client.createdAt,
    updated_at: client.updatedAt,
  };
}

function getStripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  return new Stripe(env.STRIPE_SECRET_KEY);
}

function getAuthClientId(req: Request): string {
  return (req as Partial<AuthenticatedRequest>).authClientId || '';
}

function getAuthEmail(req: Request): string {
  return (req as Partial<AuthenticatedRequest>).authEmail || '';
}

export async function handlePatchOwnClient(req: Request, res: Response) {
  try {
    const clientId = asTrimmedString(req.params.id);
    if (!clientId) {
      return res.status(400).json({ error: 'Client id is required' });
    }

    const authClientId = getAuthClientId(req);
    if (!authClientId || authClientId !== clientId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const existingClient = await getClientById(clientId);
    if (!existingClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const updates = buildSelfUpdateInput(asRecord(req.body));
    if (!hasUpdates(updates)) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updatedClient = await updateClient(clientId, updates);
    if (!updatedClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    invalidateTenantCacheByTwilioNumber(existingClient.twilioNumber);
    invalidateTenantCacheByTwilioNumber(updatedClient.twilioNumber);

    return res.json(toClientResponse(updatedClient));
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'PATCH /api/clients/:id failed');
    return res.status(500).json({ error: 'Failed to update client' });
  }
}

export async function handlePatchAdminClient(req: Request, res: Response) {
  try {
    const clientId = asTrimmedString(req.params.id);
    if (!clientId) {
      return res.status(400).json({ error: 'Client id is required' });
    }

    const existingClient = await getClientById(clientId);
    if (!existingClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const updates = buildAdminUpdateInput(asRecord(req.body));
    if (!hasUpdates(updates)) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updatedClient = await updateClient(clientId, updates);
    if (!updatedClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    invalidateTenantCacheByTwilioNumber(existingClient.twilioNumber);
    invalidateTenantCacheByTwilioNumber(updatedClient.twilioNumber);

    return res.json({
      ...toClientResponse(updatedClient),
      system_prompt: updatedClient.systemPrompt,
      twilio_number_sid: updatedClient.twilioNumberSid,
      stripe_customer_id: updatedClient.stripeCustomerId,
      stripe_subscription_id: updatedClient.stripeSubscriptionId,
      tts_model: updatedClient.ttsModel,
      stt_model: updatedClient.sttModel,
      llm_model: updatedClient.llmModel,
      tools_allowed: updatedClient.toolsAllowed,
    });
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'PATCH /api/admin/clients/:id failed');
    return res.status(500).json({ error: 'Failed to update client' });
  }
}

export async function handleClientBillingPortal(req: Request, res: Response) {
  try {
    const clientId = asTrimmedString(req.params.id);
    const authClientId = getAuthClientId(req);
    const authEmail = getAuthEmail(req).toLowerCase();
    const adminEmail = (env.ADMIN_EMAIL || 'aust@autom8everything.com').toLowerCase();

    if (!clientId) {
      return res.status(400).json({ error: 'Client id is required' });
    }

    const isAdmin = authEmail === adminEmail;
    if (!authClientId || (authClientId !== clientId && !isAdmin)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const client = await getClientById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (!client.stripeCustomerId) {
      return res.status(400).json({ error: 'Client does not have a Stripe customer id yet' });
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripeCustomerId,
      return_url: `${env.BASE_URL}/dashboard`,
    });

    if (!session.url) {
      return res.status(500).json({ error: 'Failed to create billing portal session' });
    }

    const format = asTrimmedString(req.query.format).toLowerCase();
    if (format === 'json') {
      return res.status(200).json({ url: session.url });
    }

    return res.redirect(303, session.url);
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'GET /api/clients/:id/billing-portal failed');
    return res.status(500).json({ error: 'Failed to open billing portal' });
  }
}

export async function getAuthenticatedClient(req: Request): Promise<Client | null> {
  const authClientId = getAuthClientId(req);
  if (!authClientId) return null;
  return getClientById(authClientId);
}

export async function getAuthenticatedAdminClient(req: Request): Promise<Client | null> {
  const email = getAuthEmail(req);
  if (!email) return null;
  return getClientByOwnerEmail(email);
}
