import cookieParser from 'cookie-parser';
import express, { type Request, type Response } from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { create } from 'xmlbuilder2';
import { handleMagicLinkRequest, handleMagicLinkVerify, renderLoginPage } from './api/auth';
import { handleAdminClientsExport, handleAdminClientsList, renderAdmin, renderAdminClient } from './api/admin';
import { handleClientBillingPortal, handlePatchAdminClient, handlePatchOwnClient } from './api/clients';
import { handleClientCallsList, handleTwilioCallStatus } from './api/calls';
import { renderDashboard } from './api/dashboard';
import { handleProvisionRequest, handleStripeCheckout, handleStripeWebhook } from './api/stripe';
import { requireAdmin, requireAuth, requirePageAuth } from './middleware/auth';
import { env } from './utils/env';
import { logger } from './utils/logger';
import { handleTwilioMedia } from './websocket/handler';

const app = express();
app.use(express.urlencoded({ extended: true }));

// Stripe webhook signature verification requires raw body bytes.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

function renderVoiceResponse(req: Request): string {
  const wsUrl = env.TWILIO_WEBSOCKET_URL || `${env.BASE_URL.replace('http', 'ws')}/media-stream`;
  const toNumber = req.body.To || '';

  return create({ version: '1.0' })
    .ele('Response')
    .ele('Connect')
    .ele('Stream', { url: wsUrl })
    .ele('Parameter', { name: 'callerNumber', value: req.body.From || '' }).up()
    .ele('Parameter', { name: 'toNumber', value: toNumber }).up()
    .ele('Parameter', { name: 'calledNumber', value: toNumber }).up()
    .ele('Parameter', { name: 'callSid', value: req.body.CallSid || '' }).up()
    .up().up().up().end({ prettyPrint: true });
}

function handleVoiceRequest(req: Request, res: Response): void {
  res.type('text/xml').send(renderVoiceResponse(req));
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/stripe/checkout', handleStripeCheckout);
app.post('/api/provision', handleProvisionRequest);
app.post('/api/call-status', handleTwilioCallStatus);

app.post('/api/auth/magic-link', handleMagicLinkRequest);
app.get('/api/auth/verify', handleMagicLinkVerify);
app.get('/login', renderLoginPage);

app.get('/dashboard', requirePageAuth, renderDashboard);
app.patch('/api/clients/:id', requireAuth, handlePatchOwnClient);
app.get('/api/clients/:id/calls', requireAuth, handleClientCallsList);
app.get('/api/clients/:id/billing-portal', requireAuth, handleClientBillingPortal);

app.get('/admin', requirePageAuth, requireAdmin, renderAdmin);
app.get('/admin/client/:id', requirePageAuth, requireAdmin, renderAdminClient);
app.get('/api/admin/clients', requireAuth, requireAdmin, handleAdminClientsList);
app.get('/api/admin/export', requireAuth, requireAdmin, handleAdminClientsExport);
app.patch('/api/admin/clients/:id', requireAuth, requireAdmin, handlePatchAdminClient);

app.post('/incoming-call', handleVoiceRequest);
app.post('/voice', handleVoiceRequest);

app.post('/fallback', (_req, res) => {
  res.type('text/xml').send('<Response><Say>Sorry, we are having technical difficulty. Let me transfer you now.</Say></Response>');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  logger.info('WS connected');
  handleTwilioMedia(ws as any);
});

server.listen(env.PORT, () => {
  logger.info(`Cadence listening on :${env.PORT}`);
});
