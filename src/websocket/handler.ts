import { WebSocket } from 'ws';
import { resolveTenantForIncomingNumber } from '../config/tenant-routing';
import { normalizePhoneNumber, type TenantConfig } from '../config/tenants';
import { getClientByTwilioNumber, upsertCallLog } from '../db/queries';
import { runAgentStream, streamDeepgramTTS, type ChatMsg } from '../llm/openai';
import { createDeepgramBridge, type DeepgramBridge } from '../stt/deepgram';
import { executeTool } from '../tools/executor';
import { sendSms } from '../twilio/service';
import { logger } from '../utils/logger';

type TwilioStartMessage = {
  streamSid?: string;
  callSid?: string;
  customParameters?: Record<string, string | undefined>;
};

type TwilioMsg = {
  event: string;
  streamSid?: string;
  start?: TwilioStartMessage;
  media?: { payload: string };
  mark?: { name?: string };
};

function getStartParameter(start: TwilioStartMessage | undefined, keys: string[]): string {
  const params = start?.customParameters;
  if (!params) return '';

  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function parseJsonSafe<T>(raw: string, source: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.error({ err, source, raw: raw.slice(0, 500) }, 'JSON parse failed');
    return null;
  }
}

function safeSend(ws: WebSocket, data: string, source: string) {
  if (ws.readyState !== WebSocket.OPEN) {
    logger.warn({ source, readyState: ws.readyState }, 'WebSocket not open; skipping send');
    return;
  }

  try {
    ws.send(data, (err) => {
      if (err) {
        logger.error({ err, source }, 'WebSocket send callback error');
      }
    });
  } catch (err) {
    logger.error({ err, source }, 'WebSocket send threw');
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.message.toLowerCase().includes('abort');
  }
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: string }).name === 'AbortError';
  }
  return false;
}

const TWILIO_MULAW_BYTES_PER_SECOND = 8000;
const TWILIO_MEDIA_FRAME_BYTES = 160; // 20ms @ 8kHz @ 8-bit mulaw
const CHIME_FRAME_SAMPLES = TWILIO_MEDIA_FRAME_BYTES;

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

function oneChunkStream(text: string): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      if (text) yield text;
    }
  };
}

