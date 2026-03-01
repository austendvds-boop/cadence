import { bookAppointment, checkAvailability } from '../acuity/client';
import { sendSms, transferToHuman } from '../twilio/service';

export async function executeTool(name: string, args: any, ctx: { callSid: string }) {
  switch (name) {
    case 'check_availability':
      return checkAvailability(args.region, args.package_type, args.date_from, args.date_to);
    case 'book_appointment':
      return bookAppointment({
        firstName: args.first_name,
        lastName: args.last_name,
        phone: args.phone,
        email: args.email,
        region: args.region,
        packageType: args.package_type,
        datetime: args.datetime,
        address: args.address,
        notes: args.notes,
      });
    case 'transfer_to_human':
      return transferToHuman(ctx.callSid, args.reason);
    case 'send_sms':
      return sendSms(args.phone, args.message);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
