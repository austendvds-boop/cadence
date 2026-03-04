import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { createDeepgramBridge } from '../stt/deepgram';
import { runAgentStream, streamDeepgramTTS, type ChatMsg } from '../llm/openai';
import { executeTool } from '../tools/executor';
import { sendSms } from '../twilio/service';

type TwilioMsg = { event: string; streamSid?: string; start?: any; media?: { payload: string } };

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.message.toLowerCase().includes('abort');
  }
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: string }).name === 'AbortError';
  }
  return false;
}

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
  let finalParts: string[] = [];
  let speaking = false;
  let isSpeaking = false;
  let introPlaying = false;
  let introTimer: ReturnType<typeof setTimeout> | null = null;
  let responding = false;
  let drainingUtterances = false;
  let activeLlmAbort: AbortController | null = null;
  let activeTtsAbort: AbortController | null = null;
  const pendingUtterances: string[] = [];
  const history: ChatMsg[] = [];

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
      ws.send(JSON.stringify({ event: 'clear', streamSid }));
      isSpeaking = false;
      speaking = false;
      aborted = true;
    }

    if (aborted) {
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
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
      }, index * 20);
    });
  }

  async function speakFromStream(textStream: AsyncIterable<string>) {
    const controller = new AbortController();
    activeTtsAbort?.abort();
    activeTtsAbort = controller;
    isSpeaking = false;

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
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        },
        controller.signal
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') throw err;
    } finally {
      controller.abort();
      if (activeTtsAbort === controller) activeTtsAbort = null;
      isSpeaking = false;
      speaking = false;
    }
  }

  async function speakText(text: string) {
    await speakFromStream(oneChunkStream(text));
  }

  const dg = createDeepgramBridge({
    onInterim: (t) => {
      if (introPlaying) return;
      if (responding && t.trim().split(/\s+/).length > 2) {
        bargeIn('interim_transcript');
      }
    },
    onFinal: (t) => {
      const transcript = t.trim();
      if (!transcript) return;
      if (introPlaying) return;
      logger.info({ transcript }, 'STT final');
      finalParts.push(transcript);
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
  });

  async function respond(depth = 0) {
    try {
      if (depth > 5) {
        await speakText("I'm having some trouble right now. Let me connect you with Austen.");
        await executeTool('transfer_to_human', {}, { callSid, callerNumber });
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
          }, { signal: llmAbortController.signal });
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
        await executeTool('transfer_to_human', {}, { callSid, callerNumber });
      } catch (_) {
        ws.close();
      }
    } finally {
      activeLlmAbort = null;
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

        const greeting = "Hi, thanks for calling Deer Valley Driving School! This is Cadence, how can I help you today?";
        history.push({ role: 'assistant', content: greeting });

        introPlaying = true;
        speaking = true;
        isSpeaking = true;
        const streamStart = Date.now();
        let chunkCount = 0;
        await streamDeepgramTTS(oneChunkStream(greeting), (payload) => {
          if (!introPlaying) return;
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
          chunkCount++;
        });
        const streamDuration = Date.now() - streamStart;
        const remainingPlayback = Math.max(chunkCount * 20 - streamDuration + 800, 800);
        logger.info({ chunks: chunkCount, streamDurationMs: streamDuration, remainingPlayback }, 'greeting sent');
        speaking = false;
        await new Promise<void>(r => {
          introTimer = setTimeout(() => {
            introPlaying = false;
            isSpeaking = false;
            finalParts = [];
            introTimer = null;
            r();
          }, remainingPlayback);
        });
      } catch (err) {
        logger.error({ err }, 'start event error');
        ws.close();
      }
    }
    if (msg.event === 'media' && msg.media?.payload) {
      if (!introPlaying) {
        dg.sendMulaw(Buffer.from(msg.media.payload, 'base64'));
      }
      logger.debug('incoming audio packet');
    }
    if (msg.event === 'stop') {
      pendingUtterances.length = 0;
      abortActiveResponse('twilio_stop');
      dg.close();
      ws.close();
    }
  });

  ws.on('close', async () => {
    if (introTimer) {
      clearTimeout(introTimer);
      introTimer = null;
    }

    introPlaying = false;
    pendingUtterances.length = 0;
    abortActiveResponse('websocket_close');
    dg.close();

    const userMessages = history
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter((m) => m.trim().length > 0);
    const userTurns = userMessages.length;
    const interest = inferInterestLevel(userMessages);
    const topic = inferMainTopic(userMessages);
    const conversationLines = userMessages.length
      ? userMessages.map((m) => `Caller: ${condenseText(m)}`).join('\n')
      : 'Caller: N/A';
    const summary = `📞 Cadence Call Summary\nCaller: ${callerNumber || 'Unknown'}\nExchanges: ${userTurns}\nInterest: ${interest}\nTopic: ${topic}\n\nConversation:\n${conversationLines}`;

    try {
      await sendSms('+16026633502', summary);
      logger.info({ to: '+16026633502' }, 'call summary SMS sent');
    } catch (err) {
      logger.error({ err }, 'call summary SMS failed');
    }
  });
}
