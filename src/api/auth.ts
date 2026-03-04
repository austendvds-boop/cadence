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

function normalizeNextPath(value: unknown): string {
  const raw = asTrimmedString(value);
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/dashboard';
  }
  return raw;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function buildMagicLink(email: string, nextPath: string): string {
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
  verifyUrl.searchParams.set('next', nextPath);
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

export function renderLoginPage(req: Request, res: Response) {
  const nextPath = normalizeNextPath(req.query.next);

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cadence Login</title>
  <style>
    body { font-family: Inter, system-ui, -apple-system, sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: 100%; max-width: 420px; background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 24px; box-sizing: border-box; }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 16px; color: #9ca3af; }
    label { display: block; margin-bottom: 8px; font-size: 14px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #374151; background: #0f172a; color: #f3f4f6; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
    button { width: 100%; border: 0; border-radius: 10px; padding: 12px; font-weight: 600; cursor: pointer; background: #2563eb; color: white; }
    .message { margin-top: 12px; font-size: 14px; min-height: 20px; }
    .ok { color: #4ade80; }
    .error { color: #f87171; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>Sign in to Cadence</h1>
      <p>Enter your email and we’ll send a secure magic link.</p>
      <form id="magic-link-form">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        <input id="next" name="next" type="hidden" value="${escapeHtml(nextPath)}" />
        <button type="submit">Send magic link</button>
      </form>
      <div id="status" class="message"></div>
    </section>
  </main>
  <script>
    const form = document.getElementById('magic-link-form');
    const status = document.getElementById('status');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.className = 'message';
      status.textContent = 'Sending...';

      const email = document.getElementById('email').value.trim();
      const next = document.getElementById('next').value.trim();

      try {
        const response = await fetch('/api/auth/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, next }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to send magic link');
        }

        status.className = 'message ok';
        status.textContent = 'If that email is on file, check your inbox for your magic link.';
        form.reset();
      } catch (error) {
        status.className = 'message error';
        status.textContent = error instanceof Error ? error.message : 'Failed to send magic link';
      }
    });
  </script>
</body>
</html>`);
}

export async function handleMagicLinkRequest(req: Request, res: Response) {
  try {
    const body = asRecord(req.body);
    const email = asTrimmedString(body.email).toLowerCase();
    const nextPath = normalizeNextPath(body.next || body.next_path || req.query.next);

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const client = await getClientByOwnerEmail(email);
    if (!client) {
      return res.status(200).json({ ok: true });
    }

    const verifyUrl = buildMagicLink(client.ownerEmail, nextPath);

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
    const nextPath = normalizeNextPath(req.query.next);

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
      return res.redirect(302, nextPath);
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
