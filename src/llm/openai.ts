import OpenAI from 'openai';
import { mulaw } from 'alawmulaw';
import { env } from '../utils/env';
import { SYSTEM_PROMPT } from '../conversation/system-prompt';
import { toolDefinitions } from './tools';

export type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; name?: string };

export const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

export async function runAgent(messages: ChatMsg[]) {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.7,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] as any,
    tools: toolDefinitions as any,
  });
  return response.choices[0]?.message;
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
  if (!openai) throw new Error('Missing OPENAI_API_KEY');

  const speech = await openai.audio.speech.create({
    model: env.OPENAI_TTS_MODEL,
    voice: env.OPENAI_TTS_VOICE as any,
    input: text,
    response_format: 'pcm',
  });

  const pcm24kBuffer = Buffer.from(await speech.arrayBuffer());
  const pcm24k = new Int16Array(pcm24kBuffer.buffer, pcm24kBuffer.byteOffset, Math.floor(pcm24kBuffer.byteLength / 2));
  const pcm8k = downsample24kTo8kPcm16(pcm24k);

  const ulawBytes = Buffer.from(mulaw.encode(pcm8k));

  // Twilio media streams commonly use ~20ms frames (160 bytes at 8kHz, mono, μ-law)
  const frames = chunkBuffer(ulawBytes, 160);
  return frames.map((frame) => frame.toString('base64'));
}
export async function* streamMuLawChunks(text: string): AsyncGenerator<string> {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');

  const FRAME_SAMPLES = 160;
  const INPUT_SAMPLES_PER_FRAME = FRAME_SAMPLES * 3;
  const INPUT_BYTES_PER_FRAME = INPUT_SAMPLES_PER_FRAME * 2;

  const response = await openai.audio.speech.create({
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
export async function* streamDeepgramTTS(text: string, signal?: AbortSignal): AsyncGenerator<string> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const url = 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Deepgram TTS error ${response.status}: ${errText}`);
  }

  const FRAME_SIZE = 160; // 20ms at 8kHz �-law
  let remainder = Buffer.alloc(0);

  for await (const rawChunk of (response.body as any)) {
    const buf = Buffer.concat([remainder, Buffer.from(rawChunk)]);
    let offset = 0;
    while (offset + FRAME_SIZE <= buf.length) {
      yield buf.subarray(offset, offset + FRAME_SIZE).toString('base64');
      offset += FRAME_SIZE;
    }
    remainder = buf.subarray(offset);
  }

  // Flush any remaining bytes as a final partial frame
  if (remainder.length > 0) {
    yield remainder.toString('base64');
  }
}
