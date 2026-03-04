import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import nodemailer, { type Transporter } from 'nodemailer';
import { getClientByOwnerEmail } from '../db/queries';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

const MAGIC_LINK_EXPIRY = '15m';
const SESSION_EXPIRY = '7d';
const SESSION_COOKIE_NAME = 'cadence_token';

type MagicLinkTokenPayload = {
  type: 'magic-link';
  email: string;
  iat?: number;
  exp?: number;
};

let smtpTransporter: Transporter | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getJwtSecret(): string {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return env.JWT_SECRET;
}

function getTransporter(): Transporter {
  if (smtpTransporter) return smtpTransporter;

  if (!env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error('SMTP_USER / SMTP_PASS are not configured');
  }

  smtpTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return smtpTransporter;
}

function buildMagicLink(email: string): string {
  const token = jwt.sign(
    {
      type: 'magic-link',
      email,
    },
    getJwtSecret(),
    { expiresIn: MAGIC_LINK_EXPIRY }
  );

  const verifyUrl = new URL('/api/auth/verify', env.BASE_URL);
  verifyUrl.searchParams.set('token', token);
  verifyUrl.searchParams.set('redirect', '1');
  return verifyUrl.toString();
}

function toPublicClient(client: Awaited<ReturnType<typeof getClientByOwnerEmail>>) {
  if (!client) return null;

  return {
    id: client.id,
    business_name: client.businessName,
    owner_email: client.ownerEmail,
    subscription_status: client.subscriptionStatus,
    twilio_number: client.twilioNumber,
  };
}

export async function handleMagicLinkRequest(req: Request, res: Response) {
  try {
    const body = asRecord(req.body);
    const email = asTrimmedString(body.email).toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const client = await getClientByOwnerEmail(email);
    if (!client) {
      return res.status(200).json({ ok: true });
    }

    const verifyUrl = buildMagicLink(client.ownerEmail);

    await getTransporter().sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: client.ownerEmail,
      subject: 'Your Cadence login link',
      text: `Click here to access your dashboard: ${verifyUrl}`,
      html: `<p>Click here to access your dashboard:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'POST /api/auth/magic-link failed');
    return res.status(500).json({ error: 'Failed to send magic link' });
  }
}

export async function handleMagicLinkVerify(req: Request, res: Response) {
  try {
    const token = asTrimmedString(req.query.token);
    const shouldRedirect = asTrimmedString(req.query.redirect).toLowerCase();

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const payload = jwt.verify(token, getJwtSecret()) as MagicLinkTokenPayload;
    if (payload.type !== 'magic-link' || !payload.email) {
      return res.status(401).json({ error: 'Invalid magic link token' });
    }

    const client = await getClientByOwnerEmail(payload.email);
    if (!client) {
      return res.status(401).json({ error: 'No client found for token' });
    }

    const sessionToken = jwt.sign(
      {
        type: 'session',
        client_id: client.id,
        email: client.ownerEmail,
      },
      getJwtSecret(),
      { expiresIn: SESSION_EXPIRY }
    );

    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: env.BASE_URL.startsWith('https://'),
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    if (shouldRedirect === '1' || shouldRedirect === 'true' || shouldRedirect === 'yes') {
      return res.redirect(302, '/dashboard');
    }

    return res.status(200).json({
      ok: true,
      client: toPublicClient(client),
    });
  } catch (err) {
    logger.error({ err }, 'GET /api/auth/verify failed');
    return res.status(401).json({ error: 'Invalid or expired magic link' });
  }
}
