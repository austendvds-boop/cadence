# Coder Context

## 2026-03-04 (Admin client export: JSON list API + CSV download + admin UI controls)
- Added admin-only client list/export endpoints in `src/api/admin.ts` and wired routes in `src/index.ts`:
  - `GET /api/admin/clients` (requires `requireAuth` + `requireAdmin`) returns all matching clients as JSON with fields:
    - `id`, `business_name`, `owner_name`, `owner_email`, `owner_phone`, `subscription_status`, `twilio_number`, `created_at`, `updated_at`
  - `GET /api/admin/export` (requires `requireAuth` + `requireAdmin`) returns CSV download with headers:
    - `Business Name, Owner Name, Email, Phone, Status, Cadence Number, Signup Date`
  - Both endpoints support `?status=active|trial|canceled|past_due|all` and default to `all`.
  - CSV response now sets `Content-Type: text/csv; charset=utf-8` and `Content-Disposition` filename format: `cadence-clients-YYYY-MM-DD.csv`.
- Updated admin panel UI (`GET /admin`, `src/api/admin.ts`):
  - Added status filter dropdown options: `All`, `Active`, `Trial`, `Canceled`.
  - Added `Export Clients` button linking to the CSV endpoint with the active filter.
  - Added total count cards per status category: pending, active, trial, past_due, canceled (plus total + calls today).
  - Admin table now shows owner name, owner email, owner phone, status, cadence number, and signup date.
- Extended query layer in `src/db/queries.ts`:
  - Added `listAllClients({ status })` for unpaginated admin export/list needs.
  - Added status normalization helper for safe filtering.
  - Expanded `getClientStats()` to include `pendingClients`, `pastDueClients`, and `canceledClients` (while preserving `churnedClients` compatibility).
- Scope safety:
  - No voice routing, tenant config, or non-admin route behavior was modified.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-04 (Onboarding voice polish + Stripe SMS checkout handoff)
- Updated onboarding tenant config in `src/config/tenants.ts` for **only** `cadence-onboarding` (`+14806313993`):
  - Greeting is now the requested warm demo line:
    - `Hi! Welcome to Cadence. I'm your AI receptionist demo — and by the end of this call, I can have your own AI receptionist up and running. Let me ask you a few quick questions to get started.`
  - Rewrote onboarding system prompt to be conversational, natural, and reactive (one question at a time, follow-up clarifications, no robotic intake phrasing).
  - Added explicit exploratory path: if caller is not ready, answer Cadence questions (pricing `$199/mo`, `7-day free trial`, features/how it works), do not force intake, and close with:
    - `When you're ready, just call back and we'll get you set up in about 5 minutes.`
  - Added explicit success script after onboarding completion:
    - `Perfect — I've got everything I need. I'm texting you a link right now to complete your payment. Once you pay, your AI receptionist number will be live in about 2 minutes. Pretty cool, right?`
- Updated onboarding tool schema guidance in `src/llm/tools.ts`:
  - `save_onboarding_field` now documents the required intake keys:
    - `business_name`, `owner_name`, `owner_email`, `owner_phone`, `business_description`, `hours`, `faqs`, `transfer_number`, `area_code`.
  - `complete_onboarding` description now reflects Stripe SMS flow to collected `owner_phone`.
- Updated onboarding execution flow in `src/tools/executor.ts`:
  - Added required-field gating before `complete_onboarding` proceeds; returns `missing_fields` if intake is incomplete.
  - Normalized onboarding phone inputs (`owner_phone`, `transfer_number`) to E.164 where possible and normalized `area_code`.
  - Upsert now stores onboarding records as `subscriptionStatus: 'pending'` before payment link completion.
  - Used `business_description` to generate/store a client `systemPrompt` for post-payment receptionist behavior.
  - Checkout creation now passes `subscriptionStatus: 'pending'` to `/api/stripe/checkout`.
  - `complete_onboarding` now sends the requested SMS copy to collected `owner_phone`:
    - `Complete your Cadence setup: [checkout_url] — Your AI receptionist will be live in minutes after payment.`
  - Tool result includes `customer_message` with the exact required spoken completion line for model follow-through.
