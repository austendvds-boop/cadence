# Coder Context

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
