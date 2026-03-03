import OpenAI from 'openai';
import { WebSocket } from 'ws';
import { mulaw } from 'alawmulaw';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { SYSTEM_PROMPT } from '../conversation/system-prompt';
import { toolDefinitions } from './tools';

export type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; name?: string };

const useGroq = Boolean(env.GROQ_API_KEY);
export const llmClient = (useGroq || env.OPENAI_API_KEY)
  ? new OpenAI({
      apiKey: useGroq ? env.GROQ_API_KEY : env.OPENAI_API_KEY,
      baseURL: useGroq ? 'https://api.groq.com/openai/v1' : undefined,
    })
  : null;
export const LLM_MODEL = useGroq ? env.GROQ_MODEL : (env.OPENAI_MODEL || 'gpt-4o');

if (llmClient) {
  logger.info({ provider: useGroq ? 'groq' : 'openai', model: LLM_MODEL }, 'LLM provider initialized');
}

const openaiTts = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

const DEEPGRAM_TTS_WS_URL = 'wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none';

export class DeepgramTtsConnection {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly apiKey: string;
  private destroyed = false;

  constructor(apiKey = env.DEEPGRAM_API_KEY) {
    if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');
    this.apiKey = apiKey;
  }

  async warm(): Promise<void> {
    await this.getSocket();
  }

  async getSocket(): Promise<WebSocket> {
    if (this.destroyed) throw new Error('TTS connection has been closed');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(DEEPGRAM_TTS_WS_URL, {
        headers: { Authorization: `Token ${this.apiKey}` }
      });

      const cleanup = () => {
        socket.removeAllListeners('open');
        socket.removeAllListeners('error');
      };

      socket.once('open', () => {
        cleanup();
        this.ws = socket;
        this.connecting = null;
        socket.on('close', () => {
          if (this.ws === socket) this.ws = null;
        });
        socket.on('error', () => {
          if (this.ws === socket) this.ws = null;
        });
        resolve(socket);
      });

      socket.once('error', (err) => {
        cleanup();
        if (this.ws === socket) this.ws = null;
        this.connecting = null;
        reject(err);
      });
    });

    return this.connecting;
  }

  close(): void {
    this.destroyed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.connecting = null;
  }
}

export async function runAgent(messages: ChatMsg[]) {
  if (!llmClient) throw new Error('Missing OPENAI_API_KEY or GROQ_API_KEY');
  const response = await llmClient.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.7,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] as any,
    tools: toolDefinitions as any,
  });
  return response.choices[0]?.message;
}

export async function runAgentStream(messages: ChatMsg[], onToken: (token: string) => void, signal?: AbortSignal) {
  if (!llmClient) throw new Error('Missing OPENAI_API_KEY or GROQ_API_KEY');

  const stream = await llmClient.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.7,
    stream: true,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] as any,
    tools: toolDefinitions as any,
  }, signal ? { signal } : undefined);

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

function downsample24kTo8kPcm16(input: Int16Array): Int16Array {
  const outputLength = Math.floor(input.length / 3);
  const output = new Int16Array(outputLength);

  for (let i = 0, j = 0; i < outputLength; i += 1, j += 3) {
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    const c = input[j + 2] ?? b;
    output[i] = Math.round((a + b + c) / 3);
  }

  return output;
}

function chunkBuffer(buf: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    chunks.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
  }
  return chunks;
}

export async function synthesizeMuLawBase64(text: string): Promise<string[]> {
  if (!openaiTts) throw new Error('Missing OPENAI_API_KEY');

  const speech = await openaiTts.audio.speech.create({
    model: env.OPENAI_TTS_MODEL,
    voice: env.OPENAI_TTS_VOICE as any,
    input: text,
    response_format: 'pcm',
  });

  const pcm24kBuffer = Buffer.from(await speech.arrayBuffer());
  const pcm24k = new Int16Array(pcm24kBuffer.buffer, pcm24kBuffer.byteOffset, Math.floor(pcm24kBuffer.byteLength / 2));
  const pcm8k = downsample24kTo8kPcm16(pcm24k);

  const ulawBytes = Buffer.from(mulaw.encode(pcm8k));

  const frames = chunkBuffer(ulawBytes, 160);
  return frames.map((frame) => frame.toString('base64'));
}

