import OpenAI from 'openai';
import { WebSocket, type RawData } from 'ws';
import { buildSystemPrompt } from '../conversation/system-prompt';
import type { TenantConfig } from '../config/tenants';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { getToolDefinitionsForTenant } from './tools';

export type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; name?: string };

const useGroq = Boolean(env.GROQ_API_KEY);
export const llmClient = (useGroq || env.OPENAI_API_KEY)
  ? new OpenAI({
      apiKey: useGroq ? env.GROQ_API_KEY : env.OPENAI_API_KEY,
      baseURL: useGroq ? 'https://api.groq.com/openai/v1' : undefined,
    })
  : null;
export const LLM_MODEL = useGroq ? 'llama-3.3-70b-versatile' : (env.OPENAI_MODEL || 'gpt-4o');

if (llmClient) {
  logger.info({ provider: useGroq ? 'groq' : 'openai', model: LLM_MODEL }, 'LLM provider initialized');
}

type RequestOptions = {
  signal?: AbortSignal;
  tenant?: TenantConfig;
};

type StreamDeepgramTtsOptions = {
  signal?: AbortSignal;
  model?: string;
};

const DEFAULT_MAX_HISTORY_MESSAGES = 20;
const DEFAULT_DEEPGRAM_TTS_MODEL = 'aura-2-thalia-en';

function getMaxHistoryMessages(): number {
  const configured = Number(env.MAX_HISTORY_MESSAGES);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_HISTORY_MESSAGES;
  }
  return Math.floor(configured);
}

function buildMessagesWithSlidingWindow(messages: ChatMsg[], tenant: TenantConfig): ChatMsg[] {
  const maxHistoryMessages = getMaxHistoryMessages();
  let remainingNonSystemMessages = maxHistoryMessages;
  const keptReversed: ChatMsg[] = [];
  let totalNonSystemMessages = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    if (message.role === 'system') {
      keptReversed.push(message);
      continue;
    }

    totalNonSystemMessages += 1;
    if (remainingNonSystemMessages > 0) {
      keptReversed.push(message);
      remainingNonSystemMessages -= 1;
    }
  }

  const droppedNonSystemMessages = Math.max(0, totalNonSystemMessages - maxHistoryMessages);
  if (droppedNonSystemMessages > 0) {
    logger.debug({ droppedNonSystemMessages, maxHistoryMessages }, 'Trimmed chat history with sliding window');
  }

  return [{ role: 'system', content: buildSystemPrompt(tenant) }, ...keptReversed.reverse()];
}

export async function runAgentStream(messages: ChatMsg[], onToken: (token: string) => void, options: RequestOptions = {}) {
  if (!llmClient) throw new Error('Missing OPENAI_API_KEY or GROQ_API_KEY');
  if (!options.tenant) throw new Error('Missing tenant configuration for LLM request');

  const tenantToolDefinitions = getToolDefinitionsForTenant(options.tenant);

  const stream = await llmClient.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.7,
    stream: true,
    messages: buildMessagesWithSlidingWindow(messages, options.tenant) as any,
    tools: tenantToolDefinitions as any,
  }, {
    signal: options.signal,
  });

  let content = '';
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  for await (const chunk of stream as any) {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      onToken(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = {
            id: tc.id ?? '',
            type: 'function',
            function: { name: '', arguments: '' }
          };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  }

  return {
    content,
    tool_calls: toolCalls.filter((t) => t && t.function.name),
  } as any;
}

function extractSentenceChunk(buffer: string): { chunk: string; remainder: string } | null {
  const match = buffer.match(/([\s\S]*?[.!?])(?=\s|$)/);
  if (!match) return null;
  const chunk = match[1]?.trim();
  if (!chunk) return null;
  const cut = match.index! + match[1].length;
  return { chunk, remainder: buffer.slice(cut) };
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  if (err instanceof Error) return err.name === 'AbortError';
  return false;
}

async function streamDeepgramRest(text: string, options: StreamDeepgramTtsOptions, onFrame: (payload: string) => void): Promise<void> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const model = options.model || DEFAULT_DEEPGRAM_TTS_MODEL;
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mulaw&sample_rate=8000&container=none`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal: options.signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Deepgram TTS error ${response.status}: ${errText}`);
  }

  const FRAME_SIZE = 160;
  let remainder = Buffer.alloc(0);

  if (!response.body) return;

  for await (const rawChunk of response.body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.concat([remainder, Buffer.from(rawChunk)]);
    let offset = 0;
    while (offset + FRAME_SIZE <= buf.length) {
      onFrame(buf.subarray(offset, offset + FRAME_SIZE).toString('base64'));
      offset += FRAME_SIZE;
    }
    remainder = buf.subarray(offset);
  }

  if (remainder.length > 0) onFrame(remainder.toString('base64'));
}

export async function streamDeepgramTTS(
  textStream: AsyncIterable<string>,
  onFrame: (payload: string) => void,
  options: StreamDeepgramTtsOptions = {}
): Promise<void> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const model = options.model || DEFAULT_DEEPGRAM_TTS_MODEL;
  const wsUrl = `wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mulaw&sample_rate=8000&container=none`;

  let fullText = '';
  let textBuffer = '';
  let gotAudio = false;

  let ws: WebSocket | null = null;

  try {
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: { Authorization: `Token ${apiKey}` }
      });

      const onAbort = () => {
        socket.close();
        reject(new DOMException('aborted', 'AbortError'));
      };

      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      options.signal?.addEventListener('abort', onAbort, { once: true });

      socket.once('open', () => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve(socket);
      });
      socket.once('error', reject);
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary && !Buffer.isBuffer(data)) return;
      gotAudio = true;
      onFrame(rawDataToBuffer(data).toString('base64'));
    });

    const ensureOpen = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Deepgram websocket not open');
      }
    };

    for await (const token of textStream) {
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      fullText += token;
      textBuffer += token;

      while (true) {
        const split = extractSentenceChunk(textBuffer);
        if (!split) break;
        ensureOpen();
        ws.send(JSON.stringify({ type: 'Speak', text: split.chunk }));
        ws.send(JSON.stringify({ type: 'Flush' }));
        textBuffer = split.remainder;
      }
    }

    const remaining = textBuffer.trim();
    if (remaining) {
      ensureOpen();
      ws.send(JSON.stringify({ type: 'Speak', text: remaining }));
    }
    ensureOpen();
    ws.send(JSON.stringify({ type: 'Flush' }));
    ws.send(JSON.stringify({ type: 'Close' }));

    await new Promise<void>((resolve) => {
      if (!ws) return resolve();
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      ws.once('close', done);
      setTimeout(() => {
        if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
        done();
      }, 1200);
    });
  } catch (err: unknown) {
    if (isAbortError(err)) {
      ws?.close();
      throw err;
    }

    ws?.close();

    if (!gotAudio) {
      const fallback = fullText.trim();
      if (fallback) {
        await streamDeepgramRest(fallback, options, onFrame);
      }
      return;
    }

    throw err;
  }
}
