import axios from 'axios';
import { env } from '../utils/env';
import { getAppointmentTypeId, PackageType } from './config';

const BASE = 'https://acuityscheduling.com/api/v1';

function auth(account: 'mine' | 'parents') {
  const user = account === 'mine' ? env.ACUITY_MINE_USER : env.ACUITY_PARENTS_USER;
  const key = account === 'mine' ? env.ACUITY_MINE_KEY : env.ACUITY_PARENTS_KEY;
  if (!user || !key) throw new Error(`Missing Acuity creds for ${account}`);
  return Buffer.from(`${user}:${key}`).toString('base64');
}

export async function checkAvailability(region: string, packageType: PackageType, dateFrom: string, dateTo?: string) {
  const { account, appointmentTypeId } = getAppointmentTypeId(region, packageType);
  const dates = [dateFrom, ...(dateTo && dateTo !== dateFrom ? [dateTo] : [])];
  const responses = await Promise.all(dates.map((d) => axios.get(`${BASE}/availability/times`, {
    params: { appointmentTypeID: appointmentTypeId, date: d, timezone: 'America/Phoenix' },
    headers: { Authorization: `Basic ${auth(account)}` },
  })));
  return responses.flatMap((r) => r.data || []);
}

export async function bookAppointment(input: {
  firstName: string; lastName: string; phone: string; email?: string; region: string; packageType: PackageType; datetime: string; address: string; notes?: string;
}) {
  const { account, appointmentTypeId } = getAppointmentTypeId(input.region, input.packageType);
  const addressField = account === 'mine' ? 18107564 : 18107568;
  const intakeField = account === 'mine' ? 18101800 : 18101796;

  const payload = {
    appointmentTypeID: appointmentTypeId,
    datetime: input.datetime,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    email: input.email,
    fields: [
      { id: addressField, value: input.address },
      { id: intakeField, value: `Booked via Cadence. ${input.notes ?? ''}`.trim() },
    ],
  };

  const res = await axios.post(`${BASE}/appointments`, payload, {
    params: { admin: true },
    headers: { Authorization: `Basic ${auth(account)}` },
  });
  return res.data;
}