export async function* streamMuLawChunks(text: string): AsyncGenerator<string> {
  if (!openaiTts) throw new Error('Missing OPENAI_API_KEY');

  const FRAME_SAMPLES = 160;
  const INPUT_SAMPLES_PER_FRAME = FRAME_SAMPLES * 3;
  const INPUT_BYTES_PER_FRAME = INPUT_SAMPLES_PER_FRAME * 2;

  const response = await openaiTts.audio.speech.create({
    model: env.OPENAI_TTS_MODEL,
    voice: env.OPENAI_TTS_VOICE as any,
    input: text,
    response_format: 'pcm',
  });

  let remainder = Buffer.alloc(0);

  for await (const rawChunk of (response.body as any)) {
    const buf = Buffer.concat([remainder, Buffer.from(rawChunk)]);
    let offset = 0;

    while (offset + INPUT_BYTES_PER_FRAME <= buf.length) {
      const slice = buf.subarray(offset, offset + INPUT_BYTES_PER_FRAME);
      const pcm24k = new Int16Array(slice.buffer, slice.byteOffset, INPUT_SAMPLES_PER_FRAME);
      const pcm8k = downsample24kTo8kPcm16(pcm24k);
      const ulawBytes = Buffer.from(mulaw.encode(pcm8k));
      yield ulawBytes.toString('base64');
      offset += INPUT_BYTES_PER_FRAME;
    }

    remainder = buf.subarray(offset);
  }

  if (remainder.length >= 2) {
    const remainingSamples = Math.floor(remainder.length / 2);
    const slice = remainder.subarray(0, remainingSamples * 2);
    const pcm24k = new Int16Array(slice.buffer, slice.byteOffset, remainingSamples);
    const pcm8k = downsample24kTo8kPcm16(pcm24k);
    const ulawBytes = Buffer.from(mulaw.encode(pcm8k));
    if (ulawBytes.length > 0) yield ulawBytes.toString('base64');
  }
}

function extractSpeakChunk(buffer: string): { chunk: string; remainder: string } | null {
  const working = buffer.replace(/^\s+/, '');
  if (!working) return null;

  const sentenceEnd = working.match(/^(.*?[.!?])(?=\s|$)/);
  if (sentenceEnd?.[1]) {
    const chunk = sentenceEnd[1].trim();
    return chunk ? { chunk, remainder: working.slice(sentenceEnd[1].length) } : null;
  }

  const clausePunctuation = [',', ';', ':'];
  for (const punct of clausePunctuation) {
    const idx = working.indexOf(punct);
    if (idx < 0) continue;
    const chunk = working.slice(0, idx + 1).trim();
    const rest = working.slice(idx + 1);

    if (punct === ',' && chunk.split(/\s+/).length < 4) continue;
    if (chunk.split(/\s+/).length >= 4) return { chunk, remainder: rest };
  }

  const emDash = working.indexOf(' — ');
  if (emDash > 0) {
    const chunk = working.slice(0, emDash).trim();
    if (chunk.split(/\s+/).length >= 4) return { chunk, remainder: working.slice(emDash + 3) };
  }

  const conjunctionMatch = working.match(/\b(and|but|so)\b/i);
  if (conjunctionMatch?.index && conjunctionMatch.index > 0) {
    const before = working.slice(0, conjunctionMatch.index).trim();
    if (before.split(/\s+/).length >= 8) {
      return { chunk: before, remainder: working.slice(conjunctionMatch.index) };
    }
  }

  return null;
}

async function streamDeepgramRest(text: string, signal: AbortSignal | undefined, onFrame: (payload: string) => void): Promise<void> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const url = 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Deepgram TTS error ${response.status}: ${errText}`);
  }

  const FRAME_SIZE = 160;
  let remainder = Buffer.alloc(0);

  for await (const rawChunk of (response.body as any)) {
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
  signal?: AbortSignal,
  persistentConnection?: DeepgramTtsConnection
): Promise<void> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  let fullText = '';
  let textBuffer = '';
  let gotAudio = false;

  let ws: WebSocket | null = null;

  const connectEphemeral = async () => {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(DEEPGRAM_TTS_WS_URL, {
        headers: { Authorization: `Token ${apiKey}` }
      });

      const onAbort = () => {
        socket.close();
        reject(new DOMException('aborted', 'AbortError'));
      };

      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      socket.once('open', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(socket);
      });
      socket.once('error', reject);
    });
  };

  try {
    ws = persistentConnection ? await persistentConnection.getSocket() : await connectEphemeral();

    ws.on('message', (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data)) {
        gotAudio = true;
        onFrame(Buffer.from(data as any).toString('base64'));
      }
    });

    const sendJson = async (payload: object) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

      const ensureSocket = async () => {
        if (persistentConnection) {
          ws = await persistentConnection.getSocket();
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error('Deepgram websocket not open');
        }
      };

      await ensureSocket();
      const socket = ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Deepgram websocket not open');
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        if (!persistentConnection) throw new Error('Deepgram websocket not open');
        ws = await persistentConnection.getSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Deepgram websocket not open');
        ws.send(JSON.stringify(payload));
      }
    };

    for await (const token of textStream) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      fullText += token;
      textBuffer += token;

      while (true) {
        const split = extractSpeakChunk(textBuffer);
        if (!split) break;
        await sendJson({ type: 'Speak', text: split.chunk });
        await sendJson({ type: 'Flush' });
        textBuffer = split.remainder;
      }
    }

    const remaining = textBuffer.trim();
    if (remaining) {
      await sendJson({ type: 'Speak', text: remaining });
    }
    await sendJson({ type: 'Flush' });

    if (!persistentConnection) {
      await sendJson({ type: 'Close' });
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
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (!persistentConnection) ws?.close();
      throw err;
    }

    if (!persistentConnection) ws?.close();

    if (!gotAudio) {
      const fallback = fullText.trim();
      if (fallback) await streamDeepgramRest(fallback, signal, onFrame);
      return;
    }

    throw err;
  }
}
