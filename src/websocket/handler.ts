import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { createDeepgramBridge } from '../stt/deepgram';
import { runAgentStream, streamDeepgramTTS, type ChatMsg, DeepgramTtsConnection } from '../llm/openai';
import { executeTool } from '../tools/executor';
import { sendSms } from '../twilio/service';

type TwilioMsg = { event: string; streamSid?: string; start?: any; media?: { payload: string } };

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

function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }

  return prev[b.length];
}

function transcriptSimilarity(a: string, b: string): number {
  const normA = normalizeTranscript(a);
  const normB = normalizeTranscript(b);
  if (!normA && !normB) return 1;
  if (!normA || !normB) return 0;
  const maxLen = Math.max(normA.length, normB.length);
  if (!maxLen) return 1;
  const distance = levenshteinDistance(normA, normB);
  return Math.max(0, 1 - distance / maxLen);
}

type CachedResponse = {
  question: string;
  answer: string;
};

const PRESEEDED_TOP_QA: CachedResponse[] = [
  {
    question: 'how much is the license ready package',
    answer: 'Our most popular License-Ready Package is six eighty and includes four lessons, ten hours total, and road test waiver eligibility. Would you like me to help you choose dates that fit your schedule?'
  },
  {
    question: 'what packages do you offer',
    answer: 'Most families choose the License-Ready Package at six eighty with ten total driving hours, and we also offer smaller and larger options depending on goals. Are you looking for the fastest path to a license or more practice time?'
  },
  {
    question: 'what cities do you serve',
    answer: 'We serve twenty five plus cities across greater Phoenix, including Phoenix, Glendale, Scottsdale, Mesa, Tempe, Chandler, Gilbert, and nearby areas. What city are you in so I can confirm coverage for your address?'
  },
  {
    question: 'do you pick up students',
    answer: 'Yes, lessons are one on one and instructors pick students up at their address in our service area. What area should I check for you?'
  },
  {
    question: 'how old do you have to be to start',
    answer: 'Students can start at fifteen and a half, and there is no maximum age. Is the student already at least fifteen and a half, or are you planning ahead?'
  },
  {
    question: 'do you offer the road test waiver',
    answer: 'Yes, completing a qualifying package makes students eligible for the Arizona road test waiver so they can skip the MVD driving test. Do you want help picking the best package for that goal?'
  },
  {
    question: 'how do i book',
    answer: 'Booking is online at www dot deervalleydrivingschool dot com where you pick your region, choose dates, and check out. Want me to walk you through which package to select first?'
  }
];

type SpeculativeRun = {
  input: string;
  cancel: () => void;
  attach: (onToken: (token: string) => void) => void;
  messagePromise: Promise<any>;
};

function createSpeculativeRun(messages: ChatMsg[], input: string): SpeculativeRun {
  const controller = new AbortController();
  const bufferedTokens: string[] = [];
  let sink: ((token: string) => void) | null = null;

  const messagePromise = runAgentStream(
    messages,
    (token) => {
      if (sink) {
        sink(token);
      } else {
        bufferedTokens.push(token);
      }
    },
    controller.signal
  );

  return {
    input,
    cancel: () => controller.abort(),
    attach: (onToken) => {
      sink = onToken;
      while (bufferedTokens.length > 0) {
        onToken(bufferedTokens.shift() as string);
      }
    },
    messagePromise,
  };
}

