import { describe, expect, test } from 'bun:test';
import { timelineBucketLayout, timelinePlotLeft } from './time-range-control';

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
});
