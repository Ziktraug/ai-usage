import { describe, expect, test } from 'bun:test';
import { buildCampaignChronology, createCampaignChronologyAccumulator } from './campaign-chronology';

const instant = (minute: number) => new Date(Date.UTC(2026, 5, 11, 8, minute)).toISOString();

describe('full campaign chronology', () => {
  test('accumulates interleaved campaigns without retaining their mutable input rows', () => {
    const first = createCampaignChronologyAccumulator();
    const second = createCampaignChronologyAccumulator();
    const member = { date: instant(0), endDate: instant(10) };
    first.add(member);
    const initial = first.finish();
    member.endDate = instant(1000);
    second.add(member);
    first.add({ date: null, endDate: instant(30) });
    first.add({ date: instant(40), endDate: instant(20) });
    expect(initial).toMatchObject({ observedTo: instant(10), sessionCount: 1, timedSessionCount: 1 });
    expect(first.finish()).toEqual({
      endedAt: instant(30),
      observedFrom: instant(0),
      observedTo: instant(30),
      sessionCount: 3,
      startedAt: instant(0),
      timedSessionCount: 1,
    });
    expect(second.finish()).toMatchObject({ observedTo: instant(1000), sessionCount: 1, timedSessionCount: 1 });
  });

  test('uses every member for the observed bounds, including children outside their root interval', () => {
    const rows = [
      { date: instant(10), endDate: instant(40) },
      { date: instant(0), endDate: instant(20) },
      { date: instant(30), endDate: instant(80) },
    ];
    const before = JSON.stringify(rows);
    expect(buildCampaignChronology(rows)).toEqual({
      endedAt: instant(80),
      observedFrom: instant(0),
      observedTo: instant(80),
      sessionCount: 3,
      startedAt: instant(0),
      timedSessionCount: 3,
    });
    expect(buildCampaignChronology(rows.toReversed())).toEqual(buildCampaignChronology(rows));
    expect(JSON.stringify(rows)).toBe(before);
  });

  test('keeps one-sided timestamps as observed anchors and excludes reversed and invalid intervals', () => {
    expect(
      buildCampaignChronology([
        { date: instant(10), endDate: instant(40) },
        { date: null, endDate: instant(0) },
        { date: instant(80), endDate: null },
        { date: null, endDate: null },
        { date: instant(200), endDate: instant(-200) },
        { date: 'invalid date', endDate: instant(300) },
      ]),
    ).toEqual({
      endedAt: instant(40),
      observedFrom: instant(0),
      observedTo: instant(80),
      sessionCount: 6,
      startedAt: instant(10),
      timedSessionCount: 1,
    });
  });

  test('handles all missing timing, one anchor, and valid zero-length intervals without inventing time', () => {
    expect(buildCampaignChronology([{ date: null, endDate: null }])).toEqual({
      endedAt: null,
      observedFrom: null,
      observedTo: null,
      sessionCount: 1,
      startedAt: null,
      timedSessionCount: 0,
    });
    expect(buildCampaignChronology([{ date: instant(0), endDate: null }])).toMatchObject({
      endedAt: null,
      observedFrom: instant(0),
      observedTo: instant(0),
      startedAt: instant(0),
      timedSessionCount: 0,
    });
    expect(buildCampaignChronology([{ date: instant(0), endDate: instant(0) }])).toMatchObject({
      observedFrom: instant(0),
      observedTo: instant(0),
      timedSessionCount: 1,
    });
  });

  test('uses numeric instants across epoch zero and expanded ISO years rather than lexicographic order', () => {
    expect(
      buildCampaignChronology([
        { date: '1969-12-31T23:59:59.999Z', endDate: '1970-01-01T00:00:00.000Z' },
        { date: '+010000-01-01T00:00:00.000Z', endDate: '+010000-01-01T00:00:00.001Z' },
      ]),
    ).toEqual({
      endedAt: '+010000-01-01T00:00:00.001Z',
      observedFrom: '1969-12-31T23:59:59.999Z',
      observedTo: '+010000-01-01T00:00:00.001Z',
      sessionCount: 2,
      startedAt: '1969-12-31T23:59:59.999Z',
      timedSessionCount: 2,
    });
  });
});
