import { describe, expect, test } from 'bun:test';
import type { ProviderLimitWindow, ProviderStatus } from './provider-status';
import {
  MAX_REVIEW_ROUTING_CANDIDATES,
  observedReviewCandidates,
  type ReviewCandidate,
  type ReviewRoutingInput,
  type ReviewRoutingPolicy,
  type ReviewTarget,
  simulateWorkReviewRouting,
} from './work-routing';

const NOW = '2026-10-21T12:00:00.000Z';
const RECENT = '2026-10-21T11:59:00.000Z';
const TARGET: ReviewTarget = {
  kind: 'session',
  machineId: 'machine-a',
  harness: 'claude',
  sourceSessionId: 'session-a',
};
const POLICY: ReviewRoutingPolicy = {
  preferredHarness: 'claude-code',
  preferNearReset: false,
  nearResetMinutes: 30,
  forcedCandidateId: null,
};

const windowFixture = (overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow => ({
  blocked: false,
  group: '5h',
  id: 'primary',
  label: '5h',
  limitSeconds: 18_000,
  remainingPercent: 50,
  resetsAt: '2026-10-21T16:00:00.000Z',
  scope: 'global',
  usedPercent: 50,
  ...overrides,
});

const quotaFixture = (
  harness: ReviewCandidate['harness'],
  overrides: Partial<ProviderStatus> = {},
): ProviderStatus => ({
  generatedAt: RECENT,
  key: `${harness === 'claude-code' ? 'claude' : 'codex'}:${harness}-account`,
  label: harness,
  machineId: TARGET.machineId,
  machineLabel: 'Fixture machine',
  plan: 'Fixture subscription',
  source: 'live-api',
  state: 'ok',
  windows: [windowFixture()],
  ...overrides,
});

const candidate = (harness: ReviewCandidate['harness'], overrides: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  id: harness,
  machineId: TARGET.machineId,
  machineLabel: 'Fixture machine',
  accountScope: `${harness}-account`,
  harness,
  model: null,
  effort: null,
  authorization: 'allowed',
  authorizedTarget: TARGET,
  subscription: 'verified',
  availability: 'available',
  capabilities: ['read-only-review'],
  quality: 'review-capable',
  quota: quotaFixture(harness),
  evidence: { source: 'Synthetic qualification fixture', observedAt: RECENT },
  ...overrides,
});

const simulate = (candidates: readonly ReviewCandidate[], overrides: Partial<ReviewRoutingInput> = {}) =>
  simulateWorkReviewRouting({
    candidates,
    policy: POLICY,
    referenceTime: NOW,
    request: {
      action: 'read-only-review',
      target: TARGET,
      requiredCapabilities: ['read-only-review'],
      minimumQuality: 'review-capable',
    },
    ...overrides,
  });

const excluded = (result: ReturnType<typeof simulate>, id: string) =>
  result.evaluations.find((entry) => entry.candidateId === id)?.exclusionReasons.join(' ');

