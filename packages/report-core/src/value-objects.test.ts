import { describe, expect, test } from 'bun:test';
import {
  canonicalInstantEpochMs,
  canonicalInstantFromDate,
  compareCanonicalInstants,
  parseCanonicalInstant,
} from './canonical-instant';
import { parseMergePreviewProof } from './merge-proof';
import {
  quotaWindowDurationFromMinutes,
  quotaWindowDurationFromSeconds,
  quotaWindowGroup,
  quotaWindowLabel,
} from './quota-window-duration';
import { parseServedRevision } from './served-revision';

describe('ServedRevision', () => {
  test('accepts the shared canonical grammar', () => {
    expect(String(parseServedRevision('revision-1'))).toBe('revision-1');
    expect(() => parseServedRevision('.revision')).toThrow('canonical opaque identifier');
    expect(() => parseServedRevision('revision:1')).toThrow('canonical opaque identifier');
  });
});

describe('CanonicalInstant', () => {
  test('normalizes dates and exposes stable ordering and epoch conversion', () => {
    const first = canonicalInstantFromDate(new Date('2026-08-10T10:00:00.000Z'));
    const second = parseCanonicalInstant('2026-08-10T10:00:01.000Z');
    expect(canonicalInstantEpochMs(first)).toBe(1_786_356_000_000);
    expect(compareCanonicalInstants(first, second)).toBe(-1);
    expect(() => parseCanonicalInstant('2026-08-10T12:00:00+02:00')).toThrow('canonical ISO timestamp');
  });
});

describe('MergePreviewProof', () => {
  test('validates the digest and versioned token as one proof', () => {
    const proof = parseMergePreviewProof({
      confirmationToken: `v1.${'b'.repeat(64)}`,
      documentDigest: 'a'.repeat(64),
    });
    expect(String(proof.documentDigest)).toBe('a'.repeat(64));
    expect(Object.isFrozen(proof)).toBe(true);
    expect(() =>
      parseMergePreviewProof({ confirmationToken: `v1.${'b'.repeat(64)}`, documentDigest: 'not-a-digest' }),
    ).toThrow('SHA-256');
  });
});

describe('QuotaWindowDuration', () => {
  test('normalizes units before deriving labels and groups', () => {
    const fromMinutes = quotaWindowDurationFromMinutes(300);
    const fromSeconds = quotaWindowDurationFromSeconds(18_000);
    expect(fromMinutes).toBe(fromSeconds);
    expect(quotaWindowLabel(fromMinutes)).toBe('5h');
    expect(quotaWindowGroup(fromMinutes)).toBe('5h');
    expect(quotaWindowDurationFromSeconds(0)).toBeNull();
  });
});
