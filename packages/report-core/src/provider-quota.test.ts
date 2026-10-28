import { describe, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryPoint, ProviderQuotaObservation } from './provider-quota';
import {
  assessCodexReviewCapacity,
  codexQuotaWindowModel,
  downsampleProviderQuotaHistoryPoints,
  normalizeCodexAppServerQuotaObservation,
  parseProviderQuotaHistoryRequest,
  parseProviderQuotaHistoryResult,
  parseProviderQuotaObservation,
  projectLatestProviderQuotaObservation,
  providerQuotaObservationFingerprintInput,
  segmentProviderQuotaHistoryPoints,
  withoutSupersededUnscopedQuotaHeads,
} from './provider-quota';

const CODEX_NOW = Date.parse('2026-10-22T18:00:00.000Z');
const codexSnapshot = (overrides: Record<string, unknown> = {}) => ({
  limitId: 'codex',
  normalModelSlug: null,
  spendControlReached: false,
  rateLimitReachedType: null,
  individualLimit: null,
  credits: { hasCredits: false, unlimited: false, balance: null },
  primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: CODEX_NOW / 1000 + 3600 },
  secondary: null,
  ...overrides,
});
const codexCapacity = (root: Record<string, unknown>, buckets: Record<string, unknown> | null = null) =>
  assessCodexReviewCapacity({
    model: 'gpt-6',
    now: CODEX_NOW,
    result: { ordinaryUsageAllowed: true, rateLimits: root, rateLimitsByLimitId: buckets },
  });

