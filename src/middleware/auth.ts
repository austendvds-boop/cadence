import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getClientById } from '../db/queries';
import { env } from '../utils/env';

const AUTH_COOKIE_NAME = 'cadence_token';

type AuthFailureMode = 'json' | 'redirect';

type SessionTokenPayload = {
  type: 'session';
  client_id: string;
  email: string;
  iat?: number;
  exp?: number;
};

export type AuthenticatedRequest = Request & {
  authClientId: string;
  authEmail: string;
};

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function getSessionToken(req: Request): string | null {
  const cookieToken = typeof req.cookies?.[AUTH_COOKIE_NAME] === 'string'
    ? req.cookies[AUTH_COOKIE_NAME]
    : null;

  return cookieToken || extractBearerToken(req);
}

function getJwtSecret(): string {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return env.JWT_SECRET;
}

function buildLoginRedirect(req: Request): string {
  const next = req.originalUrl || req.path || '/dashboard';
  return `/login?next=${encodeURIComponent(next)}`;
}

function handleAuthFailure(
  req: Request,
  res: Response,
  status: number,
  error: string,
  failureMode: AuthFailureMode
) {
  if (failureMode === 'redirect') {
    return res.redirect(302, buildLoginRedirect(req));
  }

  return res.status(status).json({ error });
}

async function enforceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  failureMode: AuthFailureMode
) {
  try {
    const token = getSessionToken(req);
    if (!token) {
      return handleAuthFailure(req, res, 401, 'Unauthorized', failureMode);
    }

    const payload = jwt.verify(token, getJwtSecret()) as SessionTokenPayload;
    if (payload.type !== 'session' || !payload.client_id || !payload.email) {
      return handleAuthFailure(req, res, 401, 'Invalid session token', failureMode);
    }

    const client = await getClientById(payload.client_id);
    if (!client) {
      return handleAuthFailure(req, res, 401, 'Client not found for session', failureMode);
    }

    const requestWithAuth = req as AuthenticatedRequest;
    requestWithAuth.authClientId = client.id;
    requestWithAuth.authEmail = payload.email;
    return next();
  } catch {
    return handleAuthFailure(req, res, 401, 'Invalid or expired session', failureMode);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  return enforceAuth(req, res, next, 'json');
}

export async function requirePageAuth(req: Request, res: Response, next: NextFunction) {
  return enforceAuth(req, res, next, 'redirect');
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const requestWithAuth = req as Partial<AuthenticatedRequest>;
  const authEmail = (requestWithAuth.authEmail || '').trim().toLowerCase();
  const adminEmail = (env.ADMIN_EMAIL || 'aust@autom8everything.com').trim().toLowerCase();

  if (!authEmail || authEmail !== adminEmail) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return next();
}
