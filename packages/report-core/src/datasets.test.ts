import { describe, expect, test } from 'bun:test';
import { isRecord } from './datasets';

describe('isRecord', () => {
  test('accepts a plain object and rejects null, arrays and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord(['value'])).toBe(false);
    expect(isRecord('value')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
