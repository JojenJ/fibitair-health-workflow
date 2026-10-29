import { describe, expect, it, vi } from 'vitest';
import {
  compactActivityLevels,
  dailyAggregate,
  detailedRecords,
  exerciseRecords,
  heartRateRollups,
  hourlySteps,
} from '../../../src/providers/google/extra';

describe('additional health data', () => {
  it('keeps daily values including explicit zero and excludes absent data', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      rollupDataPoints: [
        {
          civilStartTime: { date: { year: 2026, month: 10, day: 28 } },
          activeZoneMinutes: { activeZoneMinutesSum: '0' },
        },
        { civilStartTime: { date: { year: 2026, month: 10, day: 29 } } },
      ],
    });
    expect(
      await dailyAggregate(
        { requestJson },
        'active-zone-minutes',
        'activeZoneMinutes',
        '2026-10-28',
        '2026-10-29',
      ),
    ).toEqual([{ day: '2026-10-28', value: { activeZoneMinutesSum: '0' } }]);
  });
  it('follows heart rate pages and groups midnight in Shanghai', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        rollupDataPoints: [
          { startTime: '2026-10-28T15:55:00Z', heartRate: { beatsPerMinuteAvg: 65 } },
        ],
        nextPageToken: 'next',
      })
      .mockResolvedValueOnce({
        rollupDataPoints: [
          { startTime: '2026-10-28T16:00:00Z', heartRate: { beatsPerMinuteAvg: 70 } },
        ],
      });
    const points = await heartRateRollups({ requestJson }, '2026-10-28', '2026-10-29');
    expect(points.map((p) => p.day)).toEqual(['2026-10-28', '2026-10-29']);
    expect(requestJson.mock.calls[1]?.[1].json.pageToken).toBe('next');
    requestJson.mockResolvedValue({ nextPageToken: 'repeat' });
    await expect(heartRateRollups({ requestJson }, '2026-10-28', '2026-10-29')).rejects.toThrow(
      'Repeated',
    );
  });
  it('keeps exercise session details and uses the recorded offset', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      dataPoints: [
        {
          exercise: {
            interval: { startTime: '2026-10-28T16:30:00Z', startUtcOffset: '28800s' },
            exerciseType: 'WALKING',
            metricsSummary: { averageHeartRateBeatsPerMinute: '110' },
          },
        },
      ],
    });
    expect(await exerciseRecords({ requestJson }, '2026-10-29', '2026-10-29')).toEqual([
      expect.objectContaining({
        day: '2026-10-29',
        value: expect.objectContaining({ exerciseType: 'WALKING' }),
      }),
    ]);
  });
  it('reads bounded samples across pages and uses the local date', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        dataPoints: [
          {
            heartRateVariability: {
              sampleTime: { physicalTime: '2026-10-28T16:30:00Z', utcOffset: '28800s' },
              rootMeanSquareOfSuccessiveDifferencesMilliseconds: 42,
            },
          },
        ],
        nextPageToken: 'p2',
      })
      .mockResolvedValueOnce({ dataPoints: [] });
    const values = await detailedRecords(
      { requestJson },
      'heart-rate-variability',
      'heartRateVariability',
      'sample',
      '2026-10-29',
      '2026-10-29',
    );
    expect(values).toEqual([expect.objectContaining({ day: '2026-10-29' })]);
    expect(requestJson.mock.calls[0]?.[1].query.filter).toContain(
      'heart_rate_variability.sample_time.civil_time',
    );
    expect(requestJson.mock.calls[1]?.[1].query.pageToken).toBe('p2');
  });
  it('preserves an explicit zero hourly step count', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      rollupDataPoints: [{ startTime: '2026-10-28T16:00:00Z', steps: { countSum: '0' } }],
    });
    expect(await hourlySteps({ requestJson }, '2026-10-29', '2026-10-29')).toEqual([
      { day: '2026-10-29', value: { startTime: '2026-10-28T16:00:00Z', count: 0 } },
    ]);
  });
  it('merges contiguous activity intervals without filling gaps', () => {
    const interval = (startTime: string, endTime: string) => ({
      day: '2026-10-29',
      value: {
        activityLevelType: 'SEDENTARY',
        interval: { startTime, endTime, startUtcOffset: '28800s', endUtcOffset: '28800s' },
      },
    });
    const result = compactActivityLevels([
      interval('2026-10-29T00:01:00Z', '2026-10-29T00:02:00Z'),
      interval('2026-10-29T00:00:00Z', '2026-10-29T00:01:00Z'),
      interval('2026-10-29T00:03:00Z', '2026-10-29T00:04:00Z'),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.value).toMatchObject({
      interval: { startTime: '2026-10-29T00:00:00Z', endTime: '2026-10-29T00:02:00Z' },
    });
  });
});
