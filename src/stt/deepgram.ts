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
    punctuate: true, smart_format: true, interim_results: true, utterance_end_ms: 500, endpointing: 300, vad_events: true,
  });

  let ready = false;
  let resolveReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    ready = true;
    logger.info('Deepgram connected');
    resolveReady?.();
    resolveReady = null;
  });
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
    waitUntilReady: async (timeoutMs = 3000) => {
      if (ready) return true;
      try {
        const opened = await Promise.race([
          readyPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (!opened) logger.warn({ timeoutMs }, 'Deepgram STT did not open in time; continuing without readiness guarantee');
        return opened;
      } catch (err) {
        logger.warn({ err }, 'Deepgram STT pre-warm failed; continuing without readiness guarantee');
        return false;
      }
    },
    close: () => conn.requestClose(),
  };
}
