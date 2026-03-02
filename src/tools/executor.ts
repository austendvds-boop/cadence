import { sendSms, transferToHuman } from '../twilio/service';

export async function executeTool(name: string, args: any, ctx: { callSid: string; callerNumber?: string }) {
  switch (name) {
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, 'Caller requested human assistance');
    case 'send_sms': {
      const phone = args.phone || ctx.callerNumber || '';
      if (!phone) {
        return { ok: false, error: 'No phone number available to send SMS' };
      }
      return sendSms(phone, args.message);
    }
    case 'notify_owner': {
      return sendSms('+16026633502', `📞 Cadence call summary:\n${args.summary}`);
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
