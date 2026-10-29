import type { SleepLog } from '../types';
import type { GoogleClient } from './client';
import { isRecord, reconcile } from './reconcile';

const PAGE = 30;

// v4 sleep stage type -> Fitbit level.
const STAGE_LEVEL: Record<string, string> = {
  AWAKE: 'wake',
  LIGHT: 'light',
  DEEP: 'deep',
  REM: 'rem',
};

function offsetSec(s: unknown): number {
  const m = typeof s === 'string' ? /^(-?\d+)s$/.exec(s) : null;
  return m ? Number(m[1]) : 0;
}
function epoch(iso: unknown): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}
function localDate(iso: string, offSec: number): string {
  return new Date(Date.parse(iso) + offSec * 1000).toISOString().slice(0, 10);
}
function idFromName(name: unknown): number {
  if (typeof name !== 'string') return 0;
  const n = Number(name.split('/').pop());
  return Number.isFinite(n) ? n : 0;
}

function mapSleep(dp: Record<string, unknown>): SleepLog | undefined {
  const s = dp.sleep;
  if (!isRecord(s) || !isRecord(s.interval)) return undefined;
  const iv = s.interval;
  const startTime = String(iv.startTime ?? '');
  const endTime = String(iv.endTime ?? '');
  const startMs = epoch(iv.startTime);
  const endMs = epoch(iv.endTime);
  const off = offsetSec(iv.endUtcOffset ?? iv.startUtcOffset);

  const data: Array<{ dateTime: string; level: string; seconds: number }> = [];
  const bySec: Record<string, number> = {};
  for (const st of Array.isArray(s.stages) ? s.stages : []) {
    if (!isRecord(st)) continue;
    const a = epoch(st.startTime);
    const b = epoch(st.endTime);
    if (a === undefined || b === undefined) continue;
    const level = STAGE_LEVEL[String(st.type)] ?? String(st.type).toLowerCase();
    const seconds = Math.round((b - a) / 1000);
    data.push({ dateTime: String(st.startTime), level, seconds });
    bySec[level] = (bySec[level] ?? 0) + seconds;
  }

  const asleepSec = (bySec.light ?? 0) + (bySec.deep ?? 0) + (bySec.rem ?? 0);
  const duration = startMs !== undefined && endMs !== undefined ? endMs - startMs : 0;
  const summary = Object.fromEntries(
    Object.entries(bySec).map(([k, v]) => [k, { minutes: Math.round(v / 60) }]),
  );

  return {
    logId: idFromName(dp.dataPointName),
    dateOfSleep: endMs !== undefined ? localDate(endTime, off) : startTime.slice(0, 10),
    startTime,
    endTime,
    duration,
    minutesAsleep: Math.round(asleepSec / 60),
    minutesAwake: Math.round((bySec.wake ?? 0) / 60),
    timeInBed: Math.round(duration / 60000),
    type: typeof s.type === 'string' ? s.type.toLowerCase() : undefined,
    levels: { summary, data },
  };
}

async function allSleep(client: Pick<GoogleClient, 'requestJson'>): Promise<SleepLog[]> {
  const dps = await reconcile(client, 'sleep', PAGE);
  return dps.map(mapSleep).filter((x): x is SleepLog => x !== undefined);
}

/** Retain the source session and data source metadata alongside normalized sleep. */
export async function getSleepDetails(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
) {
  const dps = await reconcile(client, 'sleep', PAGE);
  return dps.flatMap((dp) => {
    const normalized = mapSleep(dp);
    if (!normalized) throw new Error('Unrecognized sleep session');
    return normalized.dateOfSleep >= start && normalized.dateOfSleep <= end
      ? [{ day: normalized.dateOfSleep, value: dp }]
      : [];
  });
}

export async function getSleep(
  client: Pick<GoogleClient, 'requestJson'>,
  date: string,
): Promise<SleepLog[]> {
  return (await allSleep(client)).filter((s) => s.dateOfSleep === date);
}

export async function getSleepRange(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<SleepLog[]> {
  return (await allSleep(client))
    .filter((s) => s.dateOfSleep >= start && s.dateOfSleep <= end)
    .sort((a, b) => a.dateOfSleep.localeCompare(b.dateOfSleep));
}
