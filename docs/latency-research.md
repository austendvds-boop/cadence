# Cadence Latency Research Report

**Research Date:** March 1, 2026
**Current Pipeline Latency:** ~5-7 seconds
**Target Latency:** <3 seconds

---

## Executive Summary

The highest-impact wins for reducing latency are:

1. **Streaming TTS** (OpenAI TTS supports chunk transfer encoding) — can reduce TTS latency from ~2-3s to ~0.3-0.5s time-to-first-audio
2. **Streaming LLM ? TTS pipeline** — sentence-level streaming can overlap LLM generation with TTS synthesis
3. **Echo cancellation / barge-in fix** — use Twilio's `clear` message + mute Deepgram stream during TTS playback

---

## 1. Streaming TTS with OpenAI

### Can OpenAI TTS Stream Audio Chunks?

**Yes.** OpenAI's Speech API supports real-time audio streaming using HTTP chunk transfer encoding. The audio can be played before the full file is generated.

### Node.js Implementation Pattern

```javascript
import OpenAI from 'openai';

const openai = new OpenAI();

// Stream TTS audio chunks as they're generated
async function streamTTS(text, ws, streamSid) {
  const response = await openai.audio.speech.with_streaming_response.create({
    model: 'gpt-4o-mini-tts',  // or 'tts-1' for lower latency
    voice: 'alloy',
    input: text,
    response_format: 'pcm',     // Raw PCM 24kHz, no header overhead
  });

  // Pipe chunks to Twilio as they arrive
  for await (const chunk of response.body) {
    const mulawChunk = convertPcmToMulaw(chunk);
    ws.send(JSON.stringify({
      event: 'media',
      streamSid: streamSid,
      media: { payload: mulawChunk.toString('base64') }
    }));
  }
}
```

### Response Formats for Low Latency

| Format | Latency | Notes |
|--------|---------|-------|
| `pcm` | **Fastest** | Raw samples 24kHz, 16-bit signed little-endian |
| `wav` | Fast | Uncompressed, suitable for low-latency |
| `mp3` | Slower | Default, requires decoding overhead |

**TTFB Expectations:**
- OpenAI TTS (`tts-1`): ~200-400ms
- OpenAI TTS (`gpt-4o-mini-tts`): ~300-500ms

---

## 2. Streaming LLM ? Streaming TTS Pipeline

**Yes, this is the key to sub-3-second response times.**

### Sentence Boundary Detection

```javascript
class SentenceStream {
  constructor() {
    this.buffer = '';
    this.sentenceRegex = /[^.!?]+[.!?]+(\s|$)/g;
  }

  push(text) {
    this.buffer += text;
    const sentences = [];
    let match;
    while ((match = this.sentenceRegex.exec(this.buffer)) !== null) {
      sentences.push(match[0].trim());
    }
    const lastIndex = this.sentenceRegex.lastIndex;
    this.buffer = this.buffer.slice(lastIndex);
    this.sentenceRegex.lastIndex = 0;
    return sentences;
  }
}
```

**Latency improvement:** Instead of `LLM (~1s) + TTS (~2s) = 3s sequential`, you get `~0.3s (first sentence) + streaming overlap` = sub-2s perceived latency.

---

## 3. Deepgram Endpointing Issue (250ms vs 400ms)

### Why Does endpointing=250 Reject?

- **Default endpointing:** 10ms (surprisingly low)
- Possible causes: Plan restrictions, model-specific limits, or SDK validation

### Workarounds

```javascript
const dgConfig = {
  model: 'nova-3',
  endpointing: 300,          // Try 300ms instead of 250ms
  utterance_end_ms: 800,     // Faster than 1200ms
  interim_results: true,
};
```

---

## 4. Alternative Low-Latency TTS Options

| Provider | Model | TTFB | µ-law 8kHz | Notes |
|----------|-------|------|------------|-------|
| **Deepgram Aura-2** | aura-2 | ~150-200ms | **Native** | Built for voice agents |
| **OpenAI TTS** | tts-1 | ~200-400ms | Convert | Good quality |
| **Cartesia Sonic 3** | sonic-3 | **~40-90ms** | Convert | Fastest TTFB |
| **ElevenLabs** | Flash v2.5 | ~200-300ms | Convert | Good quality |

**Recommendation:** Use **Deepgram Aura-2** for easiest Twilio integration (native µ-law) or **Cartesia Sonic-3** for absolute lowest latency.

---

## 5. Acoustic Echo / False Barge-in Fix

### The Problem

TTS audio ? phone speaker ? mic picks it up ? Deepgram transcribes ? false barge-in

### Solution: Twilio Clear Message

From Deepgram's official example:

```javascript
if (decoded.type === 'UserStartedSpeaking') {
  const clear_message = {
    event: 'clear',
    streamSid: streamsid
  };
  await twilio_ws.send(JSON.stringify(clear_message));
}
```

Also set `isPlayingTTS` flag to ignore transcripts during playback.

---

## 6. Deepgram Nova-3 vs Nova-2

**No significant latency difference.** Per Deepgram: "Nova-3 delivers comparable latency to Nova-2."

**Benefits:** 53.4% lower WER, Keyterm Prompting, multilingual support.

**Available on Free/Starter Plan:** Yes.

---

## Implementation Roadmap

### Phase 1: Quick Wins
1. Implement Twilio `clear` message for barge-in
2. Switch OpenAI TTS to `response_format: 'pcm'`

### Phase 2: Streaming TTS
3. Implement `with_streaming_response.create()`
4. Stream chunks directly to Twilio

### Phase 3: Full Pipeline
5. Implement sentence-level LLM?TTS streaming
6. Evaluate Deepgram Aura-2 for native µ-law output

### Expected Latency

| Stage | Latency |
|-------|---------|
| Current | 5-7 seconds |
| After Phase 2 | 3-4 seconds |
| After Phase 3 | **1.5-2.5 seconds** |

---

## Key Resources

1. OpenAI TTS Streaming: https://platform.openai.com/docs/guides/text-to-speech#streaming-realtime-audio
2. Deepgram Echo Cancellation: https://developers.deepgram.com/docs/voice-agent-echo-cancellation
3. Twilio WebSocket Messages: https://www.twilio.com/docs/voice/media-streams/websocket-messages
4. Deepgram Twilio Example: https://github.com/deepgram-devs/sts-twilio
5. Research Paper: https://arxiv.org/html/2508.04721v1

---

*Report compiled by Researcher Agent*
