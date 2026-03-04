import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import nodemailer, { type Transporter } from 'nodemailer';
import { getClientByOwnerEmail } from '../db/queries';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { escapeHtml, renderAppShell } from './ui-shell';

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

  const contentHtml = `<div class="login-shell">
    <section class="card-surface login-card">
      <h1 class="brand-title">Cadence</h1>
      <p class="brand-subtitle">Cadence by Autom8 — sign in with your email magic link.</p>

      <form id="magic-link-form">
        <div class="form-row">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required />
        </div>

        <div class="inline-row form-row">
          <input id="remember_me" name="remember_me" type="checkbox" checked />
          <label for="remember_me" style="margin: 0; text-transform: none; letter-spacing: 0; font-size: 0.92rem;">Remember me for 30 days</label>
        </div>

        <input id="next" name="next" type="hidden" value="${escapeHtml(nextPath)}" />
        <button class="btn btn-primary" type="submit" style="width: 100%;">Send magic link</button>
      </form>

      <p class="form-feedback" id="status"></p>
    </section>
  </div>

  <script>
    const form = document.getElementById('magic-link-form');
    const status = document.getElementById('status');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.className = 'form-feedback';
      status.textContent = 'Sending magic link...';

      const email = document.getElementById('email').value.trim();
      const next = document.getElementById('next').value.trim();
      const rememberMe = document.getElementById('remember_me').checked;

      try {
        const response = await fetch('/api/auth/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, next, remember_me: rememberMe })
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to send magic link');
        }

        status.className = 'form-feedback feedback-ok';
        status.textContent = 'Check your inbox — your secure sign-in link is on the way.';
      } catch (error) {
        status.className = 'form-feedback feedback-error';
        status.textContent = error instanceof Error ? error.message : 'Failed to send magic link';
      }
    });
  </script>`;

  const page = renderAppShell({
    title: 'Cadence Login',
    bodyClassName: 'login-page',
    contentHtml,
    footerHtml: 'Powered by <a class="footer-link" href="https://autom8everything.com" target="_blank" rel="noopener noreferrer">Autom8 Everything</a>',
  });

  res.type('html').send(page);
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
