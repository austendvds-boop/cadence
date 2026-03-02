import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { createDeepgramBridge } from '../stt/deepgram';
import { runAgent, streamDeepgramTTS, type ChatMsg } from '../llm/openai';
import { executeTool } from '../tools/executor';
import { sendSms } from '../twilio/service';

type TwilioMsg = { event: string; streamSid?: string; start?: any; media?: { payload: string } };

const CHIME_FRAME_SAMPLES = 160; // 20ms @ 8kHz

function encodePcm16ToMuLaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.max(-1, Math.min(1, sample));
  let pcm16 = Math.round(pcm * 32767);

  let sign = 0;
  if (pcm16 < 0) {
    sign = 0x80;
    pcm16 = -pcm16;
  }

  if (pcm16 > CLIP) pcm16 = CLIP;
  pcm16 += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm16 & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (pcm16 >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function appendSineWithEnvelope(
  out: number[],
  freqHz: number,
  durationMs: number,
  sampleRate: number,
  amplitude: number,
  fadeInMs: number,
  fadeOutMs: number
) {
  const totalSamples = Math.round((durationMs / 1000) * sampleRate);
  const fadeInSamples = Math.max(1, Math.round((fadeInMs / 1000) * sampleRate));
  const fadeOutSamples = Math.max(1, Math.round((fadeOutMs / 1000) * sampleRate));

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let env = 1;
    if (i < fadeInSamples) env = i / fadeInSamples;
    const samplesFromEnd = totalSamples - 1 - i;
    if (samplesFromEnd < fadeOutSamples) env = Math.min(env, samplesFromEnd / fadeOutSamples);
    out.push(Math.sin(2 * Math.PI * freqHz * t) * amplitude * Math.max(0, env));
  }
}

function appendSilence(out: number[], durationMs: number, sampleRate: number) {
  const silenceSamples = Math.round((durationMs / 1000) * sampleRate);
  for (let i = 0; i < silenceSamples; i++) out.push(0);
}

function generateAscendingChimeFramesBase64(): string[] {
  const sampleRate = 8000;
  const amplitude = 0.25;
  const fadeInMs = 10;
  const fadeOutMs = 20;
  const gapMs = 30;

  const pcm: number[] = [];
  appendSineWithEnvelope(pcm, 523, 120, sampleRate, amplitude, fadeInMs, fadeOutMs);
  appendSilence(pcm, gapMs, sampleRate);
  appendSineWithEnvelope(pcm, 659, 120, sampleRate, amplitude, fadeInMs, fadeOutMs);
  appendSilence(pcm, gapMs, sampleRate);
  appendSineWithEnvelope(pcm, 784, 150, sampleRate, amplitude, fadeInMs, fadeOutMs);

  const floatPcm = Float32Array.from(pcm);
  const muLaw = Buffer.alloc(floatPcm.length);
  for (let i = 0; i < floatPcm.length; i++) muLaw[i] = encodePcm16ToMuLaw(floatPcm[i]);

  const frames: string[] = [];
  for (let offset = 0; offset < muLaw.length; offset += CHIME_FRAME_SAMPLES) {
    frames.push(muLaw.subarray(offset, Math.min(offset + CHIME_FRAME_SAMPLES, muLaw.length)).toString('base64'));
  }

  return frames;
}

const ASCENDING_CHIME_FRAMES = generateAscendingChimeFramesBase64();

