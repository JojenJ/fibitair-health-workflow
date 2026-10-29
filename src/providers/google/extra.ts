import { z } from 'zod';
import { addDaysIso, type CivilDate, civilDateToIso, dailyRollUpBody } from './civil';
import type { GoogleClient } from './client';
import { inRange, isRecord, num, reconcile } from './reconcile';

type Point = { day: string; value: unknown };
const dailySchema = z.object({
  rollupDataPoints: z.array(z.record(z.string(), z.unknown())).optional(),
});
const heartSchema = dailySchema.extend({ nextPageToken: z.string().optional() });

/** Keep the API's named aggregate fields instead of guessing units or filling missing values. */
export async function dailyAggregate(
  client: Pick<GoogleClient, 'requestJson'>,
  slug: string,
  key: string,
  start: string,
  end: string,
): Promise<Point[]> {
  const result = await client.requestJson(dailySchema, {
    path: `/v4/users/me/dataTypes/${slug}/dataPoints:dailyRollUp`,
    method: 'POST',
    json: dailyRollUpBody(start, addDaysIso(end, 1)),
  });
  return (result.rollupDataPoints ?? []).flatMap((p) => {
    if (!isRecord(p.civilStartTime) || !isRecord(p.civilStartTime.date) || !isRecord(p[key]))
      return [];
    const day = civilDateToIso(p.civilStartTime.date as CivilDate);
    return inRange(day, start, end) ? [{ day, value: p[key] }] : [];
  });
}

