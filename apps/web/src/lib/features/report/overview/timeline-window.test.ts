import { describe, expect, test } from 'bun:test';
import type { FocusedTimelineBucket, FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
import {
  classifiedBucketValue,
  timelineBucketLayout,
  timelineRangeForSelection,
  visibleTimelineBars,
  visibleTimelineBounds,
  visibleTimelineMaximum,
  visibleTimelineMonthTicks,
  visibleTimelineSummary,
} from './timeline-window';

const measurement = (knownCost: number) => ({
  knownCost,
  state: knownCost === 0 ? ('zero' as const) : ('measured' as const),
  unpricedFreshTokens: 0,
});

const bucket = (date: string, overrides: Partial<FocusedTimelineBucket> = {}): FocusedTimelineBucket => ({
  byKey: {},
  date,
  priceMeasurement: measurement(0),
  sessions: 0,
  total: 0,
  unclassified: null,
  ...overrides,
});

const timeline = (buckets: FocusedTimelineBucket[], seriesKeys: string[] = []): FocusedTimelineData => ({
  buckets,
  dimension: 'harness',
  first: buckets[0]?.date ?? '2026-01-01',
  grandSessions: 0,
  grandTotal: 0,
  granularity: 'day',
  last: buckets.at(-1)?.date ?? '2026-01-01',
  maxBucketSessions: 0,
  maxBucketTotal: 0,
  priceMeasurement: measurement(0),
  series: seriesKeys.map((key) => ({ key, label: key, priceMeasurement: measurement(0), sessions: 0, total: 0 })),
  unclassified: null,
});

const dailyBuckets = (count: number, startDay: number): FocusedTimelineBucket[] =>
  Array.from({ length: count }, (_, offset) => {
    const date = new Date(Date.UTC(2026, 0, startDay + offset));
    return bucket(date.toISOString());
  });

describe('report window projection', () => {
  test('maps the report selection to the matching chart buckets', () => {
    const buckets = ['2026-05-01', '2026-06-01', '2026-07-01'].map((date) => bucket(new Date(date).toISOString()));

    expect(timelineRangeForSelection(buckets, new Date('2026-05-01'), [14, 44])).toEqual({ from: 0, to: 1 });
  });

  test('reports the days the window actually starts and ends on', () => {
    const middle = new Date('2026-06-01').toISOString();
    const buckets = ['2026-05-01', '2026-06-01', '2026-07-01'].map((date) => bucket(new Date(date).toISOString()));

    expect(visibleTimelineBounds(timeline(buckets), { from: 1, to: 1 })).toEqual({ first: middle, last: middle });
  });

  test('falls back to the domain bounds when the range points outside the buckets', () => {
    const data = timeline([bucket('2026-05-01T00:00:00.000Z')]);

    expect(visibleTimelineBounds(data, { from: 4, to: 9 })).toEqual({ first: data.first, last: data.last });
  });
});

describe('visible bar projection', () => {
  const hidden = bucket('2026-01-01T00:00:00.000Z', {
    byKey: { alpha: { cost: 99, priceMeasurement: measurement(99), sessions: 9 } },
    priceMeasurement: measurement(99),
    sessions: 9,
    total: 99,
  });
  const visible = bucket('2026-01-02T00:00:00.000Z', {
    byKey: {
      alpha: { cost: 3, priceMeasurement: measurement(3), sessions: 2 },
      beta: { cost: 2, priceMeasurement: measurement(2), sessions: 1 },
    },
    priceMeasurement: measurement(13),
    sessions: 4,
    total: 13,
    unclassified: {
      causes: [{ kind: 'origin-unsupported' as const, sessions: 1 }],
      priceMeasurement: measurement(8),
      sessions: 1,
      total: 8,
    },
  });

  test('projects only visible, non-empty timeline entries in series order', () => {
    const bars = visibleTimelineBars(timeline([hidden, visible], ['alpha', 'beta']), { from: 1, to: 1 }, false);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.bucket).toBe(visible);
    expect(bars[0]?.index).toBe(1);
    expect(bars[0]?.total).toBe(5);
    expect(bars[0]?.segments).toEqual([
      { key: 'alpha', rank: 0, value: 3 },
      { key: 'beta', rank: 1, value: 2 },
    ]);
  });

  test('drops an entry whose value is zero in the selected metric', () => {
    const unpriced = bucket('2026-01-03T00:00:00.000Z', {
      byKey: { cursor: { cost: 0, priceMeasurement: measurement(0), sessions: 4 } },
      sessions: 4,
      total: 0,
    });
    const data = timeline([unpriced], ['cursor']);

    expect(visibleTimelineBars(data, { from: 0, to: 0 }, false)[0]?.segments).toEqual([]);
    expect(visibleTimelineBars(data, { from: 0, to: 0 }, true)[0]?.segments).toEqual([
      { key: 'cursor', rank: 0, value: 4 },
    ]);
  });

  test('ignores an entry whose key left the series list', () => {
    const bars = visibleTimelineBars(timeline([visible], ['beta']), { from: 0, to: 0 }, false);

    expect(bars[0]?.segments).toEqual([{ key: 'beta', rank: 0, value: 2 }]);
  });

  test('excludes the unclassified gap from the classified bucket value', () => {
    expect(classifiedBucketValue(visible, false)).toBe(5);
    expect(classifiedBucketValue(visible, true)).toBe(3);
    expect(classifiedBucketValue(hidden, false)).toBe(99);
  });

  test('scales against the tallest bucket inside the window, not the whole domain', () => {
    const data = timeline([hidden, visible], ['alpha', 'beta']);

    expect(visibleTimelineMaximum(data, { from: 0, to: 1 }, false)).toBe(99);
    expect(visibleTimelineMaximum(data, { from: 1, to: 1 }, false)).toBe(5);
  });

  test('returns a zero maximum for an empty window', () => {
    expect(visibleTimelineMaximum(timeline([]), { from: 0, to: 0 }, false)).toBe(0);
  });
});

