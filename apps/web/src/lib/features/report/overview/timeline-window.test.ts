import { describe, expect, test } from 'bun:test';
import type { FocusedTimelineBucket, FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
import {
  classifiedBucketPriceMeasurement,
  classifiedBucketValue,
  timelineBucketCenterPercent,
  timelineBucketLayout,
  timelinePlotLeft,
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

const partialMeasurement = (knownCost: number, unpricedFreshTokens: number) => ({
  knownCost,
  state: 'partially measured' as const,
  unpricedFreshTokens,
});

const bucket = (date: string, overrides: Partial<FocusedTimelineBucket> = {}): FocusedTimelineBucket => ({
  byKey: {},
  date,
  priceMeasurement: measurement(0),
  sessions: 0,
  tokens: 0,
  total: 0,
  unclassified: null,
  ...overrides,
});

const timeline = (buckets: FocusedTimelineBucket[], seriesKeys: string[] = []): FocusedTimelineData => ({
  buckets,
  dimension: 'harness',
  first: buckets[0]?.date ?? '2026-01-01',
  grandSessions: 0,
  grandTokens: 0,
  grandTotal: 0,
  granularity: 'day',
  last: buckets.at(-1)?.date ?? '2026-01-01',
  maxBucketSessions: 0,
  maxBucketTokens: 0,
  maxBucketTotal: 0,
  priceMeasurement: measurement(0),
  series: seriesKeys.map((key) => ({
    key,
    label: key,
    priceMeasurement: measurement(0),
    sessions: 0,
    tokens: 0,
    total: 0,
  })),
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
    byKey: { alpha: { cost: 99, priceMeasurement: measurement(99), sessions: 9, tokens: 990 } },
    priceMeasurement: measurement(99),
    sessions: 9,
    tokens: 990,
    total: 99,
  });
  const visible = bucket('2026-01-02T00:00:00.000Z', {
    byKey: {
      alpha: { cost: 3, priceMeasurement: measurement(3), sessions: 2, tokens: 300 },
      beta: { cost: 2, priceMeasurement: measurement(2), sessions: 1, tokens: 200 },
    },
    priceMeasurement: measurement(13),
    sessions: 4,
    tokens: 1300,
    total: 13,
    unclassified: {
      causes: [{ kind: 'origin-unsupported' as const, sessions: 1 }],
      priceMeasurement: measurement(8),
      sessions: 1,
      tokens: 800,
      total: 8,
    },
  });

  test('projects only visible, non-empty timeline entries in series order', () => {
    const bars = visibleTimelineBars(timeline([hidden, visible], ['alpha', 'beta']), { from: 1, to: 1 }, 'cost');

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
      byKey: { cursor: { cost: 0, priceMeasurement: measurement(0), sessions: 4, tokens: 40 } },
      sessions: 4,
      tokens: 40,
      total: 0,
    });
    const data = timeline([unpriced], ['cursor']);

    expect(visibleTimelineBars(data, { from: 0, to: 0 }, 'cost')[0]?.segments).toEqual([]);
    expect(visibleTimelineBars(data, { from: 0, to: 0 }, 'sessions')[0]?.segments).toEqual([
      { key: 'cursor', rank: 0, value: 4 },
    ]);
  });

  test('ignores an entry whose key left the series list', () => {
    const bars = visibleTimelineBars(timeline([visible], ['beta']), { from: 0, to: 0 }, 'cost');

    expect(bars[0]?.segments).toEqual([{ key: 'beta', rank: 0, value: 2 }]);
  });

  test('excludes the unclassified gap from the classified bucket value', () => {
    expect(classifiedBucketValue(visible, 'cost')).toBe(5);
    expect(classifiedBucketValue(visible, 'sessions')).toBe(3);
    expect(classifiedBucketValue(hidden, 'cost')).toBe(99);
    expect(classifiedBucketPriceMeasurement(visible)).toEqual(measurement(5));
  });

  test('scales against the tallest bucket inside the window, not the whole domain', () => {
    const data = timeline([hidden, visible], ['alpha', 'beta']);

    expect(visibleTimelineMaximum(data, { from: 0, to: 1 }, 'cost')).toBe(99);
    expect(visibleTimelineMaximum(data, { from: 1, to: 1 }, 'cost')).toBe(5);
  });

  test('projects processed-token bars, gaps, summaries, and window maxima', () => {
    const data = timeline([hidden, visible], ['alpha', 'beta']);

    expect(visibleTimelineBars(data, { from: 1, to: 1 }, 'tokens')).toEqual([
      {
        bucket: visible,
        index: 1,
        segments: [
          { key: 'alpha', rank: 0, value: 300 },
          { key: 'beta', rank: 1, value: 200 },
        ],
        total: 500,
      },
    ]);
    expect(classifiedBucketValue(visible, 'tokens')).toBe(500);
    expect(visibleTimelineMaximum(data, { from: 1, to: 1 }, 'tokens')).toBe(500);
    expect(visibleTimelineSummary(data, { from: 1, to: 1 }, 'tokens')).toEqual({
      gap: 800,
      priceMeasurement: measurement(13),
      total: 1300,
      totalsByKey: new Map([
        ['alpha', 300],
        ['beta', 200],
      ]),
    });
  });

  test('returns a zero maximum for an empty window', () => {
    expect(visibleTimelineMaximum(timeline([]), { from: 0, to: 0 }, 'cost')).toBe(0);
  });
});