- Safety/Scope: no changes were made to DVDS tenant config or any non-onboarding tenant.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Auto-deactivation on Stripe churn + grandfathered guard)
- Stripe webhook churn handling now routes through a single helper in `src/api/stripe.ts`:
  - `customer.subscription.deleted` now calls `deactivateClient(client.id)`.
  - `invoice.payment_failed` now deactivates **only after retries are exhausted** (`next_payment_attempt` absent) and otherwise leaves client in `past_due`.
- Added churn deactivation workflow (`deactivateClient(clientId)`) to:
  - Skip grandfathered/unmanaged active clients (active with no Stripe subscription id).
  - Release Twilio numbers via `releaseNumber(twilioNumberSid)` from provisioning layer.
  - Set subscription status to `canceled` and clear `twilio_number` / `twilio_number_sid`.
  - Send client SMS: `Your Cadence subscription has ended. Your AI receptionist number has been deactivated. To reactivate, visit autom8everything.com/onboarding`.
  - Send admin email alert to `aust@autom8everything.com` (via `ADMIN_EMAIL` env) with churn/released-number notice.
- Added grandfathered support in DB/query layer:
  - New migration `db/migrations/004_add_grandfathered_clients.sql` adds `clients.grandfathered BOOLEAN NOT NULL DEFAULT FALSE`, backfills existing active clients without Stripe subscription ids as grandfathered, and adds index.
  - `src/db/queries.ts` now maps/persists `grandfathered` on `Client`, `createClient`, and `updateClient`.
  - `scripts/seed-dvds-client.ts` now marks DVDS as `grandfathered: true`.
- Reactivation path preserved:
  - Checkout continues updating existing client record by `owner_email` (no duplicate client creation).
  - Stripe-managed updates clear `grandfathered` to `false`.
  - Because churn deactivation clears Twilio assignment, re-onboarding provisions a new number.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Onboarding checkout pipeline pending-status hardening)
- Verified existing onboarding flow already:
  - Captures `area_code` during intake (`src/config/tenants.ts` onboarding prompt, `save_onboarding_field` schema guidance).
  - Saves onboarding call fields into DB and upserts a pending client in `complete_onboarding` (`src/tools/executor.ts`).
  - Calls `POST /api/stripe/checkout` and texts caller with: `Thanks for signing up! Complete your payment to go live: [checkout_url]`.
- Fixed pending-status typing/validation gaps so pending onboarding state is preserved end-to-end:
  - Expanded `SubscriptionStatus` union to include `pending` (`src/db/queries.ts`).
  - Allowed admin/client update parsing to accept `pending` (`src/api/clients.ts`).
  - Updated Stripe checkout input normalization to preserve `subscription_status: "pending"` instead of coercing to `trial` (`src/api/stripe.ts`).
  - Added `pending` filter/edit options in admin UI status selects (`src/api/admin.ts`).
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Magic link auth + client dashboard + admin panel)
- Added cookie-based auth flow:
  - `POST /api/auth/magic-link` generates a short-lived JWT magic link and sends via Gmail SMTP.
  - `GET /api/auth/verify?token=...` verifies magic link, sets `HttpOnly` `cadence_token` cookie, and supports redirect to `/dashboard`.
  - Added auth middleware in `src/middleware/auth.ts`:
    - `requireAuth` validates cookie/Bearer JWT and loads client from DB.
    - `requireAdmin` enforces `ADMIN_EMAIL` match (`aust@autom8everything.com` default).
- Added client dashboard UI route:
  - `GET /dashboard` server-renders core client data, editable settings, recent 50 calls, and Stripe billing-portal link.
  - Added billing portal redirect endpoint: `GET /api/clients/:id/billing-portal` (auth + ownership/admin check).
