import type { GoogleHealthProvider } from '../providers/google';
import { addDaysIso } from '../providers/google/civil';
import { collect, locked, packet, today, type WorkflowEnv } from './core';

export async function fetchLatest(env: WorkflowEnv, days = 7, provider?: GoogleHealthProvider) {
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new RangeError('days must be 1–7');
  const requestedAt = new Date().toISOString();
  const end = today();
  const start = addDaysIso(end, 1 - days);
  const refreshStatus = await locked(env, 'sync', () => collect(env, start, end, provider));
  return {
    requestedAt,
    refreshCompletedAt: new Date().toISOString(),
    refreshStatus: refreshStatus ?? 'busy',
    refreshSucceeded:
      refreshStatus !== null && Object.values(refreshStatus).every((s) => s !== 'error'),
    note:
      refreshStatus === null
        ? 'Another collection is running. This packet is archived data; retry after it completes.'
        : 'Fetched Google Health now. Wearable/phone upload delay may still limit the newest observation.',
    packet: await packet(env, start, end),
  };
}