describe('read-only review routing simulation', () => {
  test('applies a configurable harness preference only after constraints and does not compare offer percentages', () => {
    const claude = candidate('claude-code', {
      quota: quotaFixture('claude-code', { windows: [windowFixture({ usedPercent: 95, remainingPercent: 5 })] }),
    });
    const codex = candidate('codex', {
      quota: quotaFixture('codex', { windows: [windowFixture({ usedPercent: 5, remainingPercent: 95 })] }),
    });
    expect(simulate([codex, claude]).chosenCandidateId).toBe('claude-code');
    expect(simulate([claude, codex], { policy: { ...POLICY, preferredHarness: 'codex' } }).chosenCandidateId).toBe(
      'codex',
    );
    expect(simulate([claude, codex]).reasons.join(' ')).toContain('never compared by percentage');
  });

  test('selects eligible Codex when the preferred Claude candidate is forbidden', () => {
    const result = simulate([candidate('claude-code', { authorization: 'forbidden' }), candidate('codex')]);
    expect(result.chosenCandidateId).toBe('codex');
    expect(excluded(result, 'claude-code')).toContain('forbidden');
  });

  test('an explicit override can select eligible Codex but cannot authorize a forbidden or absent candidate', () => {
    const policy = { ...POLICY, forcedCandidateId: 'codex' };
    expect(simulate([candidate('claude-code'), candidate('codex')], { policy }).chosenCandidateId).toBe('codex');
    expect(
      simulate([candidate('claude-code'), candidate('codex', { authorization: 'forbidden' })], { policy })
        .chosenCandidateId,
    ).toBeNull();
    expect(
      simulate([candidate('claude-code'), candidate('codex')], { policy: { ...POLICY, forcedCandidateId: 'absent' } })
        .chosenCandidateId,
    ).toBeNull();
  });

  test('returns no choice when all candidates are forbidden and explains missing observations', () => {
    const result = simulate([
      candidate('claude-code', { authorization: 'forbidden', quota: null }),
      candidate('codex', { authorization: 'forbidden' }),
    ]);
    expect(result.chosenCandidateId).toBeNull();
    expect(result.evaluations.every((entry) => !entry.eligible)).toBe(true);
    expect(result.evaluations.find((entry) => entry.candidateId === 'claude-code')?.missingData).toContain(
      'Quota observation',
    );
    expect(simulate([]).reasons.join(' ')).toContain('No observed candidates');
  });

  test.each(['live-api', 'local-history'] as const)('reuses feed freshness for stale %s observations', (source) => {
    const stale = candidate('claude-code', {
      quota: quotaFixture('claude-code', { source, generatedAt: '2026-10-21T11:44:59.000Z' }),
    });
    const result = simulate([stale, candidate('codex')]);
    expect(result.chosenCandidateId).toBe('codex');
    expect(excluded(result, 'claude-code')).toContain('stale');
  });

  test('a current session-log observation can qualify when every other condition is explicitly known', () => {
    expect(
      simulate([
        candidate('claude-code', { quota: quotaFixture('claude-code', { source: 'local-history' }) }),
        candidate('codex'),
      ]).chosenCandidateId,
    ).toBe('claude-code');
  });

  test.each([
    'partial',
    'unsupported',
    'stale',
    'error',
    'auth-required',
  ] as const)('excludes %s quota without manufacturing capacity', (state) => {
    const result = simulate([
      candidate('claude-code', { quota: quotaFixture('claude-code', { state }) }),
      candidate('codex'),
    ]);
    expect(result.chosenCandidateId).toBe('codex');
    expect(excluded(result, 'claude-code')).toContain(state);
  });

  test('prefers an eligible near-reset Codex window before the harness preference, without granting authorization', () => {
    const codex = candidate('codex', {
      quota: quotaFixture('codex', { windows: [windowFixture({ resetsAt: '2026-10-21T12:10:00.000Z' })] }),
    });
    const policy = { ...POLICY, preferNearReset: true };
    expect(simulate([candidate('claude-code'), codex], { policy }).chosenCandidateId).toBe('codex');
    expect(
      simulate([candidate('claude-code'), { ...codex, authorization: 'forbidden' }], { policy }).chosenCandidateId,
    ).toBe('claude-code');
    expect(
      simulate([candidate('claude-code'), codex], { policy: { ...policy, nearResetMinutes: 5 } }).chosenCandidateId,
    ).toBe('claude-code');
  });

  test('does not restore an exhausted or crossed-reset window', () => {
    for (const window of [
      windowFixture({ blocked: true, usedPercent: 100, remainingPercent: 0, resetsAt: '2026-10-21T12:01:00.000Z' }),
      windowFixture({ resetsAt: NOW }),
      windowFixture({ resetsAt: '2026-10-21T11:59:30.000Z' }),
    ]) {
      const result = simulate(
        [candidate('claude-code', { quota: quotaFixture('claude-code', { windows: [window] }) }), candidate('codex')],
        { policy: { ...POLICY, preferNearReset: true } },
      );
      expect(result.chosenCandidateId).toBe('codex');
      expect(result.evaluations.find((entry) => entry.candidateId === 'claude-code')?.eligible).toBe(false);
    }
  });

  test.each([
    { quota: quotaFixture('claude-code', { machineId: 'another-machine' }) },
    { quota: quotaFixture('claude-code', { key: 'claude:another-account' }) },
    { quota: quotaFixture('claude-code', { key: 'codex:claude-code-account' }) },
    { accountScope: null },
    { machineId: 'another-machine' },
    { machineId: null },
    { authorizedTarget: { ...TARGET, sourceSessionId: 'another-session' } },
    { authorizedTarget: null },
    { authorization: 'unknown' as const },
    { subscription: 'api' as const },
    { subscription: 'unverified' as const },
    { availability: 'unavailable' as const },
    { availability: 'unknown' as const },
    { quality: 'unknown' as const },
    { capabilities: [] },
  ])('enforces target, execution qualification and quota attribution: %j', (override) => {
    const result = simulate([candidate('claude-code', override), candidate('codex')]);
    expect(result.chosenCandidateId).toBe('codex');
    expect(result.evaluations.find((entry) => entry.candidateId === 'claude-code')?.eligible).toBe(false);
  });

  test.each([
    'invalid',
    '2026-10-21T12:01:00.000Z',
    '2026-02-30T12:00:00.000Z',
  ])('rejects invalid or future timestamps: %s', (observedAt) => {
    for (const override of [
      { quota: quotaFixture('claude-code', { generatedAt: observedAt }) },
      { evidence: { source: 'Fixture', observedAt } },
    ]) {
      expect(simulate([candidate('claude-code', override), candidate('codex')]).chosenCandidateId).toBe('codex');
    }
  });

  test.each(
    [
      [],
      [windowFixture({ usedPercent: null, remainingPercent: null })],
      [windowFixture({ remainingPercent: 90 })],
      [windowFixture({ resetsAt: null })],
      [windowFixture({ resetsAt: 'invalid' })],
      [windowFixture({ scope: 'unknown' })],
      [windowFixture(), windowFixture()],
      [windowFixture({ scope: 'model', group: 'specific-model' })],
    ].map((windows) => ({ windows })),
  )('rejects absent, ambiguous, contradictory or unqualified windows: %j', ({ windows }) => {
    expect(
      simulate([candidate('claude-code', { quota: quotaFixture('claude-code', { windows }) }), candidate('codex')])
        .chosenCandidateId,
    ).toBe('codex');
  });

  test('does not duplicate a quota scope across invented candidates or accounts', () => {
    const claude = candidate('claude-code');
    const result = simulate([
      claude,
      { ...claude, id: 'invented', accountScope: 'invented-account' },
      candidate('codex'),
    ]);
    expect(result.chosenCandidateId).toBe('codex');
    expect(excluded(result, 'claude-code')).toContain('multiple candidates');
    expect(excluded(result, 'invented')).toContain('does not match');
    const duplicate = simulate([claude, { ...candidate('codex'), id: claude.id }]);
    expect(duplicate.chosenCandidateId).toBeNull();
    expect(
      duplicate.evaluations.every((entry) => entry.exclusionReasons.some((reason) => reason.includes('duplicated'))),
    ).toBe(true);
  });

  test('is deterministic under candidate reordering and leaves its input untouched', () => {
    const candidates = [candidate('claude-code'), candidate('codex')];
    const before = JSON.stringify(candidates);
    const result = simulate(candidates, { policy: { ...POLICY, preferredHarness: null } });
    expect(simulate([...candidates].reverse(), { policy: { ...POLICY, preferredHarness: null } })).toEqual(result);
    expect(JSON.stringify(candidates)).toBe(before);
    expect(result.chosenCandidateId).toBe('claude-code');
  });

  test('reports invalid reference time, policy, request and candidate bounds as explicit no choice', () => {
    const candidates = [candidate('claude-code'), candidate('codex')];
    expect(simulate(candidates, { referenceTime: 'invalid' }).chosenCandidateId).toBeNull();
    expect(simulate(candidates, { policy: { ...POLICY, nearResetMinutes: -1 } }).chosenCandidateId).toBeNull();
    expect(simulate(candidates, { policy: { ...POLICY, nearResetMinutes: Number.NaN } }).chosenCandidateId).toBeNull();
    const invalidRequest = {
      action: 'read-only-review' as const,
      target: TARGET,
      requiredCapabilities: [],
      minimumQuality: 'review-capable' as const,
    };
    expect(simulate(candidates, { request: invalidRequest }).chosenCandidateId).toBeNull();
    const oversized = simulate(
      Array.from({ length: MAX_REVIEW_ROUTING_CANDIDATES + 1 }, (_, index) =>
        candidate('codex', { id: String(index) }),
      ),
    );
    expect(oversized.chosenCandidateId).toBeNull();
    expect(oversized.reasons.join(' ')).toContain('no subset was silently selected');
  });
});

