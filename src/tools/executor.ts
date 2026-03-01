import { sendSms, transferToHuman } from '../twilio/service';

export async function executeTool(name: string, args: any, ctx: { callSid: string }) {
  switch (name) {
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, 'Caller requested human assistance');
    case 'send_sms':
      return sendSms(args.phone, args.message);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
