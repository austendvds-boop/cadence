import type { Request, Response } from 'express';
import { invalidateTenantCacheByTwilioNumber } from '../config/tenant-routing';
import {
  getClientById,
  updateClient,
  type ClientFaq,
  type ClientHours,
  type SubscriptionStatus,
  type UpdateClientInput,
} from '../db/queries';
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

function asHours(value: unknown): ClientHours | undefined {
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
  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [];
}

function asSubscriptionStatus(value: unknown): SubscriptionStatus | undefined {
  if (value !== 'trial' && value !== 'active' && value !== 'past_due' && value !== 'canceled') {
    return undefined;
  }
  return value;
}

function buildUpdateClientInput(body: Record<string, unknown>): UpdateClientInput {
  const update: UpdateClientInput = {};

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

  if ('system_prompt' in body || 'systemPrompt' in body) {
    update.systemPrompt = asNullableString(body.system_prompt ?? body.systemPrompt);
  }

  if ('twilio_number' in body || 'twilioNumber' in body) {
    update.twilioNumber = asNullableString(body.twilio_number ?? body.twilioNumber);
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

  if ('subscription_status' in body || 'subscriptionStatus' in body) {
    const status = asSubscriptionStatus(body.subscription_status ?? body.subscriptionStatus);
    if (status) update.subscriptionStatus = status;
  }

  return update;
}

function hasUpdates(input: UpdateClientInput): boolean {
  return Object.keys(input).length > 0;
}

export async function handlePatchClient(req: Request, res: Response) {
  try {
    const clientId = asTrimmedString(req.params.id);
    if (!clientId) {
      return res.status(400).json({ error: 'Client id is required' });
    }

    const existingClient = await getClientById(clientId);
    if (!existingClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const updates = buildUpdateClientInput(asRecord(req.body));
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
      id: updatedClient.id,
      business_name: updatedClient.businessName,
      owner_name: updatedClient.ownerName,
      owner_email: updatedClient.ownerEmail,
      owner_phone: updatedClient.ownerPhone,
      transfer_number: updatedClient.transferNumber,
      twilio_number: updatedClient.twilioNumber,
      greeting: updatedClient.greeting,
      system_prompt: updatedClient.systemPrompt,
      tts_model: updatedClient.ttsModel,
      stt_model: updatedClient.sttModel,
      tools_allowed: updatedClient.toolsAllowed,
      subscription_status: updatedClient.subscriptionStatus,
      updated_at: updatedClient.updatedAt,
    });
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'PATCH /api/clients/:id failed');
    return res.status(500).json({ error: 'Failed to update client' });
  }
}