describe('window summary', () => {
  const early = bucket('2026-01-01T00:00:00.000Z', {
    byKey: { alpha: { cost: 90, priceMeasurement: measurement(90), sessions: 9 } },
    sessions: 9,
    total: 90,
  });
  const late = bucket('2026-01-02T00:00:00.000Z', {
    byKey: {
      alpha: { cost: 3, priceMeasurement: measurement(3), sessions: 2 },
      beta: { cost: 2, priceMeasurement: measurement(2), sessions: 1 },
    },
    sessions: 4,
    total: 13,
    unclassified: {
      causes: [{ kind: 'origin-unsupported' as const, sessions: 1 }],
      priceMeasurement: measurement(8),
      sessions: 1,
      total: 8,
    },
  });

  test('totals only the buckets inside the window', () => {
    const data = timeline([early, late], ['alpha', 'beta']);

    expect(visibleTimelineSummary(data, { from: 1, to: 1 }, false)).toEqual({
      gap: 8,
      total: 13,
      totalsByKey: new Map([
        ['alpha', 3],
        ['beta', 2],
      ]),
    });
  });

  test('reports zero for a series that carries nothing inside the window', () => {
    const data = timeline([early, late], ['alpha', 'beta']);

    expect(visibleTimelineSummary(data, { from: 0, to: 0 }, false).totalsByKey.get('beta')).toBeUndefined();
    expect(visibleTimelineSummary(data, { from: 0, to: 0 }, false).gap).toBe(0);
  });

  test('switches to session counts without changing the window', () => {
    const data = timeline([early, late], ['alpha', 'beta']);

    expect(visibleTimelineSummary(data, { from: 0, to: 1 }, true)).toEqual({
      gap: 1,
      total: 13,
      totalsByKey: new Map([
        ['alpha', 11],
        ['beta', 1],
      ]),
    });
  });
});

describe('window layout and ticks', () => {
  test('keeps dense day buckets inside the plot instead of overflowing horizontally', () => {
    expect(timelineBucketLayout(379)).toEqual({
      bucketGap: 'clamp(0px, calc((100% - 758px) / 378), 2px)',
      bucketMinWidth: 'min(2px, calc(100% / 379))',
    });
  });

  test('collapses the gap for a single bucket', () => {
    expect(timelineBucketLayout(1)).toEqual({ bucketGap: '0px', bucketMinWidth: 'min(2px, calc(100% / 1))' });
    expect(timelineBucketLayout(0)).toEqual({ bucketGap: '0px', bucketMinWidth: 'min(2px, calc(100% / 1))' });
  });

  test('carries no interior tick for a window shorter than a week', () => {
    const data = timeline(dailyBuckets(7, 28));

    expect(visibleTimelineMonthTicks(data, { from: 0, to: 6 })).toEqual([]);
  });

  test('marks each month boundary inside a longer window', () => {
    const data = timeline(dailyBuckets(40, 20));

    const ticks = visibleTimelineMonthTicks(data, { from: 0, to: 39 });

    expect(ticks.map((tick) => tick.label)).toEqual(['Feb']);
    expect(ticks[0]?.pct).toBeCloseTo((12 / 40) * 100, 5);
  });

  test('stamps a January boundary with its two-digit year', () => {
    const data = timeline(dailyBuckets(20, 356));

    expect(visibleTimelineMonthTicks(data, { from: 0, to: 19 }).map((tick) => tick.label)).toEqual(['Jan ’27']);
  });
});
