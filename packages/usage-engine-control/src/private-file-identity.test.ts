import { describe, expect, test } from 'bun:test';
import { parseDarwinProcessStartTime } from './private-file-identity';

describe('Darwin process start identity', () => {
  test('normalizes the C-locale ps start time into stable numeric identity', () => {
    expect(parseDarwinProcessStartTime('Mon Aug 25 13:45:12 2026\n')).toBe('20260825134512');
    expect(parseDarwinProcessStartTime('Thu Jan  1 00:00:00 1970')).toBe('19700101000000');
  });

  test('rejects malformed, localized, and impossible start times', () => {
    expect(parseDarwinProcessStartTime('')).toBeNull();
    expect(parseDarwinProcessStartTime('lun. août 25 13:45:12 2026')).toBeNull();
    expect(parseDarwinProcessStartTime('Mon Feb 30 13:45:12 2026')).toBeNull();
    expect(parseDarwinProcessStartTime('Mon Aug 25 25:45:12 2026')).toBeNull();
  });
});
