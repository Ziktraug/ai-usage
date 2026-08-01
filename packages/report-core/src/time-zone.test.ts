import { describe, expect, test } from 'bun:test';
import { isReportTimeZone, parseReportTimeZone, zonedWeekdayHourForTimestamp } from './time-zone';

describe('report time zones', () => {
  test('accepts canonical IANA zones and rejects invalid or padded values', () => {
    expect(parseReportTimeZone('UTC')).toBe('UTC');
    expect(parseReportTimeZone('America/New_York')).toBe('America/New_York');
    expect(isReportTimeZone('Europe/Paris')).toBe(true);
    expect(isReportTimeZone(' Europe/Paris ')).toBe(false);
    expect(isReportTimeZone('not/a-zone')).toBe(false);
  });

  test('derives weekday and hour through daylight-saving transitions', () => {
    const beforeSpringForward = Date.parse('2026-03-08T06:30:00.000Z');
    const afterSpringForward = Date.parse('2026-03-08T07:30:00.000Z');

    expect(zonedWeekdayHourForTimestamp(beforeSpringForward, 'America/New_York')).toEqual({
      hour: 1,
      weekday: 6,
    });
    expect(zonedWeekdayHourForTimestamp(afterSpringForward, 'America/New_York')).toEqual({
      hour: 3,
      weekday: 6,
    });
  });
});
