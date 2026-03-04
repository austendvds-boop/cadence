import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { create } from 'xmlbuilder2';
import { env } from './utils/env';
import { logger } from './utils/logger';
import { handleTwilioMedia } from './websocket/handler';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/voice', (req, res) => {
  const wsUrl = env.TWILIO_WEBSOCKET_URL || `${env.BASE_URL.replace('http', 'ws')}/media-stream`;
  const xml = create({ version: '1.0' })
    .ele('Response')
    .ele('Connect')
    .ele('Stream', { url: wsUrl })
    .ele('Parameter', { name: 'callerNumber', value: req.body.From || '' }).up()
    .ele('Parameter', { name: 'toNumber', value: req.body.To || '' }).up()
    .ele('Parameter', { name: 'callSid', value: req.body.CallSid || '' }).up()
    .up().up().up().end({ prettyPrint: true });
  res.type('text/xml').send(xml);
});

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
