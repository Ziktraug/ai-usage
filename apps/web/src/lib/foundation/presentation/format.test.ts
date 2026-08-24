import { describe, expect, test } from 'bun:test';
import {
  fmtCompact,
  fmtCompactColumn,
  fmtDate,
  fmtDateOnly,
  fmtDuration,
  fmtMaybeNum,
  fmtMoney,
  fmtNum,
  fmtPct,
  median,
} from './format';

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

  test('uses one compact notation down comparable token columns', () => {
    expect(fmtCompactColumn(999)).toBe('999');
    expect(fmtCompactColumn(1234)).toBe('1.23k');
    expect(fmtCompactColumn(36_971)).toBe('37k');
    expect(fmtCompactColumn(188_312)).toBe('188k');
    expect(fmtCompactColumn(999_999)).toBe('1M');
    expect(fmtCompactColumn(10_912_345)).toBe('10.9M');
    expect(fmtCompactColumn(2000)).toBe('2k');
    expect(fmtCompactColumn(0)).toBe('0');
  });

  test('calculates medians without mutating the input', () => {
    const values = [9, 1, 5, 3];
    expect(median(values)).toBe(4);
    expect(values).toEqual([9, 1, 5, 3]);
    expect(median([])).toBe(0);
  });
});
