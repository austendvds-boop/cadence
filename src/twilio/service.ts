import twilio from 'twilio';
import { env } from '../utils/env';

export const twilioClient = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
  ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
  : null;

export async function transferToHuman(callSid: string, reason: string) {
  if (!twilioClient || !env.AUSTEN_CELL_NUMBER || !env.TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio transfer not configured');
  }
  const twiml = `<Response><Say>One moment, I am connecting you with Austen now.</Say><Dial callerId="${env.TWILIO_PHONE_NUMBER}" timeout="30">${env.AUSTEN_CELL_NUMBER}</Dial></Response>`;
  await twilioClient.calls(callSid).update({ twiml });
  return { ok: true, reason };
}

export async function sendSms(phone: string, message: string) {
  if (!twilioClient || !env.TWILIO_PHONE_NUMBER) throw new Error('Twilio SMS not configured');
  if (!phone) throw new Error('No recipient phone number provided');
  const result = await twilioClient.messages.create({ from: env.TWILIO_PHONE_NUMBER, to: phone, body: message });
  return { sid: result.sid, status: result.status };
}
