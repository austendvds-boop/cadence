# Coder Context

## 2026-03-01
- Fixed barge-in regression in src/websocket/handler.ts.
- Changed only onSpeechStarted behavior to ignore SpeechStarted while introPlaying is true, and only clear TTS when !introPlaying && speaking.
- This prevents ambient-noise SpeechStarted from cancelling greeting playback.
- Build verification: 
pm run build passed.
- Base commit before change: $sha.
