import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

export type SttCallbacks = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onUtteranceEnd: () => void;
  onSpeechStarted: () => void;
};

export function createDeepgramBridge(cb: SttCallbacks) {
  if (!env.DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY');
  const dg = createClient(env.DEEPGRAM_API_KEY);
  const conn = dg.listen.live({
    model: 'nova-2', language: 'en-US', encoding: 'mulaw', sample_rate: 8000, channels: 1,
    punctuate: true, smart_format: true, interim_results: true, utterance_end_ms: 800, endpointing: 250, vad_events: true, keep_alive: true,
  });

  conn.on(LiveTranscriptionEvents.Open, () => logger.info('Deepgram connected'));
  conn.on(LiveTranscriptionEvents.Transcript, (d: any) => {
    const text = d.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;
    if (d.is_final) cb.onFinal(text); else cb.onInterim(text);
  });
  conn.on(LiveTranscriptionEvents.UtteranceEnd, () => cb.onUtteranceEnd());
  conn.on(LiveTranscriptionEvents.SpeechStarted, () => cb.onSpeechStarted());
  conn.on(LiveTranscriptionEvents.Error, (e: any) => logger.error({ err: e }, 'Deepgram error'));

  return {
    sendMulaw: (audio: Buffer) => (conn as any).send(audio as any),
    close: () => conn.requestClose(),
  };
}

