export type PackageType = '2h5' | '5h';
export type AccountKey = 'mine' | 'parents';

export const SHARED_REGION_DEFAULTS: Record<string, AccountKey> = {
  anthem: 'parents',
  cavecreek: 'parents',
  scottsdale: 'mine',
};

export const REGION_APPOINTMENT_IDS: Record<string, Partial<Record<AccountKey, Partial<Record<PackageType, number>>>>> = {
  mesa: { mine: { '2h5': 44842781, '5h': 79409971 } },
  chandler: { mine: { '2h5': 50528663, '5h': 79425195 } },
  gilbert: { mine: { '2h5': 44842749, '5h': 80855605 } },
  scottsdale: { mine: { '2h5': 53640646, '5h': 76005046 }, parents: { '2h5': 44843350, '5h': 80856381 } },
  northphx: { mine: { '2h5': 83323017, '5h': 83323068 }, parents: { '2h5': 50529846, '5h': 80856319 } },
  anthem: { mine: { '2h5': 52197630, '5h': 76013137 }, parents: { '2h5': 50529545, '5h': 71529895 } },
  cavecreek: { mine: { '2h5': 63747690, '5h': 80855531 }, parents: { '2h5': 44843029, '5h': 80856073 } },
  glendale: { parents: { '2h5': 50529778, '5h': 80856108 } },
  peoria: { parents: { '2h5': 50529862, '5h': 80856354 } },
  surprise: { parents: { '2h5': 50529929, '5h': 80856422 } },
  tempe: { mine: { '2h5': 50528939, '5h': 76012750 } },
  queencreek: { mine: { '2h5': 50528913, '5h': 76012898 } },
  westvalley: { mine: { '5h': 85088423 } }
};

export function resolveAcuityAccount(region: string): AccountKey {
  const r = region.toLowerCase();
  const config = REGION_APPOINTMENT_IDS[r];
  if (!config) throw new Error(`Unsupported region: ${region}`);
  if (config.mine && !config.parents) return 'mine';
  if (!config.mine && config.parents) return 'parents';
  return SHARED_REGION_DEFAULTS[r] ?? 'mine';
}

export function getAppointmentTypeId(region: string, pkg: PackageType): { account: AccountKey; appointmentTypeId: number } {
  const r = region.toLowerCase();
  const account = resolveAcuityAccount(r);
  const id = REGION_APPOINTMENT_IDS[r]?.[account]?.[pkg];
  if (!id) throw new Error(`No appointment type ID for ${region}/${pkg}`);
  return { account, appointmentTypeId: id };
}
