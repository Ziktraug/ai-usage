import { describe, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryPoint, ProviderQuotaObservation } from './provider-quota';
import {
  downsampleProviderQuotaHistoryPoints,
  normalizeCodexAppServerQuotaObservation,
  parseProviderQuotaHistoryRequest,
  parseProviderQuotaHistoryResult,
  parseProviderQuotaObservation,
  providerQuotaObservationFingerprintInput,
  segmentProviderQuotaHistoryPoints,
} from './provider-quota';

describe('normalizeCodexAppServerQuotaObservation', () => {
  test('normalizes root and provider-defined quota windows', () => {
    const observation = normalizeCodexAppServerQuotaObservation({
      accountScope: 'account-digest',
      machineId: 'machine-1',
      machineLabel: 'Laptop',
      observedAt: '2026-07-15T10:00:00.000Z',
      result: {
        ignored: 'extra fields are harmless',
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'plus',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_752_576_000 },
          secondary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 1_753_056_000 },
        },
        rateLimitsByLimitId: {
          review: {
            limitId: 'review',
            limitName: 'Code review',
            planType: 'plus',
            primary: { usedPercent: 110, windowDurationMins: 60, resetsAt: null },
            secondary: null,
          },
        },
      },
    });

    expect(observation?.plan).toBe('plus');
    expect(observation?.windows).toEqual([
      {
        blocked: false,
        group: '5h',
        id: 'codex:primary',
        label: '5h',
        limitSeconds: 18_000,
        remainingPercent: 75,
        resetsAt: '2025-07-15T10:40:00.000Z',
        scope: 'provider',
        usedPercent: 25,
      },
      {
        blocked: false,
        group: 'weekly',
        id: 'codex:secondary',
        label: 'Weekly',
        limitSeconds: 604_800,
        remainingPercent: 30,
        resetsAt: '2025-07-21T00:00:00.000Z',
        scope: 'provider',
        usedPercent: 70,
      },
      {
        blocked: true,
        group: null,
        id: 'review:primary',
        label: 'Code review · 1h',
        limitSeconds: 3600,
        remainingPercent: 0,
        resetsAt: null,
        scope: 'provider',
        usedPercent: 100,
      },
    ]);
  });

  test('keeps absent and malformed nested windows absent', () => {
    const observation = normalizeCodexAppServerQuotaObservation({
      machineId: 'machine-1',
      observedAt: '2026-07-15T10:00:00.000Z',
      result: {
        rateLimits: { limitId: 'codex', planType: null, primary: null, secondary: { usedPercent: 'bad' } },
        rateLimitsByLimitId: { broken: 'not-an-object' },
      },
    });

    expect(observation?.windows).toEqual([]);
    expect(observation?.state).toBe('partial');
  });
});

const observation = (observedAt: string): ProviderQuotaObservation => ({
  accountScope: null,
  machineId: 'machine-1',
  machineLabel: null,
  observedAt,
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'codex:primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 75,
      resetsAt: '2026-07-15T12:00:00.000Z',
      scope: 'provider',
      usedPercent: 25,
    },
  ],
});

test('strictly parses observations and history request bounds', () => {
  const valid = observation('2026-07-15T10:00:00.000Z');
  expect(parseProviderQuotaObservation(valid)).toEqual(valid);
  expect(parseProviderQuotaObservation({ ...valid, credential: 'must-not-cross-the-seam' })).toBeNull();
  expect(
    parseProviderQuotaHistoryRequest({
      from: '2026-07-14T10:00:00.000Z',
      maximumPoints: 20,
      providerKey: 'codex',
      to: '2026-07-15T10:00:00.000Z',
    }),
  ).toEqual({
    from: '2026-07-14T10:00:00.000Z',
    maximumPoints: 20,
    providerKey: 'codex',
    to: '2026-07-15T10:00:00.000Z',
  });
  expect(() =>
    parseProviderQuotaHistoryRequest({
      from: '2026-07-15T10:00:00.000Z',
      maximumPoints: 50_000,
      to: '2026-07-14T10:00:00.000Z',
    }),
  ).toThrow();
  expect(() =>
    parseProviderQuotaHistoryRequest({
      credential: 'must-not-cross-the-seam',
      from: '2026-07-14T10:00:00.000Z',
      to: '2026-07-15T10:00:00.000Z',
    }),
  ).toThrow();
});

test('fingerprints normalized content independently of observation time and property order', () => {
  const first = observation('2026-07-15T10:00:00.000Z');
  const second = { ...observation('2026-07-15T10:05:00.000Z'), windows: [...first.windows].reverse() };
  expect(providerQuotaObservationFingerprintInput(first)).toBe(providerQuotaObservationFingerprintInput(second));
});

const point = (
  minute: number,
  usedPercent: number,
  resetAt = '2026-07-15T12:00:00.000Z',
): ProviderQuotaHistoryPoint => ({
  accountScope: null,
  blocked: usedPercent === 100,
  firstObservedAt: `2026-07-15T10:${String(minute).padStart(2, '0')}:00.000Z`,
  group: '5h',
  lastObservedAt: `2026-07-15T10:${String(minute).padStart(2, '0')}:00.000Z`,
  limitSeconds: 18_000,
  machineId: 'machine-1',
  machineLabel: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  resetAt,
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  usedPercent,
  windowId: 'codex:primary',
  windowLabel: '5h',
});

test('strictly parses history results at the browser boundary', () => {
  const valid = {
    coverage: [],
    generatedAt: '2026-07-15T10:00:00.000Z',
    latest: [],
    points: [point(0, 25)],
    skipped: 0,
    truncated: false,
  };
  expect(parseProviderQuotaHistoryResult(valid)).toEqual(valid);
  expect(() => parseProviderQuotaHistoryResult({ ...valid, credential: 'must-not-cross-the-seam' })).toThrow();
  expect(() =>
    parseProviderQuotaHistoryResult({ ...valid, points: [{ ...valid.points[0], rawResponse: true }] }),
  ).toThrow();
});

test('segments reset changes and collection gaps', () => {
  const segments = segmentProviderQuotaHistoryPoints([
    point(0, 10),
    point(5, 20),
    point(20, 30),
    point(25, 5, '2026-07-15T17:00:00.000Z'),
  ]);
  expect(segments.map(({ breakReason, points }) => ({ breakReason, points: points.length }))).toEqual([
    { breakReason: null, points: 2 },
    { breakReason: 'gap', points: 1 },
    { breakReason: 'reset', points: 1 },
  ]);
});

test('downsampling preserves endpoints, extrema, resets, gaps, and blocked points', () => {
  const input = [point(0, 20), point(1, 10), point(2, 50), point(3, 100), point(20, 40)];
  const result = downsampleProviderQuotaHistoryPoints(input, 5);
  expect(result.truncated).toBe(false);
  expect(result.points).toEqual(input);

  const reduced = downsampleProviderQuotaHistoryPoints([...input, point(21, 30)], 5);
  expect(reduced.truncated).toBe(true);
  expect(reduced.points.map(({ usedPercent }) => usedPercent)).toEqual([20, 10, 100, 40, 30]);
});