describe('native Codex included-usage authority', () => {
  test('requires the global bucket and every exact selected-model bucket', () => {
    const global = codexSnapshot();
    const selected = codexSnapshot({ limitId: 'alias', normalModelSlug: 'gpt-6' });
    expect(codexCapacity(global, { selected })).toEqual({ kind: 'available' });
    expect(codexCapacity(selected)).toEqual({ kind: 'unavailable', reason: 'unknown-capacity' });
    expect(codexCapacity(global, { selected: { ...selected, primary: null } })).toEqual({
      kind: 'unavailable',
      reason: 'unknown-capacity',
    });
    expect(codexCapacity(codexSnapshot({ primary: null }), { selected })).toEqual({
      kind: 'unavailable',
      reason: 'unknown-capacity',
    });
  });
  test.each([
    { spendControlReached: true },
    { primary: null, rateLimitReachedType: 'rate_limit_reached' },
    { primary: null, rateLimitReachedType: 'spend_control_limit_reached' },
  ])('preserves explicit denial %j even with another healthy bucket', (denial) => {
    expect(codexCapacity(codexSnapshot(denial), { codex: codexSnapshot() })).toEqual({
      kind: 'unavailable',
      reason: 'denied',
    });
    expect(
      codexCapacity(codexSnapshot(), {
        alias: codexSnapshot({ ...denial, limitId: 'alias', normalModelSlug: 'gpt-6' }),
      }),
    ).toEqual({ kind: 'unavailable', reason: 'denied' });
  });
  test('ignores only exact other model capacity, never infers an unknown alias from its label', () => {
    const denied = codexSnapshot({
      limitId: 'quota-alias',
      normalModelSlug: 'gpt-6-mini',
      primary: null,
      rateLimitReachedType: 'rate_limit_reached',
    });
    expect(codexCapacity(codexSnapshot(), { denied })).toEqual({ kind: 'available' });
    expect(codexCapacity(codexSnapshot(), { denied: { ...denied, normalModelSlug: 'gpt-6' } })).toEqual({
      kind: 'unavailable',
      reason: 'denied',
    });
    expect(
      codexCapacity(codexSnapshot(), { denied: { ...denied, normalModelSlug: null, limitName: 'gpt-6-mini' } }),
    ).toEqual({ kind: 'unavailable', reason: 'unknown-alias' });
    expect(codexCapacity(codexSnapshot({ limitId: 'unrecognized' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown-alias',
    });
  });
  test.each([
    { spendControlReached: null },
    { spendControlReached: undefined },
    { rateLimitReachedType: undefined },
    { primary: null },
    { primary: undefined },
    { primary: { usedPercent: null, windowDurationMins: 300, resetsAt: CODEX_NOW / 1000 + 3600 } },
    { primary: { usedPercent: 20, windowDurationMins: Number.MAX_VALUE, resetsAt: CODEX_NOW / 1000 + 3600 } },
    { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: CODEX_NOW / 1000 } },
    { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Number.MAX_VALUE } },
    { individualLimit: { remainingPercent: 0, resetsAt: CODEX_NOW / 1000 + 3600 } },
    { individualLimit: { remainingPercent: 50, resetsAt: CODEX_NOW / 1000 } },
  ])('does not infer recovery or capacity from incomplete native evidence %j', (unknown) => {
    expect(codexCapacity(codexSnapshot(unknown))).toEqual({ kind: 'unavailable', reason: 'unknown-capacity' });
  });
  test('denies ordinary usage false/null and unknown/malformed mandatory collections', () => {
    for (const ordinaryUsageAllowed of [false, null]) {
      expect(
        assessCodexReviewCapacity({
          model: 'gpt-6',
          now: CODEX_NOW,
          result: { ordinaryUsageAllowed, rateLimits: codexSnapshot(), rateLimitsByLimitId: null },
        }),
      ).toEqual({ kind: 'unavailable', reason: 'included-usage' });
    }
    expect(
      assessCodexReviewCapacity({
        model: 'gpt-6',
        now: CODEX_NOW,
        result: { ordinaryUsageAllowed: true, rateLimits: codexSnapshot() },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'unknown-capacity' });
    expect(codexCapacity(codexSnapshot(), { malformed: null })).toEqual({
      kind: 'unavailable',
      reason: 'unknown-capacity',
    });
  });
  test('preserves the no-credit guard across every observed bucket, including other models', () => {
    for (const credits of [
      null,
      undefined,
      { hasCredits: true, unlimited: false },
      { hasCredits: false, unlimited: true },
      { hasCredits: false },
    ]) {
      expect(codexCapacity(codexSnapshot({ credits }))).toEqual({ kind: 'unavailable', reason: 'credits' });
    }
    expect(
      codexCapacity(codexSnapshot(), {
        other: codexSnapshot({
          limitId: 'alias',
          normalModelSlug: 'gpt-6-mini',
          credits: { hasCredits: true, unlimited: false },
        }),
      }),
    ).toEqual({ kind: 'unavailable', reason: 'credits' });
  });
});

describe('normalizeCodexAppServerQuotaObservation', () => {
  test('retains native denial and unknown availability without manufacturing a numeric window', () => {
    for (const rateLimitReachedType of ['rate_limit_reached', null]) {
      const result = normalizeCodexAppServerQuotaObservation({
        machineId: 'machine-1',
        observedAt: new Date(CODEX_NOW),
        result: {
          rateLimits: codexSnapshot(),
          rateLimitsByLimitId: {
            alias: codexSnapshot({ limitId: 'alias', normalModelSlug: 'gpt-6', primary: null, rateLimitReachedType }),
          },
        },
      });
      expect(result?.state).toBe('partial');
      expect(result?.windows[1]).toMatchObject({
        blocked: rateLimitReachedType !== null,
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        limitSeconds: null,
        scope: 'model',
      });
      expect(codexQuotaWindowModel(result?.windows[1]?.id ?? '')).toBe('gpt-6');
      expect(parseProviderQuotaObservation(result)).toEqual(result);
    }
  });
  test('preserves denial when a repeated bucket first reported healthy and retains distinct model buckets', () => {
    const result = normalizeCodexAppServerQuotaObservation({
      machineId: 'machine-1',
      observedAt: new Date(CODEX_NOW),
      result: {
        rateLimits: codexSnapshot(),
        rateLimitsByLimitId: {
          codex: codexSnapshot({ spendControlReached: true }),
          aliasA: codexSnapshot({ limitId: 'alias-a', normalModelSlug: 'gpt-6' }),
          aliasB: codexSnapshot({ limitId: 'alias-b', normalModelSlug: 'gpt-6' }),
        },
      },
    });
    expect(result?.windows.filter((window) => window.id === 'codex:primary')).toHaveLength(1);
    expect(result?.windows.find((window) => window.id === 'codex:primary')?.blocked).toBe(true);
    expect(result?.windows.filter((window) => codexQuotaWindowModel(window.id) === 'gpt-6')).toHaveLength(2);
  });
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

describe('projectLatestProviderQuotaObservation', () => {
  const firstSighting = observation('2026-07-15T10:00:00.000Z');

  test('dates a merged reading by its most recent confirmation', () => {
    const projected = projectLatestProviderQuotaObservation({
      lastObservedAt: '2026-07-15T10:20:00.000Z',
      observation: firstSighting,
    });
    const unconfirmed = projectLatestProviderQuotaObservation({
      lastObservedAt: firstSighting.observedAt,
      observation: firstSighting,
    });

    expect(projected.generatedAt).toBe('2026-07-15T10:20:00.000Z');
    expect({ ...projected, generatedAt: unconfirmed.generatedAt }).toEqual(unconfirmed);
    expect(projected).toEqual({
      generatedAt: '2026-07-15T10:20:00.000Z',
      key: 'codex',
      label: 'Codex',
      machineId: 'machine-1',
      plan: 'plus',
      source: 'live-api',
      state: 'ok',
      windows: firstSighting.windows,
    });
  });

  test('keeps the first sighting when the last observation is not later', () => {
    for (const lastObservedAt of ['2026-07-15T10:00:00.000Z', '2026-07-15T09:58:00.000Z', 'not-a-timestamp']) {
      expect(projectLatestProviderQuotaObservation({ lastObservedAt, observation: firstSighting }).generatedAt).toBe(
        '2026-07-15T10:00:00.000Z',
      );
    }
  });
});

describe('withoutSupersededUnscopedQuotaHeads', () => {
  interface Head {
    readonly accountScope: string | null;
    readonly lastObservedAt: string;
    readonly machineId: string;
    readonly providerKey: string;
  }
  const head = (
    accountScope: string | null,
    lastObservedAt: string,
    rest: Partial<Pick<Head, 'machineId' | 'providerKey'>> = {},
  ): Head => ({ accountScope, lastObservedAt, machineId: 'machine-1', providerKey: 'codex', ...rest });
  const facts = (item: Head) => item;
  const keep = (heads: readonly Head[]) =>
    withoutSupersededUnscopedQuotaHeads(heads, facts).map(({ accountScope }) => accountScope);

  // The real shape: the app-server wrote `codex` unscoped before it scoped by fingerprint, and the
  // rollout backfill still writes unscoped rows, so the unscoped head never goes away on its own.
  const unscoped = head(null, '2026-10-27T20:21:00.000Z');
  const scoped = head('ee40c8e243efcef5', '2026-10-27T21:33:00.000Z');

  test('drops the unscoped head once a scoped head of the same provider and machine is as recent', () => {
    expect(keep([unscoped, scoped])).toEqual(['ee40c8e243efcef5']);
    expect(keep([scoped, head(null, scoped.lastObservedAt)])).toEqual(['ee40c8e243efcef5']);
  });

  test('keeps an unscoped head that is newer than every scoped head', () => {
    const fresher = head(null, '2026-10-27T21:34:00.000Z');
    expect(keep([scoped, fresher])).toEqual(['ee40c8e243efcef5', null]);
  });

  test('treats an empty account scope as unscoped, like the store head key does', () => {
    expect(keep([head('', unscoped.lastObservedAt), scoped])).toEqual(['ee40c8e243efcef5']);
  });

  test('leaves other providers, other machines and scoped-only or unscoped-only groups alone', () => {
    const claude = head(null, '2026-10-27T18:00:00.000Z', { providerKey: 'claude' });
    const peerMachine = head(null, '2026-10-27T18:00:00.000Z', { machineId: 'machine-2' });
    const secondAccount = head('1234567890abcdef', '2026-10-27T19:00:00.000Z');
    expect(keep([claude, peerMachine, unscoped, scoped, secondAccount])).toEqual([
      null,
      null,
      'ee40c8e243efcef5',
      '1234567890abcdef',
    ]);
    expect(keep([claude])).toEqual([null]);
    expect(keep([scoped, secondAccount])).toEqual(['ee40c8e243efcef5', '1234567890abcdef']);
  });

  test('preserves the order it was given and never compares an unparseable confirmation', () => {
    const scopedFirst = withoutSupersededUnscopedQuotaHeads([scoped, head('x', '2026-10-27T19:00:00.000Z')], facts);
    expect(scopedFirst.map(({ accountScope }) => accountScope)).toEqual(['ee40c8e243efcef5', 'x']);
    expect(keep([head(null, 'not-a-timestamp'), scoped])).toEqual([null, 'ee40c8e243efcef5']);
    expect(keep([unscoped, head('x', 'not-a-timestamp')])).toEqual([null, 'x']);
    expect(withoutSupersededUnscopedQuotaHeads([], facts)).toEqual([]);
  });
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
