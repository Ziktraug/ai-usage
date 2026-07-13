import { describe, expect, test } from 'bun:test';
import {
  buildVisibleTimelineBars,
  chartOptionsSummary,
  defaultTimelineGranularity,
  timelineBucketLayout,
  timelinePlotLeft,
} from './time-range-control';

describe('time range control labels', () => {
  test('summarizes the selected chart options in plain language', () => {
    expect(defaultTimelineGranularity).toBe('day');
    expect(chartOptionsSummary('harness', 'day', 'cost')).toBe('Harness · Day · API value');
    expect(chartOptionsSummary('project', 'month', 'sessions')).toBe('Project · Month · Sessions');
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
      byKey: new Map([['alpha', { cost: 99, sessions: 9 }]]),
      date: new Date('2026-01-01'),
      sessions: 9,
      total: 99,
    };
    const visible = {
      byKey: new Map([
        ['beta', { cost: 2, sessions: 1 }],
        ['unknown', { cost: 8, sessions: 1 }],
        ['alpha', { cost: 3, sessions: 2 }],
      ]),
      date: new Date('2026-01-02'),
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
