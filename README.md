# Cadence (DVDS Voice Agent)

Custom Node.js voice agent for Deer Valley Driving School using Twilio Media Streams + Deepgram STT + OpenAI GPT/TTS + Acuity APIs.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill values.
3. `npm run dev`
4. Expose local server with ngrok/Cloudflare tunnel for Twilio testing.

## Endpoints

- `POST /voice` Twilio voice webhook, returns `<Connect><Stream ...>` TwiML
- `POST /fallback` fallback TwiML
- `GET /health` health check
- `WS /media-stream` Twilio bidirectional stream

## Deploy to Railway (REST API)

- Create project `cadence` in Railway.
- Set service env vars from `.env.example`.
- Deploy from GitHub repo.
- Set Twilio incoming call webhook to `https://<railway-url>/voice`.

## Call forwarding setup

Use carrier conditional forward to Twilio number `+18773464394`:
- Enable: `*71+18773464394`
- Disable: `*73`

## Test

Call `+18773464394`.
- Should connect WS and log incoming audio packets.
- STT should print interim/final text.
- Agent should speak response and execute tools.

## Known TODO

- Replace placeholder WAV passthrough with strict PCM->8k μ-law conversion for Twilio output quality.
- Add richer city aliases and full FAQ prompt expansion.
- Add transcript persistence and post-call summaries.
