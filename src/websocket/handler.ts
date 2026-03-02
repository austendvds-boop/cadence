import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { createDeepgramBridge } from '../stt/deepgram';
import { runAgent, streamDeepgramTTS, type ChatMsg } from '../llm/openai';
import { executeTool } from '../tools/executor';

type TwilioMsg = { event: string; streamSid?: string; start?: any; media?: { payload: string } };

export function handleTwilioMedia(ws: WebSocket) {
  let streamSid = '';
  let callSid = '';
  let callerNumber = '';
  let finalParts: string[] = [];
  let speaking = false;
  let introPlaying = false;
  let introTimer: ReturnType<typeof setTimeout> | null = null;
  let responding = false;
  const history: ChatMsg[] = [];

  async function speakText(text: string) {
    let started = false;
    for await (const payload of streamDeepgramTTS(text)) {
      if (!started) {
        speaking = true;
        started = true;
      }
      if (!speaking) break;
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    }
    speaking = false;
  }

  const dg = createDeepgramBridge({
    onInterim: (t) => {
      if (speaking && t.split(/\s+/).length > 2) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
        speaking = false;
      }
    },
    onFinal: (t) => {
      logger.info({ transcript: t }, 'STT final');
      finalParts.push(t);
    },
    onUtteranceEnd: async () => {
      try {
        if (introPlaying) return;
        if (responding) return;
        const utterance = finalParts.join(' ').trim();
        finalParts = [];
        if (!utterance) return;
        logger.info({ utterance }, 'utterance end — calling LLM');
        history.push({ role: 'user', content: utterance });
        responding = true;
        await respond();
        responding = false;
      } catch (err) {
        responding = false;
        logger.error({ err }, 'onUtteranceEnd error');
      }
    },
    onSpeechStarted: () => {
      if (!introPlaying && speaking) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
        speaking = false;
      }
    }
  });

  async function respond(depth = 0) {
    try {
      if (depth > 5) {
        await speakText("I'm having some trouble right now. Let me connect you with Austen.");
        await executeTool('transfer_to_human', {}, { callSid, callerNumber });
        return;
      }

      const msg = await runAgent(history);
      logger.info({ hasToolCalls: !!(msg?.tool_calls?.length), content: msg?.content?.slice(0, 80) }, 'LLM response');
      if (!msg) return;

      if (msg.tool_calls?.length) {
        history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls } as any);
        for (const c of msg.tool_calls as any[]) {
          if (c.type !== 'function' || !c.function) continue;
          const args = JSON.parse(c.function.arguments || '{}');
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

      const text = msg.content || 'Sorry, I had trouble with that. Let me connect you with Austen.';
      history.push({ role: 'assistant', content: text });
      await speakText(text);
    } catch (err) {
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
    const msg = JSON.parse(raw.toString()) as TwilioMsg;
    if (msg.event === 'start') {
      try {
        streamSid = msg.start?.streamSid;
        callSid = msg.start?.callSid;
        callerNumber = msg.start?.customParameters?.callerNumber || '';
        if (callerNumber) {
          history.push({
            role: 'system',
            content: `The caller's phone number is ${callerNumber}. Use this exact number for any send_sms tool calls.`
          } as any);
        }
        logger.info({ streamSid, callSid, callerNumber }, 'Twilio stream started');

        const greeting = "Hi, thanks for calling Deer Valley Driving School! I'm an AI assistant. I can answer questions about our packages and pricing, or text you a link to book online. How can I help you today?";
        history.push({ role: 'assistant', content: greeting });

        introPlaying = true;
        speaking = true;
        const streamStart = Date.now();
        let chunkCount = 0;
        for await (const payload of streamDeepgramTTS(greeting)) {
          if (!introPlaying) break;
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
          chunkCount++;
        }
        const streamDuration = Date.now() - streamStart;
        const remainingPlayback = Math.max(chunkCount * 20 - streamDuration + 800, 800);
        logger.info({ chunks: chunkCount, streamDurationMs: streamDuration, remainingPlayback }, 'greeting sent');
        speaking = false;
        await new Promise<void>(r => {
          introTimer = setTimeout(() => { introPlaying = false; introTimer = null; r(); }, remainingPlayback);
        });
      } catch (err) {
        logger.error({ err }, 'start event error');
        ws.close();
      }
    }
    if (msg.event === 'media' && msg.media?.payload) {
      if (!speaking && !introPlaying) {
        dg.sendMulaw(Buffer.from(msg.media.payload, 'base64'));
      }
      logger.debug('incoming audio packet');
    }
    if (msg.event === 'stop') {
      dg.close();
      ws.close();
    }
  });

  ws.on('close', () => dg.close());
}



