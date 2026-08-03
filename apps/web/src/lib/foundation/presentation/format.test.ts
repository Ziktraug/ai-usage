import { describe, expect, test } from 'bun:test';
import { fmtCompact, fmtDate, fmtDateOnly, fmtDuration, fmtMaybeNum, fmtMoney, fmtNum, fmtPct, median } from './format';

describe('framework-neutral presentation formatting', () => {
  test('preserves report number and value labels', () => {
    expect(fmtNum(12_345)).toBe('12,345');
    expect(fmtMoney(12.345)).toBe('$12.35');
    expect(fmtMoney(null)).toBe('—');
    expect(fmtPct(9.94)).toBe('9.9%');
    expect(fmtPct(10.4)).toBe('10%');
    expect(fmtMaybeNum(undefined)).toBe('—');
    expect(fmtCompact(999_999)).toBe('1000k');
    expect(fmtCompact(1_000_000)).toBe('1.0M');
  });

  test('preserves empty date and duration labels', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDateOnly(null)).toBe('—');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(89 * 60_000)).toBe('89m');
    expect(fmtDuration(90 * 60_000)).toBe('1.5h');
  });

  test('calculates medians without mutating the input', () => {
    const values = [9, 1, 5, 3];
    expect(median(values)).toBe(4);
    expect(values).toEqual([9, 1, 5, 3]);
    expect(median([])).toBe(0);
  });
});