export function handleTwilioMedia(ws: WebSocket) {
  let streamSid = '';
  let callSid = '';
  let callerNumber = '';
  let finalParts: string[] = [];
  let speaking = false;
  let isSpeaking = false;
  let introPlaying = false;
  let introTimer: ReturnType<typeof setTimeout> | null = null;
  let responding = false;
  let activeTtsAbort: AbortController | null = null;
  const history: ChatMsg[] = [];

  function bargeIn(reason: 'interim' | 'speech_started') {
    if (!isSpeaking || introPlaying) return;
    logger.info({ reason }, 'barge-in: clearing outbound audio');
    ws.send(JSON.stringify({ event: 'clear', streamSid }));
    activeTtsAbort?.abort();
    activeTtsAbort = null;
    isSpeaking = false;
    speaking = false;
  }

  function playProcessingChime() {
    if (!streamSid) return;
    ASCENDING_CHIME_FRAMES.forEach((payload, index) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
      }, index * 20);
    });
  }

  async function speakText(text: string) {
    const controller = new AbortController();
    activeTtsAbort?.abort();
    activeTtsAbort = controller;
    isSpeaking = true;

    try {
      let started = false;
      for await (const payload of streamDeepgramTTS(text, controller.signal)) {
        if (!started) {
          speaking = true;
          started = true;
        }
        if (!isSpeaking || !speaking) break;
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') throw err;
    } finally {
      if (activeTtsAbort === controller) activeTtsAbort = null;
      isSpeaking = false;
      speaking = false;
    }
  }

  const dg = createDeepgramBridge({
    onInterim: (t) => {
      if (isSpeaking && t.trim().length > 0) {
        bargeIn('interim');
      }
    },
    onFinal: (t) => {
      logger.info({ transcript: t }, 'STT final');
      finalParts.push(t);
    },
    onUtteranceEnd: async () => {
      try {
        if (introPlaying) return;
        if (responding) return;
        if (isSpeaking || speaking) return;
        const utterance = finalParts.join(' ').trim();
        finalParts = [];
        if (!utterance) return;
        logger.info({ utterance }, 'utterance end — play chime and call LLM');
        history.push({ role: 'user', content: utterance });
        playProcessingChime();
        responding = true;
        await respond();
        responding = false;
      } catch (err) {
        responding = false;
        logger.error({ err }, 'onUtteranceEnd error');
      }
    },
    onSpeechStarted: () => {
      if (isSpeaking) {
        bargeIn('speech_started');
      }
    }
  });

  async function respond(depth = 0) {
    try {
      if (depth > 5) {
        await speakText("I'm having some trouble right now. Let me connect you with Austen.");
        await executeTool('transfer_to_human', {}, { callSid, callerNumber });
        return;
      }

      const msg = await runAgent(history);
      logger.info({ hasToolCalls: !!(msg?.tool_calls?.length), content: msg?.content?.slice(0, 80) }, 'LLM response');
      if (!msg) return;

      if (msg.tool_calls?.length) {
        history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls } as any);
        for (const c of msg.tool_calls as any[]) {
          if (c.type !== 'function' || !c.function) continue;
          const args = JSON.parse(c.function.arguments || '{}');
          logger.info({ tool: c.function.name, args }, 'tool call');
          try {
            const result = await executeTool(c.function.name, args, { callSid, callerNumber });
            history.push({ role: 'tool', name: c.function.name, tool_call_id: c.id, content: JSON.stringify(result) });
          } catch (toolErr) {
            logger.error({ err: toolErr, tool: c.function.name }, 'tool execution failed');
            history.push({
              role: 'tool',
              name: c.function.name,
              tool_call_id: c.id,
              content: JSON.stringify({ error: 'Tool execution failed' })
            });
          }
        }
        return respond(depth + 1);
      }

      const text = msg.content || 'Sorry, I had trouble with that. Let me connect you with Austen.';
      history.push({ role: 'assistant', content: text });
      await speakText(text);
    } catch (err) {
      logger.error({ err }, 'respond() error');
      try {
        await speakText('Sorry, I ran into a technical issue. Let me connect you with someone who can help.');
        await executeTool('transfer_to_human', {}, { callSid, callerNumber });
      } catch (_) {
        ws.close();
      }
    }
  }

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString()) as TwilioMsg;
    if (msg.event === 'start') {
      try {
        streamSid = msg.start?.streamSid;
        callSid = msg.start?.callSid;
        callerNumber = msg.start?.customParameters?.callerNumber || '';
        logger.info({ callerNumber }, 'caller number from stream params');
        if (callerNumber) {
          history.push({
            role: 'system',
            content: `The caller's phone number is ${callerNumber}. Use this exact number for any send_sms tool calls.`
          } as any);
        }
        logger.info({ streamSid, callSid, callerNumber }, 'Twilio stream started');

        const greeting = "Hi, thanks for calling Deer Valley Driving School! I'm an AI assistant. I can answer questions about our packages and pricing, or text you a link to book online. How can I help you today?";
        history.push({ role: 'assistant', content: greeting });

        introPlaying = true;
        speaking = true;
        const streamStart = Date.now();
        let chunkCount = 0;
        for await (const payload of streamDeepgramTTS(greeting)) {
          if (!introPlaying) break;
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
          chunkCount++;
        }
        const streamDuration = Date.now() - streamStart;
        const remainingPlayback = Math.max(chunkCount * 20 - streamDuration + 800, 800);
        logger.info({ chunks: chunkCount, streamDurationMs: streamDuration, remainingPlayback }, 'greeting sent');
        speaking = false;
        await new Promise<void>(r => {
          introTimer = setTimeout(() => { introPlaying = false; finalParts = []; introTimer = null; r(); }, remainingPlayback);
        });
      } catch (err) {
        logger.error({ err }, 'start event error');
        ws.close();
      }
    }
    if (msg.event === 'media' && msg.media?.payload) {
      if (!speaking) {
        dg.sendMulaw(Buffer.from(msg.media.payload, 'base64'));
      }
      logger.debug('incoming audio packet');
    }
    if (msg.event === 'stop') {
      activeTtsAbort?.abort();
      dg.close();
      ws.close();
    }
  });

  ws.on('close', () => {
    const userTurns = history.filter((m) => m.role === 'user').length;
    const lastUserMsg = [...history].reverse().find((m) => m.role === 'user')?.content;
    const lastTopicRaw = typeof lastUserMsg === 'string' ? lastUserMsg.trim() : '';
    const lastTopic = lastTopicRaw ? (lastTopicRaw.length > 100 ? `${lastTopicRaw.slice(0, 100)}...` : lastTopicRaw) : 'N/A';
    const summary = `📞 Cadence call ended\nCaller: ${callerNumber || 'Unknown'}\nTurns: ${userTurns}\nLast topic: ${lastTopic}`;

    void (async () => {
      try {
        await sendSms('+16026633502', summary);
      } catch (_) {
        // Ignore SMS errors on close to avoid noisy shutdown paths.
      }
    })();

    activeTtsAbort?.abort();
    dg.close();
  });
}
