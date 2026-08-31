import { describe, expect, test } from 'bun:test';
import { skillObservationProducerProofStaleTime, skillObservationProducerProofStatus } from './skill-observation-proof';

describe('skill observation producer proof', () => {
  test('never lets a future wire deadline extend the one-minute collection policy', () => {
    expect(
      skillObservationProducerProofStaleTime('2026-08-01T10:05:00.000Z', Date.parse('2026-08-01T10:00:00.000Z')),
    ).toBe(60_000);
  });

  test('treats missing, malformed, and already-spent proof as immediately stale', () => {
    const completedAt = Date.parse('2026-08-01T10:02:00.000Z');
    expect(skillObservationProducerProofStaleTime(null, completedAt)).toBe(0);
    expect(skillObservationProducerProofStaleTime('not-a-timestamp', completedAt)).toBe(0);
    expect(skillObservationProducerProofStaleTime('2026-08-01T10:01:00.000Z', completedAt)).toBe(0);
  });

  test('fails closed while stale or refetching and reopens only on current settled data', () => {
    expect(skillObservationProducerProofStatus({ isFetching: false, isStale: false })).toBe('current');
    expect(skillObservationProducerProofStatus({ isFetching: true, isStale: false })).toBe('refreshing');
    expect(skillObservationProducerProofStatus({ isFetching: true, isStale: true })).toBe('refreshing');
    expect(skillObservationProducerProofStatus({ isFetching: false, isStale: true })).toBe('expired');
  });
});
