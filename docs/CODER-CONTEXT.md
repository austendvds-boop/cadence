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
- Added let responding = false; state in handleTwilioMedia and guarded onUtteranceEnd with if (responding) return; to prevent concurrent stacked espond() calls.
- Wrapped esponding lifecycle around wait respond() and reset in catch for safe re-entry after errors.
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
- Added streaming TTS generator `streamMuLawChunks` in `src/llm/openai.ts` using OpenAI streaming PCM response, 24kHz->8kHz downsampling reuse via existing `downsample24kTo8kPcm16`, and real-time µ-law base64 frame yields.
- Updated `src/websocket/handler.ts`:
  - `speakText` now streams audio chunks from `streamMuLawChunks` and sets `speaking=true` only when first chunk is ready.
  - Greeting playback in Twilio `start` handler now streams greeting audio and computes `remainingPlayback` based on elapsed stream time.
  - Twilio `media` handler now guards Deepgram input with `if (!speaking)` to prevent echo-fed barge-in while TTS is playing.
- Kept `synthesizeMuLawBase64` intact in `src/llm/openai.ts` for compatibility.
- Did not modify `src/stt/deepgram.ts` endpointing/utterance settings.
- Build verification: `npm run build` passed (TypeScript compile clean).
