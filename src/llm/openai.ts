import OpenAI from 'openai';
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

export async function synthesizeMuLawBase64(text: string): Promise<string[]> {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const speech = await openai.audio.speech.create({
    model: env.OPENAI_TTS_MODEL,
    voice: env.OPENAI_TTS_VOICE as any,
    input: text,
    response_format: 'wav',
  });
  const arr = new Uint8Array(await speech.arrayBuffer());
  // Placeholder conversion. TODO: wav->8k mulaw exact conversion.
  return [Buffer.from(arr).toString('base64')];
}