describe('observed review candidates', () => {
  test('preserves real scopes including colons and leaves every execution qualification unknown', () => {
    const providers = [
      quotaFixture('claude-code', { key: 'claude', accountLabel: 'display label is not an identity' }),
      quotaFixture('codex', { key: 'codex:scope:with:colons' }),
      { ...quotaFixture('codex'), key: 'cursor:irrelevant' },
    ];
    const observed = observedReviewCandidates(providers);
    expect(observed).toHaveLength(2);
    expect(observed.find((entry) => entry.harness === 'claude-code')?.accountScope).toBeNull();
    expect(observed.find((entry) => entry.harness === 'codex')?.accountScope).toBe('scope:with:colons');
    expect(
      observed.every(
        (entry) =>
          entry.authorization === 'unknown' &&
          entry.subscription === 'unverified' &&
          entry.availability === 'unknown' &&
          entry.quality === 'unknown' &&
          entry.capabilities.length === 0,
      ),
    ).toBe(true);
    expect(simulate(observed).chosenCandidateId).toBeNull();
    expect(observedReviewCandidates([...providers].reverse())).toEqual(observed);
    expect(observedReviewCandidates([])).toEqual([]);
  });

  test('does not invent a machine or account and marks duplicate observed scopes ambiguous', () => {
    const provider = quotaFixture('codex');
    const { machineId: _machineId, ...withoutMachine } = provider;
    expect(observedReviewCandidates([withoutMachine])[0]?.machineId).toBeNull();
    const ambiguous = observedReviewCandidates([provider, { ...provider, generatedAt: NOW }]);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.quota).toBeNull();
    expect(ambiguous[0]?.evidence.source).toContain('Ambiguous');
    expect(observedReviewCandidates([{ ...provider, generatedAt: NOW }, provider])).toEqual(ambiguous);
  });
});
