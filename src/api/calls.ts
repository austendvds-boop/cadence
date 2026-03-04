import type { Request, Response } from 'express';
import { normalizePhoneNumber } from '../config/tenants';
import {
  getCallLogsPage,
  getClientById,
  getClientByTwilioNumber,
  updateCallDurationBySid,
  upsertCallLog,
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

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function asOptionalDurationSeconds(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.floor(numeric));
}

function isFinalTwilioCallStatus(value: string): boolean {
  return value === 'completed' || value === 'busy' || value === 'failed' || value === 'no-answer' || value === 'canceled';
}

function getAuthClientId(req: Request): string {
  return (req as Partial<AuthenticatedRequest>).authClientId || '';
}

function getAuthEmail(req: Request): string {
  return (req as Partial<AuthenticatedRequest>).authEmail || '';
}

function isAuthorizedForClient(req: Request, clientId: string): boolean {
  const authClientId = getAuthClientId(req);
  const authEmail = getAuthEmail(req).trim().toLowerCase();
  const adminEmail = (env.ADMIN_EMAIL || 'aust@autom8everything.com').trim().toLowerCase();

  if (!authClientId) return false;
  if (authClientId === clientId) return true;
  return Boolean(authEmail) && authEmail === adminEmail;
}

function mapCallLogResponse(call: Awaited<ReturnType<typeof getCallLogsPage>>[number]) {
  return {
    id: call.id,
    client_id: call.clientId,
    call_sid: call.callSid,
    caller_number: call.callerNumber,
    duration_seconds: call.durationSeconds,
    transcript_summary: call.transcriptSummary,
    created_at: call.createdAt,
  };
}

export async function handleClientCallsList(req: Request, res: Response) {
  try {
    const clientId = asTrimmedString(req.params.id);
    if (!clientId) {
      return res.status(400).json({ error: 'Client id is required' });
    }

    if (!isAuthorizedForClient(req, clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const client = await getClientById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const limit = asPositiveInt(req.query.limit, 50, 1, 200);
    const offset = asPositiveInt(req.query.offset, 0, 0, 10000);
    const rows = await getCallLogsPage(clientId, { limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    const calls = hasMore ? rows.slice(0, limit) : rows;

    return res.status(200).json({
      client_id: clientId,
      calls: calls.map(mapCallLogResponse),
      pagination: {
        limit,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
      },
    });
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'GET /api/clients/:id/calls failed');
    return res.status(500).json({ error: 'Failed to load call logs' });
  }
}

export async function handleTwilioCallStatus(req: Request, res: Response) {
  try {
    const body = asRecord(req.body);

    const callSid = asTrimmedString(body.CallSid ?? body.call_sid ?? body.callSid);
    if (!callSid) {
      return res.status(400).json({ error: 'CallSid is required' });
    }

    const callStatus = asTrimmedString(body.CallStatus ?? body.call_status ?? body.callStatus).toLowerCase();
    const durationSeconds = asOptionalDurationSeconds(body.CallDuration ?? body.call_duration ?? body.callDuration ?? body.Duration);
    const toNumber = normalizePhoneNumber(asTrimmedString(body.To ?? body.to ?? body.Called ?? body.called));
    const callerNumber = normalizePhoneNumber(asTrimmedString(body.From ?? body.from ?? body.Caller ?? body.caller));

    if (durationSeconds != null) {
      const updated = await updateCallDurationBySid(callSid, durationSeconds);
      if (updated) {
        return res.status(200).json({ ok: true, call_sid: callSid, updated: true });
      }
    }

    if (!isFinalTwilioCallStatus(callStatus)) {
      return res.status(200).json({ ok: true, call_sid: callSid, ignored: true });
    }

    if (!toNumber) {
      logger.warn({ callSid, callStatus }, 'Twilio call status callback missing To number; unable to create call log row');
      return res.status(202).json({ ok: true, call_sid: callSid, queued: false });
    }

    const client = await getClientByTwilioNumber(toNumber);
    if (!client) {
      logger.warn({ callSid, callStatus, toNumber }, 'No client matched Twilio status callback number');
      return res.status(202).json({ ok: true, call_sid: callSid, queued: false });
    }

    await upsertCallLog({
      clientId: client.id,
      callSid,
      callerNumber: callerNumber || null,
      durationSeconds,
      transcriptSummary: null,
    });

    return res.status(200).json({ ok: true, call_sid: callSid, updated: true });
  } catch (err) {
    logger.error({ err }, 'POST /api/call-status failed');
    return res.status(500).json({ error: 'Failed to process call status callback' });
  }
}