/** Five-minute heart-rate aggregates, with complete paging and explicit Shanghai time boundaries. */
export async function heartRateRollups(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<Point[]> {
  const points: Point[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const raw = await client.requestJson(heartSchema, {
      path: '/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp',
      method: 'POST',
      json: {
        range: {
          startTime: `${start}T00:00:00+08:00`,
          endTime: `${addDaysIso(end, 1)}T00:00:00+08:00`,
        },
        windowSize: '300s',
        pageSize: 3000,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    for (const p of raw.rollupDataPoints ?? []) {
      if (typeof p.startTime !== 'string' || !isRecord(p.heartRate)) continue;
      const timestamp = Date.parse(p.startTime);
      const avg = num(p.heartRate.beatsPerMinuteAvg);
      if (!Number.isFinite(timestamp) || avg === undefined) continue;
      const day = new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
      if (inRange(day, start, end))
        points.push({ day, value: { startTime: p.startTime, ...p.heartRate } });
    }
    if (!raw.nextPageToken) return points;
    if (seen.has(raw.nextPageToken)) throw new Error('Repeated heart rate page token');
    seen.add(raw.nextPageToken);
    pageToken = raw.nextPageToken;
  }
  throw new Error('Heart rate page budget exceeded');
}

/** Keep exercise records with their documented intervals and summary fields. */
export async function exerciseRecords(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<Point[]> {
  const result = await reconcile(client, 'exercise', 100);
  return result.flatMap((p) => {
    if (!isRecord(p.exercise) || !isRecord(p.exercise.interval))
      throw new Error('Unrecognized exercise record');
    const interval = p.exercise.interval;
    if (typeof interval.startTime !== 'string' || !Number.isFinite(Date.parse(interval.startTime)))
      throw new Error('Exercise missing start time');
    const offset =
      typeof interval.startUtcOffset === 'string' && /^-?\d+s$/.test(interval.startUtcOffset)
        ? Number(interval.startUtcOffset.slice(0, -1))
        : 8 * 3600;
    const day = new Date(Date.parse(interval.startTime) + offset * 1000).toISOString().slice(0, 10);
    return inRange(day, start, end) ? [{ day, value: p.exercise }] : [];
  });
}

/** Read bounded observations with all pages; preserve Google fields and source timestamps. */
export async function detailedRecords(
  client: Pick<GoogleClient, 'requestJson'>,
  slug: string,
  key: string,
  kind: 'sample' | 'interval' | 'daily',
  start: string,
  end: string,
): Promise<Point[]> {
  const field = `${slug.replaceAll('-', '_')}.${kind === 'sample' ? 'sample_time.civil_time' : kind === 'interval' ? 'interval.civil_start_time' : 'date'}`;
  const filter = `${field} >= "${start}" AND ${field} < "${addDaysIso(end, 1)}"`;
  const seen = new Set<string>();
  const points: Point[] = [];
  let pageToken: string | undefined;
  const schema = z.object({
    dataPoints: z.array(z.record(z.string(), z.unknown())).optional(),
    nextPageToken: z.string().optional(),
  });
  for (let page = 0; page < 20; page++) {
    const raw = await client.requestJson(schema, {
      path: `/v4/users/me/dataTypes/${slug}/dataPoints:reconcile`,
      query: { pageSize: 1000, filter, ...(pageToken ? { pageToken } : {}) },
    });
    for (const p of raw.dataPoints ?? []) {
      if (!isRecord(p[key])) throw new Error(`Unrecognized ${slug} data`);
      const value = p[key];
      const time =
        kind === 'sample' ? value.sampleTime : kind === 'interval' ? value.interval : undefined;
      const civil = isRecord(time)
        ? kind === 'sample'
          ? time.civilTime
          : time.civilStartTime
        : undefined;
      let date = kind === 'daily' ? value.date : isRecord(civil) ? civil.date : undefined;
      if (!isRecord(date) && isRecord(time)) {
        const iso = kind === 'sample' ? time.physicalTime : time.startTime;
        const offset = kind === 'sample' ? time.utcOffset : time.startUtcOffset;
        if (
          typeof iso === 'string' &&
          Number.isFinite(Date.parse(iso)) &&
          typeof offset === 'string' &&
          /^-?\d+(?:\.\d+)?s$/.test(offset)
        ) {
          const d = new Date(Date.parse(iso) + Number(offset.slice(0, -1)) * 1000);
          date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        }
      }
      if (
        !isRecord(date) ||
        typeof date.year !== 'number' ||
        typeof date.month !== 'number' ||
        typeof date.day !== 'number'
      )
        throw new Error(`Missing ${slug} date`);
      const day = civilDateToIso(date as CivilDate);
      if (inRange(day, start, end)) points.push({ day, value });
    }
    if (!raw.nextPageToken) return points;
    if (seen.has(raw.nextPageToken)) throw new Error('Repeated detail page token');
    seen.add(raw.nextPageToken);
    pageToken = raw.nextPageToken;
  }
  throw new Error('Detail page budget exceeded');
}

/** Hourly steps preserve true zero versus a missing hour. */
export async function hourlySteps(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<Point[]> {
  const seen = new Set<string>();
  const points: Point[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const raw = await client.requestJson(heartSchema, {
      path: '/v4/users/me/dataTypes/steps/dataPoints:rollUp',
      method: 'POST',
      json: {
        range: {
          startTime: `${start}T00:00:00+08:00`,
          endTime: `${addDaysIso(end, 1)}T00:00:00+08:00`,
        },
        windowSize: '3600s',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    for (const p of raw.rollupDataPoints ?? []) {
      if (typeof p.startTime !== 'string' || !isRecord(p.steps)) continue;
      const count = num(p.steps.countSum);
      const ms = Date.parse(p.startTime);
      if (count === undefined || !Number.isFinite(ms)) continue;
      const day = new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
      if (inRange(day, start, end)) points.push({ day, value: { startTime: p.startTime, count } });
    }
    if (!raw.nextPageToken) return points;
    if (seen.has(raw.nextPageToken)) throw new Error('Repeated hourly page token');
    seen.add(raw.nextPageToken);
    pageToken = raw.nextPageToken;
  }
  throw new Error('Hourly page budget exceeded');
}

/** Coalesce only touching, same-level intervals with unchanged offsets; never bridge gaps. */
export function compactActivityLevels(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => {
    const start = (p: Point) =>
      isRecord(p.value) &&
      isRecord(p.value.interval) &&
      typeof p.value.interval.startTime === 'string'
        ? Date.parse(p.value.interval.startTime)
        : 0;
    return start(a) - start(b);
  });
  const result: Point[] = [];
  for (const p of sorted) {
    if (!isRecord(p.value) || !isRecord(p.value.interval))
      throw new Error('Invalid activity interval');
    const iv = p.value.interval;
    if (
      typeof iv.startTime !== 'string' ||
      typeof iv.endTime !== 'string' ||
      typeof iv.startUtcOffset !== 'string' ||
      typeof iv.endUtcOffset !== 'string' ||
      !Number.isFinite(Date.parse(iv.startTime)) ||
      !Number.isFinite(Date.parse(iv.endTime)) ||
      Date.parse(iv.endTime) <= Date.parse(iv.startTime) ||
      typeof p.value.activityLevelType !== 'string'
    )
      throw new Error('Invalid activity interval');
    const previous = result.at(-1);
    const v = previous && isRecord(previous.value) ? previous.value : undefined;
    const interval = v && isRecord(v.interval) ? v.interval : undefined;
    if (
      previous?.day === p.day &&
      v?.activityLevelType === p.value.activityLevelType &&
      interval?.endTime === iv.startTime &&
      interval?.endUtcOffset === iv.startUtcOffset &&
      iv.startUtcOffset === iv.endUtcOffset
    ) {
      interval.endTime = iv.endTime;
      interval.endUtcOffset = iv.endUtcOffset;
    } else {
      result.push({
        day: p.day,
        value: {
          interval: {
            startTime: iv.startTime,
            endTime: iv.endTime,
            startUtcOffset: iv.startUtcOffset,
            endUtcOffset: iv.endUtcOffset,
          },
          activityLevelType: p.value.activityLevelType,
        },
      });
    }
  }
  return result;
}