function condenseText(text: string, maxLen = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 3))}...`;
}

function buildTranscriptSummary(transcriptSegments: string[], userMessages: string[]): string | null {
  const source = transcriptSegments.length > 0 ? transcriptSegments : userMessages;
  if (source.length === 0) return null;

  const condensed = condenseText(source.slice(-4).join(' '), 220);
  if (!condensed) return null;

  return /[.!?]$/.test(condensed) ? condensed : `${condensed}.`;
}

function extractClientIdFromTenant(tenant: TenantConfig | undefined): string {
  if (!tenant?.id?.startsWith('client-')) {
    return '';
  }

  return tenant.id.slice('client-'.length);
}

async function resolveClientIdForCall(tenant: TenantConfig | undefined, toNumber: string): Promise<string> {
  const tenantClientId = extractClientIdFromTenant(tenant);
  if (tenantClientId) {
    return tenantClientId;
  }

  const normalizedToNumber = normalizePhoneNumber(toNumber || tenant?.twilioNumber || '');
  if (!normalizedToNumber) {
    return '';
  }

  const dbClient = await getClientByTwilioNumber(normalizedToNumber);
  return dbClient?.id || '';
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function inferInterestLevel(userMessages: string[]): 'High' | 'Medium' | 'Low' {
  const text = userMessages.join(' ').toLowerCase();
  if (!text) return 'Low';

  const highSignals = [
    'book',
    'booking',
    'schedule',
    'sign up',
    'sign-up',
    'enroll',
    'enrol',
    'register',
    'buy',
    'purchase',
    'pay',
    'checkout',
    'availability',
    'available',
    'dates',
    'times',
    'how do i book',
    'can i book',
    'set up'
  ];

  const mediumSignals = [
    'price',
    'pricing',
    'cost',
    'package',
    'lessons',
    'hours',
    'permit',
    'road test',
    'waiver',
    'insurance',
    'discount',
    'reschedule',
    'cancel',
    'location',
    'area',
    'city',
    'spanish',
    'special needs',
    'esa',
    'classwallet'
  ];

  const lowSignals = ['not interested', 'just looking', 'just curious', 'calling around', 'price shopping', 'complaint', 'refund'];

  let score = 0;
  if (highSignals.some((s) => text.includes(s))) score += 2;
  if (mediumSignals.some((s) => text.includes(s))) score += 1;
  if (lowSignals.some((s) => text.includes(s))) score -= 2;

  if (score >= 2) return 'High';
  if (score >= 1) return 'Medium';
  return 'Low';
}

function inferMainTopic(userMessages: string[]): string {
  const text = userMessages.join(' ').toLowerCase();
  if (!text) return 'General inquiry';

  const topics: { topic: string; keywords: string[] }[] = [
    { topic: 'License-Ready Package', keywords: ['license ready', 'license-ready'] },
    { topic: 'Ultimate Package', keywords: ['ultimate'] },
    { topic: 'Intro Package', keywords: ['intro package', 'intro to driving', 'intro'] },
    { topic: 'Express Package', keywords: ['express'] },
    { topic: 'Sibling deal', keywords: ['sibling'] },
    { topic: 'Pricing', keywords: ['price', 'pricing', 'cost', 'how much'] },
    { topic: 'Booking and scheduling', keywords: ['book', 'booking', 'schedule', 'availability', 'date', 'time', 'checkout'] },
    {
      topic: 'Service area',
      keywords: [
        'area',
        'location',
        'city',
        'serve',
        'phoenix',
        'mesa',
        'scottsdale',
        'glendale',
        'tempe',
        'gilbert',
        'chandler',
        'goodyear',
        'peoria',
        'surprise',
        'avondale',
        'buckeye',
        'queen creek',
        'san tan',
        'anthem',
        'cave creek',
        'north phoenix'
      ]
    },
    { topic: 'Permit', keywords: ['permit', 'servicearizona', 'mvd'] },
    { topic: 'Road test waiver', keywords: ['waiver', 'road test', 'roadtest', 'mvd test'] },
    { topic: 'Insurance certificate', keywords: ['insurance', 'discount'] },
    { topic: 'Reschedule or cancel', keywords: ['reschedule', 'cancel'] },
    { topic: 'Spanish instructor', keywords: ['spanish'] },
    { topic: 'Special needs', keywords: ['special needs', 'disability', 'accommodation'] },
    { topic: 'ESA / ClassWallet', keywords: ['esa', 'classwallet', 'scholarship'] },
    { topic: 'Complaints or refunds', keywords: ['complaint', 'refund'] }
  ];

  for (const entry of topics) {
    if (entry.keywords.some((k) => text.includes(k))) return entry.topic;
  }

  return 'General inquiry';
}

function createAsyncTextQueue() {
  const queue: string[] = [];
  let done = false;
  let waiter: (() => void) | null = null;

  return {
    push(text: string) {
      if (!text) return;
      queue.push(text);
      const w = waiter;
      waiter = null;
      w?.();
    },
    close() {
      done = true;
      const w = waiter;
      waiter = null;
      w?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              waiter = resolve;
            });
            continue;
          }
          yield queue.shift() as string;
        }
      }
    } as AsyncIterable<string>
  };
}

export function handleTwilioMedia(ws: WebSocket) {
  let streamSid = '';
  let callSid = '';
  let callerNumber = '';
  let toNumber = '';
  let activeTenant: TenantConfig | undefined;
  let dg: DeepgramBridge | null = null;
  let finalParts: string[] = [];
  let speaking = false;
  let isSpeaking = false;
  let introPlaying = false;
  let responding = false;
  let drainingUtterances = false;
  let activeLlmAbort: AbortController | null = null;
  let activeTtsAbort: AbortController | null = null;
  let markCounter = 0;
  const pendingPlaybackMarks = new Map<
    string,
    {
      bytesSent: number;
      expectedDurationMs: number;
      timeout: ReturnType<typeof setTimeout>;
      resolve: () => void;
    }
  >();
  const pendingUtterances: string[] = [];
  const history: ChatMsg[] = [];
  const onboardingFields: Record<string, string> = {};
  const transcriptSegments: string[] = [];
  let callStartedAtMs: number | null = null;
  let sttUnavailableLogged = false;

  function resolvePendingPlaybackMarks(reason: string) {
    for (const [markName, pending] of Array.from(pendingPlaybackMarks.entries())) {
      clearTimeout(pending.timeout);
      pendingPlaybackMarks.delete(markName);
      pending.resolve();
      logger.debug({ markName, reason }, 'resolved pending Twilio playback mark');
    }
  }

  function waitForTwilioPlaybackMark(
    markName: string,
    bytesSent: number,
    expectedDurationMs: number,
    remainingPlaybackMs: number,
    signal: AbortSignal
  ): Promise<void> {
    if (!streamSid || signal.aborted) return Promise.resolve();

    const graceMs = Math.max(20, Math.ceil(expectedDurationMs * 0.1));
    const timeoutMs = Math.max(20, Math.ceil(remainingPlaybackMs + graceMs));

    return new Promise<void>((resolve) => {
      let settled = false;

      const finish = (source: 'mark' | 'timeout' | 'abort') => {
        if (settled) return;
        settled = true;

        signal.removeEventListener('abort', onAbort);
        const pending = pendingPlaybackMarks.get(markName);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingPlaybackMarks.delete(markName);
        }

        if (source === 'timeout') {
          logger.warn(
            { markName, bytesSent, expectedDurationMs, remainingPlaybackMs, timeoutMs },
            'Twilio mark timeout; falling back to byte-count playback duration'
          );
        }

        resolve();
      };

      const onAbort = () => finish('abort');
      signal.addEventListener('abort', onAbort, { once: true });

      const timeout = setTimeout(() => finish('timeout'), timeoutMs);
      pendingPlaybackMarks.set(markName, {
        bytesSent,
        expectedDurationMs,
        timeout,
        resolve: () => finish('mark')
      });

      safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } }), 'tts_playback_mark_send');
    });
  }

  function createPacedMediaSender(signal: AbortSignal) {
    let carryover = Buffer.alloc(0);
    let sendChain: Promise<void> = Promise.resolve();
    let nextFrameAt = Date.now();
    let bytesSent = 0;
    let firstFrameSentAt: number | null = null;

    const queueFrame = (frame: Buffer) => {
      sendChain = sendChain.then(async () => {
        if (signal.aborted) return;

        const now = Date.now();
        const waitMs = Math.max(0, nextFrameAt - now);
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
          if (signal.aborted) return;
        }

        safeSend(
          ws,
          JSON.stringify({ event: 'media', streamSid, media: { payload: frame.toString('base64') } }),
          'tts_stream_media'
        );

        const sendTime = Date.now();
        if (firstFrameSentAt === null) {
          firstFrameSentAt = sendTime;
          nextFrameAt = sendTime;
        }

        bytesSent += frame.length;
        const frameDurationMs = (frame.length / TWILIO_MULAW_BYTES_PER_SECOND) * 1000;
        nextFrameAt = Math.max(nextFrameAt + frameDurationMs, sendTime);
      });
    };

    return {
      push(base64Payload: string) {
        if (signal.aborted || !base64Payload) return;

        const incoming = Buffer.from(base64Payload, 'base64');
        if (incoming.length === 0) return;

        const chunk = carryover.length ? Buffer.concat([carryover, incoming]) : incoming;
        let offset = 0;

        while (offset + TWILIO_MEDIA_FRAME_BYTES <= chunk.length) {
          queueFrame(chunk.subarray(offset, offset + TWILIO_MEDIA_FRAME_BYTES));
          offset += TWILIO_MEDIA_FRAME_BYTES;
        }

        carryover = chunk.subarray(offset);
      },
      async flush() {
        if (!signal.aborted && carryover.length > 0) {
          queueFrame(carryover);
          carryover = Buffer.alloc(0);
        }

        await sendChain;
        return { bytesSent, firstFrameSentAt };
      }
    };
  }

  function abortActiveResponse(reason: string) {
    let aborted = false;

    if (activeLlmAbort && !activeLlmAbort.signal.aborted) {
      activeLlmAbort.abort();
      activeLlmAbort = null;
      aborted = true;
    }

    if (activeTtsAbort && !activeTtsAbort.signal.aborted) {
      activeTtsAbort.abort();
      activeTtsAbort = null;
      aborted = true;
    }

    if (isSpeaking || speaking) {
      safeSend(ws, JSON.stringify({ event: 'clear', streamSid }), 'abort_active_response_clear');
      isSpeaking = false;
      speaking = false;
      aborted = true;
    }

    if (aborted) {
      resolvePendingPlaybackMarks(reason);
      logger.info({ reason }, 'barge-in: aborted in-flight response');
    }
  }

  function bargeIn(reason: 'speech_started' | 'interim_transcript' | 'final_transcript' | 'queued_utterance') {
    if (!responding || introPlaying) return;
    abortActiveResponse(reason);
  }

  function enqueueUtterance(utterance: string) {
    pendingUtterances.push(utterance);
    logger.info({ utterance, queueLength: pendingUtterances.length }, 'Queued caller utterance');
  }

  async function drainUtteranceQueue() {
    if (drainingUtterances) return;

    drainingUtterances = true;
    try {
      while (pendingUtterances.length > 0) {
        const utterance = pendingUtterances.shift();
        if (!utterance) continue;

        logger.info({ utterance, remainingQueue: pendingUtterances.length }, 'Processing caller utterance');
        history.push({ role: 'user', content: utterance });
        playProcessingChime();

        responding = true;
        try {
          await respond();
        } finally {
          responding = false;
          activeLlmAbort = null;
          activeTtsAbort = null;
        }
      }
    } finally {
      drainingUtterances = false;
      if (pendingUtterances.length > 0) {
        void drainUtteranceQueue();
      }
    }
  }

  function playProcessingChime() {
    if (!streamSid) return;
    ASCENDING_CHIME_FRAMES.forEach((payload, index) => {
      setTimeout(() => {
        safeSend(ws, JSON.stringify({ event: 'media', streamSid, media: { payload } }), 'processing_chime_media');
      }, index * 20);
    });
  }

  async function speakFromStream(textStream: AsyncIterable<string>, markLabel = 'tts') {
    const controller = new AbortController();
    activeTtsAbort?.abort();
    activeTtsAbort = controller;
    isSpeaking = false;

    const pacedSender = createPacedMediaSender(controller.signal);

    try {
      await streamDeepgramTTS(
        textStream,
        (payload) => {
          if (controller.signal.aborted) return;
          if (!isSpeaking) {
            isSpeaking = true;
            speaking = true;
          }
          if (!isSpeaking || !speaking) return;
          pacedSender.push(payload);
        },
        { signal: controller.signal, model: activeTenant?.ttsModel }
      );

      const { bytesSent, firstFrameSentAt } = await pacedSender.flush();
      if (!controller.signal.aborted && bytesSent > 0 && firstFrameSentAt !== null) {
        const expectedDurationMs = (bytesSent / TWILIO_MULAW_BYTES_PER_SECOND) * 1000;
        const elapsedMs = Date.now() - firstFrameSentAt;
        const remainingPlaybackMs = Math.max(0, expectedDurationMs - elapsedMs);
        const markName = `${markLabel}-${Date.now()}-${++markCounter}`;

        logger.info(
          { markName, bytesSent, expectedDurationMs, remainingPlaybackMs },
          'waiting for Twilio playback completion mark'
        );

        await waitForTwilioPlaybackMark(markName, bytesSent, expectedDurationMs, remainingPlaybackMs, controller.signal);
      }
    } catch (err: unknown) {
      if (!isAbortError(err)) throw err;
    } finally {
      controller.abort();
      if (activeTtsAbort === controller) activeTtsAbort = null;
      isSpeaking = false;
      speaking = false;
    }
  }

  async function speakText(text: string) {
    await speakFromStream(oneChunkStream(text), 'tts');
  }

  const sttCallbacks = {
    onInterim: (t: string) => {
      if (introPlaying || !responding) return;

      const transcript = t.trim();
      if (!transcript) return;

      const words = countWords(transcript);
      if ((isSpeaking || speaking) && words < 2) {
        logger.debug({ transcript }, 'ignoring short interim transcript during playback');
        return;
      }

      if (words > 0) {
        bargeIn('interim_transcript');
      }
    },
    onFinal: (t: string) => {
      const transcript = t.trim();
      if (!transcript) return;
      if (introPlaying) return;

      const words = countWords(transcript);
      if ((isSpeaking || speaking) && words < 2) {
        logger.debug({ transcript }, 'ignoring short final transcript during playback');
        return;
      }

      logger.info({ transcript }, 'STT final');
      finalParts.push(transcript);
      transcriptSegments.push(transcript);
      if (responding) {
        bargeIn('final_transcript');
      }
    },
    onUtteranceEnd: () => {
      try {
        if (introPlaying) {
          finalParts = [];
          return;
        }

        const utterance = finalParts.join(' ').trim();
        finalParts = [];
        if (!utterance) return;

        enqueueUtterance(utterance);

        if (responding || isSpeaking || speaking) {
          bargeIn('queued_utterance');
        }

        void drainUtteranceQueue();
      } catch (err) {
        logger.error({ err }, 'onUtteranceEnd error');
      }
    },
    onSpeechStarted: () => {
      if (!introPlaying && responding) {
        bargeIn('speech_started');
      }
    }
  };

  function initDeepgramBridge(tenant: TenantConfig) {
    dg?.close();
    dg = createDeepgramBridge(sttCallbacks, { model: tenant.sttModel });
  }

  async function respond(depth = 0) {
    try {
      const tenant = activeTenant;
      if (!tenant) {
        throw new Error('No tenant configuration for active call');
      }

      if (depth > 5) {
        await speakText("I'm having some trouble right now. Let me connect you with Austen.");
        await executeTool('transfer_to_human', {}, { callSid, callerNumber, tenant, onboardingFields });
        return;
      }

      const tokenQueue = createAsyncTextQueue();
      const tokenBuffer: string[] = [];
      const llmAbortController = new AbortController();
      activeLlmAbort = llmAbortController;

      const ttsTask = speakFromStream(tokenQueue.iterable);
      const msg = await (async () => {
        try {
          return await runAgentStream(history, (token) => {
            tokenBuffer.push(token);
            tokenQueue.push(token);
          }, { signal: llmAbortController.signal, tenant });
        } finally {
          tokenQueue.close();
        }
      })();

      await ttsTask;
      if (activeLlmAbort === llmAbortController) {
        activeLlmAbort = null;
      }

      logger.info({ hasToolCalls: !!(msg?.tool_calls?.length), content: tokenBuffer.join('').slice(0, 80) }, 'LLM response');
      if (!msg) return;

      if (msg.tool_calls?.length) {
        history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls } as any);
        for (const c of msg.tool_calls as any[]) {
          if (c.type !== 'function' || !c.function) continue;

          const rawArgs =
            typeof c.function.arguments === 'string'
              ? c.function.arguments
              : JSON.stringify(c.function.arguments ?? {});
          const args = parseJsonSafe<Record<string, unknown>>(rawArgs, `tool_arguments:${c.function.name || 'unknown'}`);
          if (!args) {
            logger.warn({ tool: c.function.name, rawArgs: rawArgs.slice(0, 500) }, 'skipping tool call due to invalid JSON arguments');
            history.push({
              role: 'tool',
              name: c.function.name,
              tool_call_id: c.id,
              content: JSON.stringify({ error: 'Invalid tool arguments JSON' })
            });
            continue;
          }

          logger.info({ tool: c.function.name, args }, 'tool call');
          try {
            const result = await executeTool(c.function.name, args, { callSid, callerNumber, tenant, onboardingFields });
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

      const text = msg.content || tokenBuffer.join('').trim() || 'Sorry, I had trouble with that. Let me connect you with Austen.';
      history.push({ role: 'assistant', content: text });
    } catch (err) {
      if (isAbortError(err)) {
        logger.info('respond() aborted due to barge-in');
        return;
      }

      logger.error({ err }, 'respond() error');
      try {
        await speakText('Sorry, I ran into a technical issue. Let me connect you with someone who can help.');
        if (activeTenant) {
          await executeTool('transfer_to_human', {}, { callSid, callerNumber, tenant: activeTenant, onboardingFields });
        }
      } catch (_) {
        ws.close();
      }
    } finally {
      activeLlmAbort = null;
    }
  }

  ws.on('message', async (raw) => {
    const rawText = raw.toString();
    const msg = parseJsonSafe<TwilioMsg>(rawText, 'twilio_ws_message');
    if (!msg) return;

    if (msg.event === 'start') {
      try {
        streamSid = msg.start?.streamSid || '';
        callSid = msg.start?.callSid || '';
        callStartedAtMs = Date.now();
        callerNumber = getStartParameter(msg.start, ['callerNumber', 'CallerNumber', 'fromNumber', 'From']);
        toNumber = getStartParameter(msg.start, ['toNumber', 'To', 'calledNumber', 'twilioNumber']);

        activeTenant = await resolveTenantForIncomingNumber(toNumber);
        logger.info({ callerNumber, toNumber, tenantId: activeTenant?.id }, 'stream params resolved');

        if (!activeTenant) {
          logger.error({ toNumber }, 'No tenant found for called Twilio number');
          const unsupportedMessage =
            'Sorry, this number is not configured yet. Please call back later or contact support.';
          await speakText(unsupportedMessage);
          ws.close();
          return;
        }

        initDeepgramBridge(activeTenant);

        if (callerNumber) {
          history.push({
            role: 'system',
            content: `The caller's phone number is ${callerNumber}. Use this exact number for any send_sms tool calls.`
          } as any);
        }

        logger.info({ streamSid, callSid, callerNumber, toNumber, tenantId: activeTenant.id }, 'Twilio stream started');

        const greeting = activeTenant.greeting;
        history.push({ role: 'assistant', content: greeting });

        introPlaying = true;
        try {
          await speakFromStream(oneChunkStream(greeting), 'intro');
        } finally {
          introPlaying = false;
          finalParts = [];
        }
      } catch (err) {
        logger.error({ err }, 'start event error');
        ws.close();
      }
    }
    if (msg.event === 'mark') {
      const markName = msg.mark?.name;
      if (!markName) return;

      const pending = pendingPlaybackMarks.get(markName);
      if (!pending) {
        logger.debug({ markName }, 'received unmanaged Twilio mark');
        return;
      }

      pending.resolve();
      logger.info(
        { markName, bytesSent: pending.bytesSent, expectedDurationMs: pending.expectedDurationMs },
        'Twilio playback mark received'
      );
      return;
    }

    if (msg.event === 'media' && msg.media?.payload) {
      // Keep STT hot even while Cadence is speaking so barge-in can be detected.
      if (!introPlaying && dg) {
        if (!dg.isHealthy()) {
          if (!sttUnavailableLogged) {
            logger.warn('Deepgram STT unavailable; continuing call without STT');
            sttUnavailableLogged = true;
          }
        } else {
          const sent = dg.sendMulaw(Buffer.from(msg.media.payload, 'base64'));
          if (!sent) {
            if (!sttUnavailableLogged) {
              logger.warn('Deepgram STT send failed; continuing call without STT');
              sttUnavailableLogged = true;
            }
          } else {
            sttUnavailableLogged = false;
          }
        }
      }
      logger.debug('incoming audio packet');
    }
    if (msg.event === 'stop') {
      pendingUtterances.length = 0;
      abortActiveResponse('twilio_stop');
      dg?.close();
      dg = null;
      ws.close();
    }
  });

  ws.on('close', async () => {
    introPlaying = false;
    pendingUtterances.length = 0;
    abortActiveResponse('websocket_close');
    dg?.close();
    dg = null;

    const userMessages = history
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter((m) => m.trim().length > 0);

    const transcriptSummary = buildTranscriptSummary(transcriptSegments, userMessages);
    const durationSeconds = callStartedAtMs == null
      ? null
      : Math.max(0, Math.round((Date.now() - callStartedAtMs) / 1000));

    if (callSid) {
      try {
        const clientId = await resolveClientIdForCall(activeTenant, toNumber);
        if (clientId) {
          await upsertCallLog({
            clientId,
            callSid,
            callerNumber: callerNumber || null,
            durationSeconds,
            transcriptSummary,
          });
        } else {
          logger.warn({ callSid, toNumber, tenantId: activeTenant?.id }, 'Skipping call log DB write because client could not be resolved');
        }
      } catch (err) {
        logger.error({ err, callSid, toNumber, tenantId: activeTenant?.id }, 'Failed to persist call log on websocket close');
      }
    }

    if (!activeTenant) {
      logger.warn({ toNumber }, 'Skipping call summary SMS because tenant was not resolved');
      return;
    }

    const userTurns = userMessages.length;
    const interest = inferInterestLevel(userMessages);
    const topic = inferMainTopic(userMessages);
    const conversationLines = userMessages.length
      ? userMessages.map((m) => `Caller: ${condenseText(m)}`).join('\n')
      : 'Caller: N/A';
    const summary = `📞 Cadence Call Summary\nCaller: ${callerNumber || 'Unknown'}\nExchanges: ${userTurns}\nInterest: ${interest}\nTopic: ${topic}\n\nConversation:\n${conversationLines}`;

    try {
      await sendSms(activeTenant.ownerCell, summary);
      logger.info({ to: activeTenant.ownerCell, tenantId: activeTenant.id }, 'call summary SMS sent');
    } catch (err) {
      logger.error({ err, tenantId: activeTenant.id }, 'call summary SMS failed');
    }
  });
}
