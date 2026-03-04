import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import nodemailer, { type Transporter } from 'nodemailer';
import { getClientByOwnerEmail } from '../db/queries';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

const MAGIC_LINK_EXPIRY = '15m';
const SESSION_EXPIRY = '7d';
const REMEMBER_SESSION_EXPIRY = '30d';
const SESSION_COOKIE_NAME = 'cadence_token';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function asBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }

  return defaultValue;
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

function getAdminEmail(): string {
  return (env.ADMIN_EMAIL || 'aust@autom8everything.com').trim().toLowerCase();
}

function isAdminEmail(email: string): boolean {
  return email.trim().toLowerCase() === getAdminEmail();
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

function buildMagicLink(email: string, nextPath: string, rememberMe: boolean): string {
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
  verifyUrl.searchParams.set('remember', rememberMe ? '1' : '0');
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
    .field-label { display: block; margin-bottom: 8px; font-size: 14px; }
    input[type="email"] { width: 100%; box-sizing: border-box; border: 1px solid #374151; background: #0f172a; color: #f3f4f6; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
    .remember-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 14px; }
    .remember-row input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: #2563eb; }
    .remember-row label { margin: 0; font-size: 14px; color: #d1d5db; }
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
        <label class="field-label" for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        <div class="remember-row">
          <input id="remember_me" name="remember_me" type="checkbox" checked />
          <label for="remember_me">Remember me for 30 days</label>
        </div>
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
      const rememberMe = document.getElementById('remember_me').checked;

      try {
        const response = await fetch('/api/auth/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, next, remember_me: rememberMe }),
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
    const rememberMe = asBoolean(body.remember_me, false);

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const adminEmail = isAdminEmail(email);
    const client = adminEmail ? null : await getClientByOwnerEmail(email);

    if (!adminEmail && !client) {
      return res.status(200).json({ ok: true });
    }

    const recipientEmail = client?.ownerEmail || email;
    const verifyUrl = buildMagicLink(recipientEmail, nextPath, rememberMe);

    try {
      const sendResult = await getTransporter().sendMail({
        from: env.SMTP_FROM || env.SMTP_USER,
        to: recipientEmail,
        subject: 'Your Cadence login link',
        text: `Click here to access your dashboard: ${verifyUrl}`,
        html: `<p>Click here to access your dashboard:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
      });

      logger.info(
        {
          email: recipientEmail,
          messageId: sendResult.messageId,
          accepted: sendResult.accepted,
          rejected: sendResult.rejected,
        },
        'Magic link email sent'
      );
    } catch (sendErr) {
      console.error('Magic link send failed', {
        email: recipientEmail,
        smtpHost: env.SMTP_HOST,
        smtpPort: env.SMTP_PORT,
        smtpUser: env.SMTP_USER,
        error: sendErr,
      });
      logger.error({ err: sendErr, email: recipientEmail }, 'Magic link email send failed');
      throw sendErr;
    }

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
    const rememberSession = asTrimmedString(req.query.remember) === '1';

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const payload = jwt.verify(token, getJwtSecret()) as MagicLinkTokenPayload;
    if (payload.type !== 'magic-link' || !payload.email) {
      return res.status(401).json({ error: 'Invalid magic link token' });
    }

    const isAdminLogin = isAdminEmail(payload.email);
    const client = await getClientByOwnerEmail(payload.email);

    if (!client && !isAdminLogin) {
      return res.status(401).json({ error: 'No client found for token' });
    }

    const sessionToken = jwt.sign(
      {
        type: 'session',
        client_id: client?.id || 'admin',
        email: client?.ownerEmail || payload.email,
      },
      getJwtSecret(),
      { expiresIn: rememberSession ? REMEMBER_SESSION_EXPIRY : SESSION_EXPIRY }
    );

    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.BASE_URL.startsWith('https://'),
      maxAge: (rememberSession ? 30 : 7) * ONE_DAY_MS,
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
