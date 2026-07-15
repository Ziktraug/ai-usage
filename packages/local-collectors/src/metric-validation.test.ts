import { expect, test } from 'bun:test';
import {
  addNonNegativeFiniteNumbers,
  addNonNegativeSafeIntegers,
  parseFiniteTimestamp,
  parseNonEmptyString,
  parseNonNegativeFiniteNumber,
  parseNonNegativeSafeInteger,
} from './metric-validation';

test('validates non-negative safe integer metrics without coercion', () => {
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
    expect(parseNonNegativeSafeInteger(value)).toEqual({ ok: true, value });
  }
  for (const value of ['1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    expect(parseNonNegativeSafeInteger(value).ok).toBe(false);
  }
  expect(addNonNegativeSafeIntegers(1, 2)).toEqual({ ok: true, value: 3 });
  expect(addNonNegativeSafeIntegers(Number.MAX_SAFE_INTEGER, 1).ok).toBe(false);
});

test('validates finite costs, strings, and timestamps', () => {
  expect(parseNonNegativeFiniteNumber(1.25)).toEqual({ ok: true, value: 1.25 });
  expect(parseNonNegativeFiniteNumber(-1).ok).toBe(false);
  expect(addNonNegativeFiniteNumbers(Number.MAX_VALUE, Number.MAX_VALUE).ok).toBe(false);
  expect(parseNonEmptyString('id').ok).toBe(true);
  expect(parseNonEmptyString(' ').ok).toBe(false);
  expect(parseFiniteTimestamp('2026-01-01T00:00:00Z').ok).toBe(true);
  expect(parseFiniteTimestamp('invalid').ok).toBe(false);
});
