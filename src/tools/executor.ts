import { sendSms, transferToHuman } from '../twilio/service';
import { logger } from '../utils/logger';

type ToolContext = {
  callSid: string;
  callerNumber?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isE164PhoneNumber(value: string): boolean {
  return /^\+[0-9]+$/.test(value);
}

export async function executeTool(name: string, args: unknown, ctx: ToolContext) {
  switch (name) {
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, 'Caller requested human assistance');
    case 'send_sms': {
      const parsedArgs = asRecord(args);
      const destination = asTrimmedString(parsedArgs.phone) || asTrimmedString(ctx.callerNumber);

      if (!destination || !isE164PhoneNumber(destination)) {
        return { ok: false, error: "I don't have a valid phone number to send the text to" };
      }

      const message = asTrimmedString(parsedArgs.message);

      try {
        return await sendSms(destination, message);
      } catch (err) {
        logger.error({ err, to: destination }, 'send_sms tool failed');
        throw err;
      }
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
