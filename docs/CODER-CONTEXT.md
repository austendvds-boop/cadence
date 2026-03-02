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
- Commit: <pending>