- Tightened client update endpoint:
  - `PATCH /api/clients/:id` now requires auth and ownership match.
  - Allowed fields limited to: `transfer_number`, `hours`, `faqs`, `greeting`.
- Added admin panel UI routes:
  - `GET /admin` lists clients, supports status filter, and shows aggregate stats.
  - `GET /admin/client/:id` renders full client config editor.
  - `PATCH /api/admin/clients/:id` supports admin override for all mutable client fields.
- Expanded DB query layer (`src/db/queries.ts`):
  - Added `listClients`, `getSubscriptionByClientId`, `getClientStats`.
- Updated env/deps:
  - Added env vars in parser + `.env.example`: `JWT_SECRET`, `ADMIN_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
  - Added packages: `cookie-parser`, `jsonwebtoken`, `nodemailer` (+ corresponding `@types/*`).
- Stripe checkout guardrail fix:
  - Removed invalid `pending` subscription status fallback; checkout now defaults to `trial` to satisfy DB constraint.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Automated Twilio provisioning + protected-number release guard)
- Completed end-to-end provisioning path used by `POST /api/provision` / Stripe webhook provisioning flow in `src/api/stripe.ts`.
- Provisioning now resolves `clientId` from `client.id`/`client_id` and can fall back to `ownerEmail` lookup when needed.
- Provisioning retains area-code preference handling with nearby-area fallback and final US-wide fallback via Twilio AvailablePhoneNumbers API (`src/twilio/provisioning.ts`).
- Added explicit guardrails so protected numbers are never modified/released: DVDS `+18773464394` and onboarding `+14806313993`.
- Added protected-number skip guard in `provisionClientInline()` so those tenants are never reassigned during provisioning.
- Refined welcome SMS target to `owner_phone` only and kept message text as: `Welcome to Cadence! Your AI receptionist is live at [number]...`.
- Added explicit deactivation helper export `releaseNumber(twilioNumberSid: string): Promise<void>` (with detailed internal variant used for webhook logging).
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (DB-backed routing migration hardening)
- Confirmed inbound routing now supports both `POST /incoming-call` and `POST /voice` and passes Twilio `To` into websocket stream params (`toNumber` + `calledNumber`).
- Confirmed runtime tenant selection path is DB-first (`getClientByTwilioNumber`) with in-memory fallback (`getTenant`) and a 5-minute in-memory cache keyed by Twilio number.
- Added compatibility export `resolveTenantByTwilioNumber` alongside `resolveTenantForIncomingNumber` to avoid breakage with older imports/docs.
- Tightened DB-to-tenant mapping so `transfer_number` is carried as `tenant.transferNumber`, while owner notifications still use owner phone when present.
- Verified cache invalidation still runs on `PATCH /api/clients/:id` for both previous and updated Twilio numbers.
- Cleaned `package.json` duplicate `db:seed:dvds` key; canonical script is now `tsx scripts/seed-dvds-client.ts`.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (DB-backed tenant routing + 5-minute cache fallback)
- Implemented DB-first tenant resolution with legacy in-memory safety net:
  - Added `src/config/tenant-routing.ts` with `resolveTenantByTwilioNumber()`.
  - Routing order is now: DB (`getClientByTwilioNumber`) -> in-memory legacy (`getTenant`) -> unresolved.
  - Added in-memory cache keyed by Twilio number with `TENANT_CACHE_TTL_MS = 5 * 60 * 1000`.
  - Cache stores hits/misses to avoid DB lookup on every call.
- Updated voice ingress behavior:
  - `src/index.ts` now serves both `POST /voice` and `POST /incoming-call` via shared handler.
  - Twilio stream params now include both `toNumber` and `calledNumber` from `req.body.To`.
  - `src/websocket/handler.ts` now resolves active tenant asynchronously through DB-backed resolver.
- Added cache invalidation on client updates:
  - Added `src/api/clients.ts` with `PATCH /api/clients/:id`.
  - Route updates client fields and invalidates tenant cache by client id and Twilio number.
- Seeded DVDS via seed script (migration-safe path):
  - Added `scripts/seed-dvds-client.ts`.
  - Script upserts DVDS client with:
    - `business_name`: Deer Valley Driving School
    - `twilio_number`: `+18773464394`
    - `subscription_status`: `active`
    - config copied from legacy DVDS tenant (`systemPrompt`, `greeting`, `ttsModel`, `sttModel`, `tools`).
  - Added npm script: `db:seed:dvds`.
- Transfer number wiring:
  - Added optional `transferNumber` to `TenantConfig` in `src/config/tenants.ts`.
  - Updated `src/tools/executor.ts` transfer flow to prefer `tenant.transferNumber` over `ownerCell`.
- Build verification:
  - `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Stripe checkout + webhook billing integration)
- Installed Stripe SDK dependency (`stripe`) and updated lockfile.
- Created live Stripe catalog entries:
  - Product: `Cadence AI Voice Agent` (`prod_U5IpNbrFPRzLlt`)
  - Monthly recurring price: `$199` (`price_1T78E6BxWKNs26XEDy0SFBaY`)
  - Trial behavior is enforced at checkout session creation (`trial_period_days: 7`).
- Added `src/api/stripe.ts` with:
  - `POST /api/stripe/checkout`
    - Accepts `email` + `businessName` (also accepts snake_case/clientEmail aliases).
    - Creates/fetches Stripe customer.
    - Creates/updates pending client row in DB.
    - Creates Stripe Checkout Session for subscription + 7-day trial.
    - Returns checkout `url`.
  - `POST /api/stripe/webhook`
    - Verifies Stripe signature using `STRIPE_WEBHOOK_SECRET` (falls back to provided `whsec_...` secret).
    - Handles:
      - `checkout.session.completed` (stores stripe ids, upserts subscription row, triggers inline provisioning hook)
      - `customer.subscription.updated` (syncs subscription + client status)
      - `customer.subscription.deleted` (deactivates client)
      - `invoice.payment_failed` (marks subscription past_due and deactivates client)
    - Deduplicates events using `stripe_events` table.
  - `POST /api/provision`
    - Internal provisioning trigger endpoint used by Stripe flow (currently acknowledges trigger and logs; safe no-op for voice routing).
- Updated `src/index.ts` route wiring:
  - Stripe webhook route uses `express.raw({ type: 'application/json' })` before JSON parsing to preserve signature verification integrity.
- Updated DB query layer (`src/db/queries.ts`):
  - Added `getClientByOwnerEmail`, `getClientByStripeCustomerId`, `getClientByStripeSubscriptionId`.
- Updated env handling and sample env:
  - Added `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`.
  - `.env.example` now includes `STRIPE_PRICE_ID=price_1T78E6BxWKNs26XEDy0SFBaY`.
- Safety note:
  - No changes were made to Twilio media stream voice routing logic (`/voice` + websocket handler remain intact).
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Cadence onboarding tenant + onboarding tools)
- Purchased Twilio onboarding number: `+14806313993` (`PN5c3815a122aab4bf631f0312a5bf8c02`).
- Set onboarding number voice webhook to `https://cadence-m48n.onrender.com/voice` (POST).
- Updated `src/config/tenants.ts`:
  - Added onboarding tenant `cadence-onboarding` mapped to `+14806313993`.
  - Added onboarding greeting, owner cell, tool allowlist (`save_onboarding_field`, `complete_onboarding`), and provided onboarding system prompt.
- Updated `src/llm/tools.ts`:
  - Added function schemas for `save_onboarding_field` and `complete_onboarding`.
  - Refactored to a tool-definition registry and exported tenant-scoped selection helper.
- Updated `src/llm/openai.ts`:
  - LLM tool exposure is now tenant-scoped via per-tenant allowlist.
- Updated `src/tools/executor.ts`:
  - Added `save_onboarding_field` (per-call in-memory field store).
  - Added `complete_onboarding` (builds onboarding JSON summary and sends SMS to `+16026633502`).
- Updated `src/websocket/handler.ts`:
  - Added per-call onboarding field state and passed it through tool execution context.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-03 (Neon DB schema + migrations + query layer)
- Added Postgres migration framework:
  - `db/migrations/001_init_schema.sql` with full Cadence schema from blueprint (`clients`, `subscriptions`, `stripe_events`, `call_logs`, `magic_link_tokens`) plus trigger function for `updated_at`.
  - Migration is legacy-safe: handles existing pre-schema `clients` table (renames `phone_number` → `twilio_number`, adds missing columns/defaults/indexes without dropping legacy data).
  - `db/migrate.ts` migration runner (tracks applied files in `schema_migrations`).
- Added DB runtime layer:
  - `src/db/client.ts` (`pg` pool singleton + query helpers).
  - `src/db/queries.ts` typed DB functions:
    - `getClientByTwilioNumber`
    - `getClientById`
    - `createClient`
    - `updateClient`
    - `deactivateClient`
    - `logCall`
    - `getCallLogs`
- Updated config/deps:
  - Added `pg` dependency and `@types/pg` dev dependency.
  - Added `db:migrate` npm script.
  - Added `DATABASE_URL` to `.env.example` and env parsing in `src/utils/env.ts`.
- Verification:
  - `npm run build` passed.
  - Ran migration against Neon using provided `DATABASE_URL`.
  - Verified new tables exist and `schema_migrations` includes `001_init_schema.sql`.
- Safety note:
  - No voice routing handler changes in this batch; existing in-memory tenant routing behavior remains untouched.


## 2026-03-02 (Dedicated SMS sender number for outbound texts)
- Updated `src/twilio/service.ts`:
  - Changed `sendSms` sender to prefer `env.TWILIO_SMS_NUMBER` and fall back to `env.TWILIO_PHONE_NUMBER`.
  - New send behavior: `from: env.TWILIO_SMS_NUMBER || env.TWILIO_PHONE_NUMBER`.
- Updated `src/utils/env.ts`:
  - Added `TWILIO_SMS_NUMBER` as an optional env var in `EnvSchema`.
- Rationale:
  - Allows outbound SMS to use local number `+19284477047` to avoid toll-free carrier block (`30032`) while preserving fallback behavior.
- Build verification: `npm run build` passed.
- Deployment note: add `TWILIO_SMS_NUMBER=+19284477047` in Render environment variables manually (not configurable from this repo).


## 2026-03-02 (Greeting barge-in guard + identity wording + SMS error logs)
- Updated `src/websocket/handler.ts`:
  - Added explicit `if (introPlaying) return;` guards in both Deepgram barge-in triggers (`onInterim`, `onSpeechStarted`) so ambient noise during greeting cannot interrupt intro playback.
  - Updated greeting line to: `"Hi, thanks for calling Deer Valley Driving School! This is Cadence, how can I help you today?"`.
  - Changed `ws.on('close')` to async close handler that logs SMS success/failure instead of silently swallowing errors.
  - Close flow now logs:
    - `logger.info({ to: '+16026633502' }, 'call summary SMS sent')`
    - `logger.error({ err }, 'call summary SMS failed')`
- Updated `src/conversation/system-prompt.ts`:
  - First line changed from AI identity wording to: `You are Cadence, a friendly receptionist for Deer Valley Driving School.`
- Updated `src/tools/executor.ts`:
  - Added `logger` import and wrapped `send_sms` execution in `try/catch` to log failures with destination number before rethrowing (`send_sms tool failed`).
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (3-note ascending filler chime on utterance_end)
- Updated `src/websocket/handler.ts`:
  - Added programmatic chime synthesis (Float32 PCM -> μ-law 8kHz mono) with note sequence:
    - C5 523Hz (120ms), 30ms gap
    - E5 659Hz (120ms), 30ms gap
    - G5 784Hz (150ms)
  - Added 10ms fade-in and 20ms fade-out envelopes per note to avoid clicks.
  - Set soft amplitude to `0.25`.
  - Chunked synthesized μ-law buffer into 20ms Twilio media frames (base64 payloads).
  - Added `playProcessingChime()` and invoked it in `onUtteranceEnd` immediately before `respond()` so LLM response generation begins right after chime playback starts.
  - Added guard to skip chime/response trigger when interruption state is active (`isSpeaking`/`speaking`) to preserve barge-in behavior.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Auto owner SMS on call close; remove notify_owner tool)
- Updated `src/websocket/handler.ts`:
  - Imported `sendSms` from `../twilio/service`.
  - Added automatic call-end SMS in `ws.on('close')` to `+16026633502` with:
    - Caller number (`callerNumber` fallback `Unknown`)
    - User turn count (number of `history` entries with `role === 'user'`)
    - Last user message truncated to 100 chars (fallback `N/A`)
  - Kept existing cleanup behavior (`activeTtsAbort?.abort(); dg.close();`).
  - Wrapped SMS send in non-blocking async `try/catch` so close path stays quiet on SMS failures.
- Updated `src/conversation/system-prompt.ts`:
  - Removed `notify_owner` guidance from TOOLS section.
- Updated `src/llm/tools.ts`:
  - Removed `notify_owner` function tool definition.
- Updated `src/tools/executor.ts`:
  - Removed `notify_owner` tool execution branch.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-01
- Fixed barge-in regression in src/websocket/handler.ts.
- Changed only onSpeechStarted behavior to ignore SpeechStarted while introPlaying is true, and only clear TTS when !introPlaying && speaking.
- This prevents ambient-noise SpeechStarted from cancelling greeting playback.
- Build verification: 
pm run build passed.
- Base commit before change: $sha.

## 2026-03-01 (TTS regression fix)
- Fixed response-audio drop race in src/websocket/handler.ts by moving speaking = true to after synthesizeMuLawBase64(text) resolves inside speakText().
- Added let responding = false; state in handleTwilioMedia and guarded onUtteranceEnd with if (responding) return; to prevent concurrent stacked 
espond() calls.
- Wrapped 
esponding lifecycle around wait respond() and reset in catch for safe re-entry after errors.
- Build verification: 
pm run build passed (TypeScript compile clean).
- Commit: 6c874a4



## 2026-03-01 (STT latency + SMS tool clarity)
- Reduced Deepgram live transcription latency in src/stt/deepgram.ts:
  - utterance_end_ms 1200 -> 800
  - endpointing 400 -> 250
- Updated tool definitions in src/llm/tools.ts:
  - Clarified 	ransfer_to_human usage (human requests/callback only)
  - Clarified send_sms usage for any texting request (booking link, pricing, info)
  - Removed phone from send_sms schema; now requires only message
- Updated TOOLS guidance in src/conversation/system-prompt.ts to enforce:
  - send_sms for all texting requests
  - 	ransfer_to_human only for explicit human/callback requests, never for texting
- Verified src/tools/executor.ts already falls back to ctx.callerNumber for send_sms; no change required.
- Build verification: 
pm run build passed (TypeScript compile clean).

## 2026-03-01 (Phase 1 latency streaming TTS + echo mute)
- Added streaming TTS generator `streamMuLawChunks` in `src/llm/openai.ts` using OpenAI streaming PCM response, 24kHz->8kHz downsampling reuse via existing `downsample24kTo8kPcm16`, and real-time �-law base64 frame yields.
- Updated `src/websocket/handler.ts`:
  - `speakText` now streams audio chunks from `streamMuLawChunks` and sets `speaking=true` only when first chunk is ready.
  - Greeting playback in Twilio `start` handler now streams greeting audio and computes `remainingPlayback` based on elapsed stream time.
  - Twilio `media` handler now guards Deepgram input with `if (!speaking)` to prevent echo-fed barge-in while TTS is playing.
- Kept `synthesizeMuLawBase64` intact in `src/llm/openai.ts` for compatibility.
- Did not modify `src/stt/deepgram.ts` endpointing/utterance settings.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-01 (Deepgram Aura-2 streaming TTS swap)
- Added `streamDeepgramTTS` in `src/llm/openai.ts` using raw `fetch` to Deepgram Speak API with `model=aura-2-thalia-en`, `encoding=mulaw`, `sample_rate=8000`, `container=none`.
- Kept existing `synthesizeMuLawBase64` and `streamMuLawChunks` intact for compatibility.
- Updated `src/websocket/handler.ts` to replace all `streamMuLawChunks` usage with `streamDeepgramTTS`:
  - import swap to `streamDeepgramTTS`
  - `speakText()` now streams from Deepgram TTS
  - greeting playback in `start` handler now streams from Deepgram TTS
- Did not modify STT (`src/stt/deepgram.ts`) or env/config.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-01 (System prompt brevity hardening for phone responses)
- Updated `src/conversation/system-prompt.ts` to enforce strict phone-call brevity behavior.
- Added a top-line CRITICAL instruction under `WHAT YOU DO` requiring 1-2 sentence spoken responses only, no lists/markdown.
- Replaced the `RULES` block with stricter constraints for one-answer + offer-to-text behavior and explicit package/location phrasing.
- Preserved all existing package/pricing/location/FAQ/business knowledge content exactly as-is.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Greeting echo window STT mute fix)
- Updated `src/websocket/handler.ts` in the Twilio `media` handler to gate Deepgram audio forwarding with `!speaking && !introPlaying`.
- This prevents STT from ingesting the tail of the greeting during the post-stream intro playback window.
- No other logic changes were made.
- Build verification: `npm run build` passed (TypeScript compile clean).
- Commit: `07b7817`

## 2026-03-02 (Regression fix: caller speech during intro tail)
- Updated `src/websocket/handler.ts`:
  - Reverted Twilio `media` forwarding gate from `if (!speaking && !introPlaying)` back to `if (!speaking)` so caller audio reaches Deepgram during the intro `remainingPlayback` window.
  - In the `introTimer` callback, added `finalParts = [];` when `introPlaying` flips false to discard intro-window transcript garbage.
- Rationale: keep STT intake open for caller barge-in while still suppressing intro artifacts via existing `if (introPlaying) return` on utterance end plus explicit `finalParts` reset.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Ticket-query handling + SMS phone validation)
- Updated `src/conversation/system-prompt.ts`:
  - Added FAQ entry clarifying DVDS does not offer defensive driving/ticket dismissal courses.
  - Added RULES instruction to respond directly to ticket/defensive-driving requests with a no, pivot to driving lessons, and **do not** refer callers to any other service/website/competitor.
- Updated `src/tools/executor.ts`:
  - In `send_sms`, added preflight phone validation and explicit non-throwing error response when no number is available: `{ ok: false, error: 'No phone number available to send SMS' }`.
- Updated `src/twilio/service.ts`:
  - Added `sendSms` guard that throws `No recipient phone number provided` if `phone` is empty.
- Updated `src/websocket/handler.ts`:
  - Added log line after stream parameter parse: `logger.info({ callerNumber }, 'caller number from stream params');`.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Prompt cleanup + owner summary tool + STT utterance latency)
- Updated `src/conversation/system-prompt.ts`:
  - Removed pushy rule requiring booking-link text offer before ending calls.
  - Replaced package rule to a one-line summary (`$200` to `$1,299`) and only offer texting details when caller asks or is ready to book.
  - Replaced no-list rule to only offer texting more info when caller asks.
  - Added TOOLS rule to call `notify_owner` once near call end with caller number and outcome.
- Updated `src/llm/tools.ts`:
  - Added `notify_owner` function tool schema with required `summary` string.
- Updated `src/tools/executor.ts`:
  - Added `notify_owner` handler to send SMS to `+16026633502` with prefix `📞 Cadence call summary:`.
- Updated `src/stt/deepgram.ts`:
  - Changed `utterance_end_ms` from `1200` to `900`.
  - Left `endpointing` unchanged at `400`.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Deepgram websocket stability rollback)
- Updated `src/stt/deepgram.ts`:
  - Changed `utterance_end_ms` from `900` back to `1200` to restore stable Deepgram WebSocket handshake/streaming behavior.
  - Left `endpointing` unchanged at `400`.
- Build verification: `npm run typecheck` passed (TypeScript compile clean).

## 2026-03-02 (Filler chime + barge-in interruption)
- Updated `src/websocket/handler.ts`:
  - Added generated filler chime utility (`generateChimeFramesBase64`) producing a short 8kHz mono μ-law tone (base64 Twilio media frames).
  - Added `playProcessingChime()` and invoked it only on `onUtteranceEnd` immediately before `respond()` (after user stops speaking).
  - Added explicit `isSpeaking` state for active response TTS playback, separate from existing `speaking` echo-gate behavior.
  - Added barge-in flow for `onInterim` and `onSpeechStarted` while `isSpeaking=true`: send Twilio `{ event: 'clear', streamSid }`, abort active TTS stream, reset speaking flags.
  - Added abortable TTS playback lifecycle with `AbortController` (`activeTtsAbort`) and stop/close cleanup.
- Updated `src/llm/openai.ts`:
  - Extended `streamDeepgramTTS(text, signal?)` to accept optional `AbortSignal` and pass it to `fetch` for cancellation.
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Remove filler chime, keep barge-in)
- Updated `src/websocket/handler.ts`:
  - Removed filler chime generation utility (`generateChimeFramesBase64`) and chime playback helper.
  - Removed chime playback call from `onUtteranceEnd` before `respond()`.
  - Kept barge-in/interruptibility logic intact (`isSpeaking`, `onInterim`/`onSpeechStarted`, `AbortController` cancellation flow).
- Build verification: `npm run build` passed (TypeScript compile clean).

## 2026-03-02 (Aura-2 WebSocket streaming + sentence chunking)
- Updated `src/llm/openai.ts`:
  - Added `runAgentStream(messages, onToken)` using OpenAI chat streaming (`stream: true`) while preserving existing `runAgent()`.
  - Replaced `streamDeepgramTTS` implementation with Aura-2 WebSocket streaming (`wss://api.deepgram.com/v1/speak?...`).
  - Implemented sentence-boundary chunking (`.`, `?`, `!` followed by whitespace/end) and sends `{ type: 'Speak', text }` + `{ type: 'Flush' }` per sentence.
  - Sends `{ type: 'Close' }` after final flush.
  - Added REST fallback path (`https://api.deepgram.com/v1/speak`) when WebSocket path fails before audio starts.
- Updated `src/websocket/handler.ts`:
  - `respond()` now streams LLM tokens through an async queue into `streamDeepgramTTS` for immediate TTS generation.
  - Twilio media frames are forwarded from Deepgram WebSocket audio callbacks as base64 μ-law payloads.
  - Preserved abort/barge-in behavior: abort closes active TTS stream, stops forwarding, and retains `isSpeaking`/`speaking` semantics.
  - Preserved 3-note chime flow (`playProcessingChime()` still runs before `respond()`).
  - Greeting playback updated to use new `streamDeepgramTTS` async text-stream interface.
- STT timing untouched (`utterance_end_ms` remains 1200).
- Build verification: `npm run build` passed (TypeScript compile clean).
