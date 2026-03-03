import { WebSocket } from 'ws';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

export type SttCallbacks = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onUtteranceEnd: () => void;
  onSpeechStarted: () => void;
};

type DeepgramMessage = {
  type?: string;
  is_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
    }>;
  };
};

const DEEPGRAM_LISTEN_URL =
  'wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&smart_format=true&interim_results=true&utterance_end_ms=500&endpointing=500&vad_events=true';

export function createDeepgramBridge(cb: SttCallbacks) {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const ws = new WebSocket(DEEPGRAM_LISTEN_URL, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  ws.on('open', () => logger.info('Deepgram connected'));

  ws.on('message', (data) => {
    let result: DeepgramMessage;

    try {
      result = JSON.parse(data.toString()) as DeepgramMessage;
    } catch (err) {
      logger.error({ err }, 'Failed to parse Deepgram message');
      return;
    }

    if (result.type === 'Results') {
      const text = result.channel?.alternatives?.[0]?.transcript?.trim();
      if (!text) return;
      if (result.is_final) cb.onFinal(text);
      else cb.onInterim(text);
      return;
    }

    if (result.type === 'UtteranceEnd') {
      cb.onUtteranceEnd();
      return;
    }

    if (result.type === 'SpeechStarted') {
      cb.onSpeechStarted();
    }
  });

  ws.on('error', (err) => logger.error({ err }, 'Deepgram error'));

  return {
    sendMulaw: (audio: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(audio);
    },
    close: () => ws.close(),
  };
}
