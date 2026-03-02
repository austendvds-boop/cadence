import { sendSms, transferToHuman } from '../twilio/service';
import { logger } from '../utils/logger';

export async function executeTool(name: string, args: any, ctx: { callSid: string; callerNumber?: string }) {
  switch (name) {
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, 'Caller requested human assistance');
    case 'send_sms': {
      const phone = args.phone || ctx.callerNumber || '';
      if (!phone) {
        return { ok: false, error: 'No phone number available to send SMS' };
      }
      try {
        return await sendSms(phone, args.message);
      } catch (err) {
        logger.error({ err, to: phone }, 'send_sms tool failed');
        throw err;
      }
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
