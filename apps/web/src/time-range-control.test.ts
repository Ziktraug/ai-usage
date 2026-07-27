import { describe, expect, test } from 'bun:test';
import {
  buildVisibleTimelineBars,
  chartOptionsSummary,
  chartRangeForSelection,
  defaultTimelineGranularity,
  humanDateInputValue,
  reportRangeSummary,
  timelineBucketLayout,
  timelinePlotLeft,
} from './time-range-control';

const measurement = (knownCost: number) => ({
  knownCost,
  state: knownCost === 0 ? ('zero' as const) : ('measured' as const),
  unpricedFreshTokens: 0,
});

describe('time range control labels', () => {
  test('summarizes the selected chart options in plain language', () => {
    expect(defaultTimelineGranularity).toBe('day');
    expect(chartOptionsSummary('harness', 'day', 'cost')).toBe('Harness · Day · Estimated API value');
    expect(chartOptionsSummary('campaign', 'week', 'share')).toBe('Campaign · Week · Share');
    expect(chartOptionsSummary('machine', 'day', 'sessions')).toBe('Machine · Day · Sessions');
    expect(chartOptionsSummary('origin', 'month', 'cost')).toBe('Origin · Month · Estimated API value');
    expect(chartOptionsSummary('project', 'month', 'sessions')).toBe('Project · Month · Sessions');
  });

  test('presents one compact range summary and human date-input values', () => {
    expect(reportRangeSummary(new Date(2026, 5, 26), new Date(2026, 6, 26), 30)).toEqual({
      duration: '30 days',
      fromLabel: 'Jun 26',
      toLabel: 'Jul 26, 2026',
    });
    expect(reportRangeSummary(new Date(2025, 11, 26), new Date(2026, 0, 2), 7)).toEqual({
      duration: '7 days',
      fromLabel: 'Dec 26, 2025',
      toLabel: 'Jan 02, 2026',
    });
    expect(humanDateInputValue('2026-06-26')).toBe('Jun 26, 2026');
    expect(humanDateInputValue('not-a-date')).toBe('not-a-date');
  });
});

describe('time range control report viewport', () => {
  test('maps the report selection to the matching chart buckets', () => {
    const buckets = ['2026-05-01', '2026-06-01', '2026-07-01'].map((date) => ({
      byKey: new Map(),
      date: new Date(date),
      priceMeasurement: measurement(0),
      sessions: 0,
      total: 0,
    }));

    expect(chartRangeForSelection({ buckets, minDay: new Date('2026-05-01') }, [14, 44])).toEqual({
      from: 0,
      to: 1,
    });
  });
});

describe('time range control plot positioning', () => {
  test('aligns hovered day-bucket crosshair to the inset plot area', () => {
    expect(timelinePlotLeft(1.25)).toBe('calc(1.25% + 7.8px)');
    expect(timelinePlotLeft(50)).toBe('50%');
    expect(timelinePlotLeft(98.75)).toBe('calc(98.75% - 7.8px)');
  });

  test('keeps dense day buckets inside the plot instead of overflowing horizontally', () => {
    expect(timelineBucketLayout(379)).toEqual({
      bucketGap: 'clamp(0px, calc((100% - 758px) / 378), 2px)',
      bucketMinWidth: 'min(2px, calc(100% / 379))',
    });
  });

  test('projects only visible, non-empty timeline entries in series order', () => {
    const hidden = {
      byKey: new Map([['alpha', { cost: 99, priceMeasurement: measurement(99), sessions: 9 }]]),
      date: new Date('2026-01-01'),
      priceMeasurement: measurement(99),
      sessions: 9,
      total: 99,
    };
    const visible = {
      byKey: new Map([
        ['beta', { cost: 2, priceMeasurement: measurement(2), sessions: 1 }],
        ['unknown', { cost: 8, priceMeasurement: measurement(8), sessions: 1 }],
        ['alpha', { cost: 3, priceMeasurement: measurement(3), sessions: 2 }],
      ]),
      date: new Date('2026-01-02'),
      priceMeasurement: measurement(13),
      sessions: 4,
      total: 13,
    };

    const bars = buildVisibleTimelineBars([hidden, visible], ['alpha', 'beta'], { from: 1, to: 1 }, false);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.bucket).toBe(visible);
    expect(bars[0]?.total).toBe(13);
    expect(bars[0]?.segments).toEqual([
      { key: 'alpha', rank: 0, value: 3 },
      { key: 'beta', rank: 1, value: 2 },
    ]);
  });
});