export function handleTwilioMedia(ws: WebSocket) {
  let streamSid = '';
  let callSid = '';
  let callerNumber = '';
  let finalParts: string[] = [];
  let isSpeaking = false;
  let introPlaying = false;
  let introTimer: ReturnType<typeof setTimeout> | null = null;
  let callTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let responding = false;
  let activeTtsAbort: AbortController | null = null;
  let ttsConnection: DeepgramTtsConnection | null = null;
  let speculativeRun: SpeculativeRun | null = null;
  const history: ChatMsg[] = [];
  const responseCache = new Map<string, string>();
  const RESPONSE_CACHE_MAX = 100;

  for (const pair of PRESEEDED_TOP_QA) {
    responseCache.set(normalizeTranscript(pair.question), pair.answer);
  }

  function lookupCachedResponse(utterance: string): { response: string; similarity: number; key: string } | null {
    const normalized = normalizeTranscript(utterance);
    if (!normalized) return null;

    const exact = responseCache.get(normalized);
    if (exact) return { response: exact, similarity: 1, key: normalized };

    let best: { response: string; similarity: number; key: string } | null = null;
    for (const [key, value] of responseCache.entries()) {
      const similarity = transcriptSimilarity(normalized, key);
      if (similarity >= 0.95 && (!best || similarity > best.similarity)) {
        best = { response: value, similarity, key };
      }
    }

    return best;
  }

  function cacheResponse(question: string, answer: string) {
    if (!question || !answer) return;
    const normalized = normalizeTranscript(question);
    if (!normalized) return;

    if (responseCache.has(normalized)) responseCache.delete(normalized);
    responseCache.set(normalized, answer.trim());

    while (responseCache.size > RESPONSE_CACHE_MAX) {
      const oldestKey = responseCache.keys().next().value;
      if (!oldestKey) break;
      responseCache.delete(oldestKey);
    }
  }

  function cancelSpeculativeRun() {
    if (!speculativeRun) return;
    speculativeRun.cancel();
    speculativeRun = null;
  }

  function resetSpeechFlags() {
    isSpeaking = false;
    introPlaying = false;
  }

  function bargeIn(reason: 'interim_transcript' | 'final_transcript') {
    if (!isSpeaking || introPlaying) return;
    logger.info({ reason }, 'barge-in: clearing outbound audio');
    ws.send(JSON.stringify({ event: 'clear', streamSid }));
    activeTtsAbort?.abort();
    activeTtsAbort = null;
    ttsConnection?.close();
    ttsConnection = new DeepgramTtsConnection();
    ttsConnection.warm().catch((err) => logger.warn({ err }, 'failed to rewarm TTS after barge-in'));
    isSpeaking = false;
    finalParts = [];
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
          if (controller.signal.aborted || !streamSid) return;
          if (!isSpeaking) isSpeaking = true;
          if (!isSpeaking) return;
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        },
        controller.signal,
        ttsConnection ?? undefined
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') throw err;
    } finally {
      controller.abort();
      if (activeTtsAbort === controller) activeTtsAbort = null;
      isSpeaking = false;
    }
  }

  async function speakText(text: string) {
    await speakFromStream(oneChunkStream(text));
  }

  const dg = createDeepgramBridge({
    onInterim: (t) => {
      const text = t.trim();
      if (!text || introPlaying) return;

      const wordCount = text.split(/\s+/).filter(Boolean).length;

      if (!isSpeaking && !responding && !speculativeRun && wordCount >= 6) {
        const speculativeInput = finalParts.length ? `${finalParts.join(' ')} ${text}` : text;
        logger.debug({ transcript: speculativeInput }, 'starting speculative LLM run from interim transcript');
        speculativeRun = createSpeculativeRun([...history, { role: 'user', content: speculativeInput }], speculativeInput);
        const runRef = speculativeRun;
        runRef.messagePromise.catch((err: any) => {
          if (err?.name !== 'AbortError') logger.warn({ err }, 'speculative LLM run failed');
          if (speculativeRun === runRef) speculativeRun = null;
        });
      }
    },
    onFinal: (t) => {
      if (!t.trim()) return;
      logger.info({ transcript: t }, 'STT final');
      finalParts.push(t);
    },
    onUtteranceEnd: async () => {
      if (introPlaying || isSpeaking) return;
      if (responding) return;
      responding = true;

      try {
        const utterance = finalParts.join(' ').trim();
        finalParts = [];
        if (!utterance) return;

        let matchedSpeculativeRun: SpeculativeRun | null = null;
        if (speculativeRun) {
          const similarity = transcriptSimilarity(speculativeRun.input, utterance);
          if (similarity >= 0.8) {
            matchedSpeculativeRun = speculativeRun;
            logger.info({ utterance, speculativeInput: speculativeRun.input, similarity }, 'reusing speculative LLM stream');
          } else {
            logger.info({ utterance, speculativeInput: speculativeRun.input, similarity }, 'speculative LLM diverged; restarting with final transcript');
            cancelSpeculativeRun();
          }
        }

        const cached = lookupCachedResponse(utterance);
        if (cached) {
          logger.info({ utterance, matchedKey: cached.key, similarity: cached.similarity }, 'utterance end — using cached response');
          history.push({ role: 'user', content: utterance });
          history.push({ role: 'assistant', content: cached.response });
          await speakText(cached.response);
          cancelSpeculativeRun();
          return;
        }

        logger.info({ utterance }, 'utterance end — calling LLM');
        history.push({ role: 'user', content: utterance });

        if (!ttsConnection) {
          ttsConnection = new DeepgramTtsConnection();
        }
        ttsConnection.warm().catch((err) => logger.warn({ err }, 'pre-warm TTS websocket failed'));

        await respond(0, matchedSpeculativeRun ?? undefined);
        if (matchedSpeculativeRun) cancelSpeculativeRun();
      } catch (err) {
        cancelSpeculativeRun();
        logger.error({ err }, 'onUtteranceEnd error');
      } finally {
        responding = false;
      }
    },
    onSpeechStarted: () => {}
  });

  async function respond(depth = 0, precomputedRun?: SpeculativeRun) {
    try {
      if (depth > 5) {
        await speakText("I'm having some trouble right now. Let me connect you with Austen.");
        await executeTool('transfer_to_human', {}, { callSid, callerNumber });
        return;
      }

      const tokenQueue = createAsyncTextQueue();
      const tokenBuffer: string[] = [];

      const ttsTask = speakFromStream(tokenQueue.iterable);

      const onToken = (token: string) => {
        tokenBuffer.push(token);
        tokenQueue.push(token);
      };

      let msg: any;
      try {
        msg = precomputedRun
          ? await (async () => {
              precomputedRun.attach(onToken);
              return precomputedRun.messagePromise;
            })()
          : await runAgentStream(history, onToken);
      } finally {
        tokenQueue.close();
        await ttsTask;
      }

      logger.info({ hasToolCalls: !!(msg?.tool_calls?.length), content: tokenBuffer.join('').slice(0, 80) }, 'LLM response');
      if (!msg) return;

      if (msg.tool_calls?.length) {
        cancelSpeculativeRun();
        history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls } as any);
        for (const c of msg.tool_calls as any[]) {
          if (c.type !== 'function' || !c.function) continue;

          let args: any;
          try {
            args = JSON.parse(c.function.arguments || '{}');
          } catch (parseErr) {
            logger.warn({ err: parseErr, tool: c.function.name, rawArgs: c.function.arguments }, 'malformed tool arguments; skipping tool call');
            history.push({
              role: 'tool',
              name: c.function.name,
              tool_call_id: c.id,
              content: JSON.stringify({ error: 'Invalid tool arguments' })
            });
            continue;
          }

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

      const lastUserMessage = [...history].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')?.content;
      if (lastUserMessage && text.trim()) {
        cacheResponse(lastUserMessage, text);
      }
    } catch (err) {
      cancelSpeculativeRun();
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
    let msg: TwilioMsg;
    try {
      msg = JSON.parse(raw.toString()) as TwilioMsg;
    } catch (err) {
      logger.warn({ err, raw: raw.toString() }, 'failed to parse Twilio websocket message');
      return;
    }

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

        if (callTimeoutTimer) clearTimeout(callTimeoutTimer);
        callTimeoutTimer = setTimeout(() => {
          logger.warn({ callSid, streamSid }, 'call exceeded maximum duration; hanging up');
          ws.close(1000, 'call timeout');
        }, 10 * 60 * 1000);

        ttsConnection = new DeepgramTtsConnection();
        await ttsConnection.warm().catch((err) => {
          logger.warn({ err }, 'TTS pre-warm failed; continuing call startup');
        });

        const greeting = "Hi, thanks for calling Deer Valley Driving School! This is Cadence, how can I help you today?";
        history.push({ role: 'assistant', content: greeting });

        introPlaying = true;
        isSpeaking = true;
        const streamStart = Date.now();
        let chunkCount = 0;

        try {
          await streamDeepgramTTS(
            oneChunkStream(greeting),
            (payload) => {
              if (!introPlaying) return;
              ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
              chunkCount++;
            },
            undefined,
            ttsConnection
          );
        } catch (greetingErr) {
          logger.error({ err: greetingErr }, 'greeting stream failed');
          throw greetingErr;
        } finally {
          isSpeaking = false;
        }

        const streamDuration = Date.now() - streamStart;
        const remainingPlayback = Math.max(chunkCount * 20 - streamDuration + 800, 800);
        logger.info({ chunks: chunkCount, streamDurationMs: streamDuration, remainingPlayback }, 'greeting sent');

        await new Promise<void>((r) => {
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
        resetSpeechFlags();
        ws.close();
      } finally {
        isSpeaking = false;
      }
    }

    if (msg.event === 'media' && msg.media?.payload) {
      if (!isSpeaking) {
        dg.sendMulaw(Buffer.from(msg.media.payload, 'base64'));
      }
    }

    if (msg.event === 'stop') {
      activeTtsAbort?.abort();
      cancelSpeculativeRun();
      ttsConnection?.close();
      dg.close();
      ws.close();
    }
  });

  ws.on('close', async () => {
    if (introTimer) {
      clearTimeout(introTimer);
      introTimer = null;
    }
    if (callTimeoutTimer) {
      clearTimeout(callTimeoutTimer);
      callTimeoutTimer = null;
    }

    activeTtsAbort?.abort();
    cancelSpeculativeRun();
    ttsConnection?.close();
    dg.close();
    resetSpeechFlags();

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
