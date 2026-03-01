import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { createDeepgramBridge } from '../stt/deepgram';
import { runAgent, synthesizeMuLawBase64, type ChatMsg } from '../llm/openai';
import { executeTool } from '../tools/executor';

type TwilioMsg = { event: string; streamSid?: string; start?: any; media?: { payload: string } };

export function handleTwilioMedia(ws: WebSocket) {
  let streamSid = '';
  let callSid = '';
  let finalParts: string[] = [];
  let speaking = false;
  let introPlaying = false;
  const history: ChatMsg[] = [];

  const dg = createDeepgramBridge({
    onInterim: (t) => {
      if (speaking && t.split(/\s+/).length > 2) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
        speaking = false;
      }
    },
    onFinal: (t) => finalParts.push(t),
    onUtteranceEnd: async () => {
      const utterance = finalParts.join(' ').trim();
      finalParts = [];
      if (!utterance) return;
      history.push({ role: 'user', content: utterance });
      await respond();
    },
    onSpeechStarted: () => {
      if (speaking) ws.send(JSON.stringify({ event: 'clear', streamSid }));
      speaking = false;
    }
  });

  async function respond() {
    const msg = await runAgent(history);
    if (!msg) return;

    if (msg.tool_calls?.length) {
      for (const c of msg.tool_calls as any[]) {
        if (c.type !== 'function' || !c.function) continue;
        const args = JSON.parse(c.function.arguments || '{}');
        const result = await executeTool(c.function.name, args, { callSid });
        history.push({ role: 'tool', name: c.function.name, tool_call_id: c.id, content: JSON.stringify(result) });
      }
      return respond();
    }

    const text = msg.content || 'Sorry, I had trouble with that. Let me connect you with Austen.';
    history.push({ role: 'assistant', content: text });
    speaking = true;
    const chunks = await synthesizeMuLawBase64(text);
    for (const payload of chunks) {
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    }
    speaking = false;
  }

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString()) as TwilioMsg;
    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      callSid = msg.start?.callSid;
      logger.info({ streamSid, callSid }, 'Twilio stream started');

      const greeting = "Hi, thanks for calling Deer Valley Driving School! I'm an AI assistant. I can answer questions about our packages and pricing, or text you a link to book online. How can I help you today?";
      history.push({ role: 'assistant', content: greeting });

      introPlaying = true;
      speaking = true;
      const chunks = await synthesizeMuLawBase64(greeting);
      for (const payload of chunks) ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
      speaking = false;
      introPlaying = false;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      if (!introPlaying) {
        dg.sendMulaw(Buffer.from(msg.media.payload, 'base64'));
        logger.debug('incoming audio packet');
      }
    }
    if (msg.event === 'stop') {
      dg.close();
      ws.close();
    }
  });

  ws.on('close', () => dg.close());
}