describe('window summary', () => {
  const early = bucket('2026-01-01T00:00:00.000Z', {
    byKey: { alpha: { cost: 90, priceMeasurement: measurement(90), sessions: 9, tokens: 900 } },
    priceMeasurement: measurement(90),
    sessions: 9,
    tokens: 900,
    total: 90,
  });
  const late = bucket('2026-01-02T00:00:00.000Z', {
    byKey: {
      alpha: { cost: 3, priceMeasurement: measurement(3), sessions: 2, tokens: 300 },
      beta: { cost: 2, priceMeasurement: measurement(2), sessions: 1, tokens: 200 },
    },
    priceMeasurement: measurement(13),
    sessions: 4,
    tokens: 1300,
    total: 13,
    unclassified: {
      causes: [{ kind: 'origin-unsupported' as const, sessions: 1 }],
      priceMeasurement: measurement(8),
      sessions: 1,
      tokens: 800,
      total: 8,
    },
  });

  test('totals only the buckets inside the window', () => {
    const data = timeline([early, late], ['alpha', 'beta']);

    expect(visibleTimelineSummary(data, { from: 1, to: 1 }, 'cost')).toEqual({
      gap: 8,
      priceMeasurement: measurement(13),
      total: 13,
      totalsByKey: new Map([
        ['alpha', 3],
        ['beta', 2],
      ]),
    });
  });

  test('reports zero for a series that carries nothing inside the window', () => {
    const data = timeline([early, late], ['alpha', 'beta']);

    expect(visibleTimelineSummary(data, { from: 0, to: 0 }, 'cost').totalsByKey.get('beta')).toBeUndefined();
    expect(visibleTimelineSummary(data, { from: 0, to: 0 }, 'cost').gap).toBe(0);
  });

  test('switches to session counts without changing the window', () => {
    const data = timeline([early, late], ['alpha', 'beta']);

    expect(visibleTimelineSummary(data, { from: 0, to: 1 }, 'sessions')).toEqual({
      gap: 1,
      priceMeasurement: measurement(103),
      total: 13,
      totalsByKey: new Map([
        ['alpha', 11],
        ['beta', 1],
      ]),
    });
  });

  test('combines price coverage only from buckets inside the selected window', () => {
    const outside = bucket('2025-12-31T00:00:00.000Z', {
      priceMeasurement: partialMeasurement(0, 9000),
    });
    const priced = bucket('2026-01-01T00:00:00.000Z', {
      priceMeasurement: measurement(2),
      total: 2,
    });
    const partial = bucket('2026-01-02T00:00:00.000Z', {
      priceMeasurement: partialMeasurement(2, 500),
      total: 2,
    });

    expect(
      visibleTimelineSummary(timeline([outside, priced, partial]), { from: 1, to: 2 }, 'cost').priceMeasurement,
    ).toEqual(partialMeasurement(4, 500));
  });
});

describe('plot positioning', () => {
  test('aligns the hovered day-bucket crosshair to the inset plot area', () => {
    expect(timelinePlotLeft(1.25)).toBe('calc(1.25% + 7.8px)');
    expect(timelinePlotLeft(50)).toBe('50%');
    expect(timelinePlotLeft(98.75)).toBe('calc(98.75% - 7.8px)');
  });

  test('clamps a position outside the plot', () => {
    expect(timelinePlotLeft(-20)).toBe('calc(0% + 8px)');
    expect(timelinePlotLeft(140)).toBe('calc(100% - 8px)');
  });

  test('centres the crosshair on the bucket it inspects', () => {
    expect(timelineBucketCenterPercent(0, 4)).toBe(12.5);
    expect(timelineBucketCenterPercent(3, 4)).toBe(87.5);
    expect(timelineBucketCenterPercent(0, 0)).toBe(50);
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
