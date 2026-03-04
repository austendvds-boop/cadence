import { WebSocket, type RawData } from 'ws';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

export type SttCallbacks = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onUtteranceEnd: () => void;
  onSpeechStarted: () => void;
  onConnected?: () => void;
};

export type DeepgramBridge = {
  sendMulaw: (audio: Buffer) => boolean;
  close: () => void;
  isHealthy: () => boolean;
};

type DeepgramBridgeOptions = {
  model?: string;
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

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const;
const DEFAULT_DEEPGRAM_STT_MODEL = 'nova-2';
const MIN_UTTERANCE_END_MS = 1000;
const MIN_ENDPOINTING_MS = 10;

export type EffectiveDeepgramSttConfig = {
  model: string;
  utteranceEndMs: number;
  endpointingMs: number;
};

export function getEffectiveDeepgramSttConfig(input: {
  model?: string;
  utteranceEndMs?: number;
  endpointingMs?: number;
} = {}): EffectiveDeepgramSttConfig {
  const model = input.model?.trim() || DEFAULT_DEEPGRAM_STT_MODEL;
  const configuredUtteranceEndMs = input.utteranceEndMs ?? env.UTTERANCE_END_MS;
  const configuredEndpointingMs = input.endpointingMs ?? env.ENDPOINTING_MS;

  return {
    model,
    utteranceEndMs: Math.max(MIN_UTTERANCE_END_MS, configuredUtteranceEndMs),
    endpointingMs: Math.max(MIN_ENDPOINTING_MS, configuredEndpointingMs),
  };
}

function getDeepgramListenUrl(model: string): string {
  const effectiveConfig = getEffectiveDeepgramSttConfig({ model });

  if (effectiveConfig.utteranceEndMs !== env.UTTERANCE_END_MS) {
    logger.warn(
      { configured: env.UTTERANCE_END_MS, applied: effectiveConfig.utteranceEndMs },
      'UTTERANCE_END_MS too low for Deepgram live WebSocket; clamping to safe minimum'
    );
  }

  if (effectiveConfig.endpointingMs !== env.ENDPOINTING_MS) {
    logger.warn(
      { configured: env.ENDPOINTING_MS, applied: effectiveConfig.endpointingMs },
      'ENDPOINTING_MS too low; clamping to Deepgram-safe minimum'
    );
  }

  const params = new URLSearchParams({
    model: effectiveConfig.model,
    language: 'en-US',
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    utterance_end_ms: String(effectiveConfig.utteranceEndMs),
    endpointing: String(effectiveConfig.endpointingMs),
    vad_events: 'true',
  });

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

export function createDeepgramBridge(cb: SttCallbacks, options: DeepgramBridgeOptions = {}): DeepgramBridge {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const sttModel = options.model?.trim() || DEFAULT_DEEPGRAM_STT_MODEL;

  let ws: WebSocket | null = null;
  let isClosedByCaller = false;
  let isHealthy = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDisabled = false;

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = (reason: 'close' | 'error') => {
    if (isClosedByCaller || reconnectDisabled) return;
    if (reconnectTimer) return;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      reconnectDisabled = true;
      logger.error(
        { reason, attempts: reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS },
        'Deepgram reconnect exhausted; continuing call without STT'
      );
      return;
    }

    const delayMs = RECONNECT_DELAYS_MS[reconnectAttempts] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    reconnectAttempts += 1;

    logger.warn(
      { reason, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS, delayMs, model: sttModel },
      'Scheduling Deepgram reconnect'
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (isClosedByCaller || reconnectDisabled) return;
      connect();
    }, delayMs);
  };

  const handleMessage = (data: RawData) => {
    let result: DeepgramMessage;

    try {
      result = JSON.parse(rawDataToString(data)) as DeepgramMessage;
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
  };

  const connect = () => {
    if (isClosedByCaller || reconnectDisabled) return;

    const socket = new WebSocket(getDeepgramListenUrl(sttModel), {
      headers: { Authorization: `Token ${apiKey}` },
    });

    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) return;
      clearReconnectTimer();
      reconnectAttempts = 0;
      isHealthy = true;
      logger.info({ model: sttModel }, 'Deepgram connected');
      cb.onConnected?.();
    });

    socket.on('message', (data) => {
      if (ws !== socket) return;
      handleMessage(data);
    });

    socket.on('close', (code, reasonBuffer) => {
      if (ws !== socket) return;

      isHealthy = false;
      const reason = reasonBuffer.toString();
      logger.warn({ code, reason, model: sttModel }, 'Deepgram connection closed');
      scheduleReconnect('close');
    });

    socket.on('error', (err) => {
      if (ws !== socket) return;

      isHealthy = false;
      logger.error({ err, model: sttModel }, 'Deepgram error');
      scheduleReconnect('error');

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  };

  connect();

  return {
    sendMulaw: (audio: Buffer) => {
      if (!ws || !isHealthy || ws.readyState !== WebSocket.OPEN) return false;

      try {
        ws.send(audio, (err) => {
          if (!err) return;
          logger.error({ err, model: sttModel }, 'Deepgram audio send failed');
          isHealthy = false;
          scheduleReconnect('error');
        });
        return true;
      } catch (err) {
        logger.error({ err, model: sttModel }, 'Deepgram audio send threw');
        isHealthy = false;
        scheduleReconnect('error');
        return false;
      }
    },
    close: () => {
      isClosedByCaller = true;
      isHealthy = false;
      clearReconnectTimer();
      ws?.close();
    },
    isHealthy: () => Boolean(ws && isHealthy && ws.readyState === WebSocket.OPEN),
  };
}
