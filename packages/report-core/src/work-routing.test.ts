import { describe, expect, test } from 'bun:test';
import type { ProviderLimitWindow, ProviderStatus } from './provider-status';
import type { ExecutorDeclaration, ExecutorObservation } from './work-executors';
import {
  assessReviewRecommendation,
  type CandidateProvenanceMap,
  MAX_REVIEW_ROUTING_CANDIDATES,
  observedReviewCandidates,
  type QualifyReviewCandidatesInput,
  qualifyReviewCandidates,
  type ReviewCandidate,
  type ReviewRoutingInput,
  type ReviewRoutingPolicy,
  type ReviewTarget,
  recommendationKind,
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

const DECLARED_PROVENANCE: CandidateProvenanceMap = {
  accountScope: 'declared',
  authorization: 'declared',
  subscription: 'declared',
  availability: 'observed-now',
  capabilities: 'declared',
  quality: 'declared',
  quota: 'observed-now',
  model: 'unknown',
  effort: 'unknown',
};

const candidate = (harness: ReviewCandidate['harness'], overrides: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  id: harness,
  provenance: DECLARED_PROVENANCE,
  qualificationActions: [],
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

describe('qualifyReviewCandidates', () => {
  const MACHINE = TARGET.machineId;
  const declaration = (overrides: Partial<ExecutorDeclaration> = {}): ExecutorDeclaration => ({
    accountScope: 'personal',
    authorization: 'allowed',
    capabilities: ['read-only-review'],
    declaredAt: '2026-10-20T08:00:00.000Z',
    effort: null,
    harness: 'claude-code',
    machineId: MACHINE,
    model: null,
    quality: 'review-capable',
    subscription: 'verified',
    targets: [{ kind: 'any-local-session' }],
    ...overrides,
  });
  const observation = (overrides: Partial<ExecutorObservation> = {}): ExecutorObservation => ({
    authEvidence: 'claude auth status exit 0 loggedIn=true',
    authMethod: null,
    authState: 'logged-in',
    binaryPath: '/usr/bin/claude',
    harness: 'claude-code',
    machineId: MACHINE,
    observedAt: '2026-10-21T11:50:00.000Z',
    outcome: 'observed',
    version: '2.1.303 (Claude Code)',
    ...overrides,
  });
  /** A real stored key is bare (`claude`): the live collectors never record an account suffix. */
  const bareQuota = (family: 'claude' | 'codex', overrides: Partial<ProviderStatus> = {}): ProviderStatus =>
    quotaFixture(family === 'claude' ? 'claude-code' : 'codex', { key: family, plan: 'max', ...overrides });
  const codexObservation = (overrides: Partial<ExecutorObservation> = {}): ExecutorObservation =>
    observation({
      authEvidence: 'codex login status exit 0 (output mentions "Logged in")',
      binaryPath: '/usr/bin/codex',
      harness: 'codex',
      version: 'codex-cli 0.163.0',
      ...overrides,
    });
  const qualify = (overrides: Partial<QualifyReviewCandidatesInput> = {}) =>
    qualifyReviewCandidates({
      declarations: [declaration()],
      executorObservations: [observation()],
      now: NOW,
      providers: [bareQuota('claude')],
      target: TARGET,
      ...overrides,
    });
  const run = (candidates: readonly ReviewCandidate[], policy: Partial<ReviewRoutingPolicy> = {}) => {
    const result = simulate(candidates, { policy: { ...POLICY, ...policy } });
    return { recommendation: assessReviewRecommendation(result, candidates), result };
  };
  const only = (candidates: readonly ReviewCandidate[]): ReviewCandidate => {
    const [single] = candidates;
    if (!single || candidates.length !== 1) {
      throw new Error(`expected one candidate, got ${candidates.length}`);
    }
    return single;
  };

  test('a declared, observed and quota-backed Claude route is a real recommendation with per-field provenance', () => {
    const candidates = qualify();
    const claude = only(candidates);
    expect(claude).toMatchObject({
      accountScope: 'personal',
      authorization: 'allowed',
      authorizedTarget: TARGET,
      availability: 'available',
      capabilities: ['read-only-review'],
      harness: 'claude-code',
      id: `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`,
      machineId: MACHINE,
      qualificationActions: [],
      quality: 'review-capable',
      subscription: 'verified',
    });
    expect(claude.quota?.key).toBe('claude');
    expect(claude.quota?.plan).toBe('max');
    expect(claude.provenance).toEqual({
      accountScope: 'declared',
      authorization: 'declared',
      subscription: 'declared',
      availability: 'observed-now',
      capabilities: 'declared',
      quality: 'declared',
      quota: 'observed-now',
      model: 'unknown',
      effort: 'unknown',
    });
    const { recommendation, result } = run(candidates);
    expect(result.chosenCandidateId).toBe(claude.id);
    expect(recommendation).toEqual({ candidateId: claude.id, kind: 'real', missing: null });
    expect(recommendationKind(result, candidates)).toBe('real');
  });

  test('is deterministic for identical inputs regardless of input order', () => {
    const input: QualifyReviewCandidatesInput = {
      declarations: [declaration({ harness: 'codex', accountScope: 'work' }), declaration()],
      executorObservations: [
        codexObservation(),
        observation(),
        observation({ observedAt: '2026-10-21T11:00:00.000Z' }),
      ],
      now: NOW,
      providers: [bareQuota('codex'), bareQuota('claude')],
      target: TARGET,
    };
    const first = qualifyReviewCandidates(input);
    const second = qualifyReviewCandidates({
      ...input,
      declarations: [...input.declarations].reverse(),
      executorObservations: [...input.executorObservations].reverse(),
      providers: [...input.providers].reverse(),
    });
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.harness)).toEqual(['claude-code', 'codex']);
    expect(first.every((entry) => entry.availability === 'available')).toBe(true);
  });

  test('prefers Claude between two real candidates and Codex when the preference says so', () => {
    const candidates = qualify({
      declarations: [declaration(), declaration({ harness: 'codex', accountScope: 'work' })],
      executorObservations: [observation(), codexObservation()],
      providers: [bareQuota('claude'), bareQuota('codex')],
    });
    expect(run(candidates).result.chosenCandidateId).toContain('claude-code');
    expect(run(candidates, { preferredHarness: 'codex' }).result.chosenCandidateId).toContain('"codex"');
    expect(run(candidates).recommendation.kind).toBe('real');
  });

  test('an observed Codex without a declaration is excluded with the exact declaration to add', () => {
    const candidates = qualify({
      executorObservations: [observation(), codexObservation()],
      providers: [bareQuota('claude'), bareQuota('codex')],
    });
    const codex = candidates.find((entry) => entry.harness === 'codex');
    expect(codex).toMatchObject({
      accountScope: null,
      authorization: 'unknown',
      availability: 'available',
      id: `observed:${JSON.stringify([MACHINE, 'codex', null])}`,
      subscription: 'unverified',
    });
    expect(codex?.provenance).toMatchObject({
      accountScope: 'unknown',
      authorization: 'unknown',
      availability: 'observed-now',
    });
    expect(codex?.qualificationActions).toEqual([
      "Add routing.executors[] for codex:<accountScope> with authorization 'allowed', targets [{kind:'any-local-session'}], subscription 'verified', declaredAt",
    ]);
    const { recommendation, result } = run(candidates);
    expect(result.chosenCandidateId).toContain('claude-code');
    expect(recommendation.kind).toBe('real');
    expect(excluded(result, codex?.id ?? '')).toContain('Review authorization is not established');
  });

  test('a declaration without any quota observation is conditional on exactly that observation', () => {
    const candidates = qualify({ providers: [] });
    const claude = only(candidates);
    expect(claude.quota).toBeNull();
    expect(claude.provenance.quota).toBe('unknown');
    expect(claude.qualificationActions).toEqual([
      'Refresh quota observations (ai-usage quota --json or wait for the 5-minute source)',
    ]);
    const { recommendation, result } = run(candidates);
    expect(result.chosenCandidateId).toBeNull();
    expect(recommendation).toEqual({ candidateId: claude.id, kind: 'conditional', missing: 'quota observation' });
  });

  test('a stale executor observation leaves availability unknown and the recommendation conditional', () => {
    const candidates = qualify({ executorObservations: [observation({ observedAt: '2026-10-21T10:00:00.000Z' })] });
    const claude = only(candidates);
    expect(claude.availability).toBe('unknown');
    expect(claude.provenance.availability).toBe('stale');
    expect(claude.qualificationActions.join(' ')).toContain('Refresh executor observations');
    expect(claude.qualificationActions.join(' ')).toContain('last observed 2026-10-21T10:00:00.000Z');
    expect(run(candidates).recommendation).toEqual({
      candidateId: claude.id,
      kind: 'conditional',
      missing: 'executor availability observation',
    });
    const missing = only(qualify({ executorObservations: [] }));
    expect(missing.provenance.availability).toBe('unknown');
    expect(run([missing]).recommendation.kind).toBe('conditional');
  });

  test('a signed-out or absent CLI is unavailable now, with the sign-in or install action', () => {
    const loggedOut = only(qualify({ executorObservations: [observation({ authState: 'logged-out' })] }));
    expect(loggedOut).toMatchObject({ availability: 'unavailable', provenance: { availability: 'observed-now' } });
    expect(loggedOut.qualificationActions).toEqual(['Sign in the Claude Code CLI (claude auth login)']);
    const absent = only(
      qualify({ executorObservations: [observation({ binaryPath: null, outcome: 'unavailable', version: null })] }),
    );
    expect(absent.qualificationActions).toEqual([`Install the Claude Code CLI (claude) on machine ${MACHINE}`]);
    const codexOut = only(
      qualify({
        declarations: [declaration({ harness: 'codex' })],
        executorObservations: [codexObservation({ authState: 'logged-out' })],
        providers: [bareQuota('codex')],
      }),
    );
    expect(codexOut.qualificationActions).toEqual(['Sign in the Codex CLI (codex login)']);
    for (const entry of [loggedOut, absent, codexOut]) {
      expect(run([entry]).recommendation.kind).toBe('none');
    }
  });

  test('a stale or crossed-reset quota is named precisely and never restored', () => {
    const stale = only(qualify({ providers: [bareQuota('claude', { generatedAt: '2026-10-21T11:40:00.000Z' })] }));
    expect(stale.provenance.quota).toBe('stale');
    expect(stale.qualificationActions).toEqual([
      'Refresh quota observations (ai-usage quota --json or wait for the 5-minute source); last observed 2026-10-21T11:40:00.000Z',
    ]);
    expect(run([stale]).recommendation).toEqual({
      candidateId: stale.id,
      kind: 'conditional',
      missing: 'quota observation',
    });

    const crossed = only(
      qualify({
        providers: [bareQuota('claude', { windows: [windowFixture({ resetsAt: '2026-10-21T11:30:00.000Z' })] })],
      }),
    );
    expect(crossed.qualificationActions).toEqual(['Quota window 5h crossed its reset: a new observation is required']);
    const crossedRun = run([crossed]);
    expect(crossedRun.result.chosenCandidateId).toBeNull();
    expect(excluded(crossedRun.result, crossed.id)).toContain('crossed its observed reset');
  });

  test('an exhausted window excludes the route and the five-hour and weekly windows are never summed', () => {
    const windows = [
      windowFixture({ id: 'primary', label: '5h', usedPercent: 10, remainingPercent: 90 }),
      windowFixture({
        blocked: true,
        group: '7d',
        id: 'secondary',
        label: 'Weekly',
        remainingPercent: 0,
        resetsAt: '2026-10-25T00:00:00.000Z',
        usedPercent: 100,
      }),
    ];
    const exhausted = only(qualify({ providers: [bareQuota('claude', { windows })] }));
    expect(exhausted.qualificationActions).toEqual([
      'Quota window Weekly is exhausted; wait for its reset at 2026-10-25T00:00:00.000Z',
    ]);
    const exhaustedRun = run([exhausted]);
    expect(exhaustedRun.result.chosenCandidateId).toBeNull();
    expect(excluded(exhaustedRun.result, exhausted.id)).toContain('Weekly is exhausted');
    expect(exhaustedRun.recommendation.kind).toBe('none');

    const lopsided = only(
      qualify({
        providers: [
          bareQuota('claude', {
            windows: [
              windowFixture({ id: 'primary', label: '5h', usedPercent: 95, remainingPercent: 5 }),
              windowFixture({ group: '7d', id: 'secondary', label: 'Weekly', usedPercent: 5, remainingPercent: 95 }),
            ],
          }),
        ],
      }),
    );
    expect(run([lopsided]).recommendation.kind).toBe('real');
  });

  test("several models on one account are one resource; another model's window is not counted, an undeclared model is", () => {
    const windows = [
      windowFixture({ id: 'five_hour', label: '5h' }),
      windowFixture({ group: 'weekly', id: 'seven_day', label: 'Weekly', resetsAt: '2026-10-25T00:00:00.000Z' }),
      windowFixture({ group: 'weekly', id: 'model:Opus', label: 'Opus · Weekly', scope: 'model' }),
      windowFixture({
        blocked: true,
        group: 'weekly',
        id: 'model:Sonnet',
        label: 'Sonnet · Weekly',
        remainingPercent: 0,
        scope: 'model',
        usedPercent: 100,
      }),
    ];
    const opus = qualify({
      declarations: [declaration({ model: 'Opus' })],
      providers: [bareQuota('claude', { windows })],
    });
    expect(opus).toHaveLength(1);
    const opusRun = run(opus);
    expect(opusRun.result.chosenCandidateId).toBe(opus[0]?.id ?? null);
    expect(opusRun.result.evaluations[0]?.missingData).toContain(
      'Quota window Sonnet · Weekly applies to another model than Opus; not counted.',
    );
    const sonnet = run(
      qualify({ declarations: [declaration({ model: 'Sonnet' })], providers: [bareQuota('claude', { windows })] }),
    );
    expect(sonnet.result.chosenCandidateId).toBeNull();
    const undeclared = only(qualify({ providers: [bareQuota('claude', { windows })] }));
    expect(undeclared.qualificationActions).toEqual([
      'Declare routing.executors[].model for claude:personal: the quota reports model-scoped windows (model:Opus, model:Sonnet) that cannot be attributed without it',
    ]);
    expect(run([undeclared]).result.chosenCandidateId).toBeNull();
  });

  test('a declaration for another account does not bind a scoped quota stream, which stays an observed candidate', () => {
    const candidates = qualify({
      declarations: [declaration({ accountScope: 'other' })],
      providers: [bareQuota('claude', { key: 'claude:personal' })],
    });
    expect(candidates.map((entry) => entry.id.split(':')[0])).toEqual(['declared', 'observed']);
    const declared = candidates.find((entry) => entry.id.startsWith('declared:'));
    const observed = candidates.find((entry) => entry.id.startsWith('observed:'));
    expect(declared?.quota).toBeNull();
    expect(declared?.qualificationActions).toEqual([
      `Quota streams for claude on machine ${MACHINE} are account-scoped (personal); set routing.executors[].accountScope to one of them`,
    ]);
    expect(observed).toMatchObject({ accountScope: 'personal', authorization: 'unknown' });
    expect(observed?.qualificationActions[0]).toBe(
      "Add routing.executors[] for claude:personal with authorization 'allowed', targets [{kind:'any-local-session'}], subscription 'verified', declaredAt",
    );
    expect(run(candidates).result.chosenCandidateId).toBeNull();
  });

  test('two declarations for one family on one machine cannot share an unscoped quota stream', () => {
    const candidates = qualify({
      declarations: [declaration(), declaration({ accountScope: 'work' })],
    });
    const declared = candidates.filter((entry) => entry.id.startsWith('declared:'));
    expect(declared).toHaveLength(2);
    expect(declared.every((entry) => entry.quota === null)).toBe(true);
    expect(
      declared.every((entry) =>
        entry.qualificationActions.some((action) =>
          action.startsWith('Quota attribution is ambiguous: 2 routing.executors[] entries'),
        ),
      ),
    ).toBe(true);
    // The unbound stream stays visible as an observed-only candidate rather than disappearing.
    expect(candidates.filter((entry) => entry.id.startsWith('observed:'))).toHaveLength(1);
    expect(run(candidates).result.chosenCandidateId).toBeNull();
  });

  test('a declaration bound to another project does not authorize this session', () => {
    const forbiddenTarget = only(
      qualify({
        declarations: [declaration({ targets: [{ kind: 'project', projectLabel: 'alpha' }] })],
        target: { ...TARGET, projectLabel: 'beta' },
      }),
    );
    expect(forbiddenTarget.authorizedTarget).toBeNull();
    expect(forbiddenTarget.qualificationActions).toEqual([
      "Declared targets do not admit this session (project 'beta'): add {kind:'project', projectLabel:'beta'} or {kind:'any-local-session'} to routing.executors[] for claude:personal",
    ]);
    const forbiddenRun = run([forbiddenTarget]);
    expect(forbiddenRun.result.chosenCandidateId).toBeNull();
    expect(forbiddenRun.recommendation.kind).toBe('none');

    const admitted = only(
      qualify({
        declarations: [declaration({ targets: [{ kind: 'project', projectLabel: 'alpha' }] })],
        target: { ...TARGET, projectLabel: 'alpha' },
      }),
    );
    expect(admitted.authorizedTarget).toEqual({ ...TARGET, projectLabel: 'alpha' });
    expect(run([admitted]).recommendation.kind).toBe('real');

    const unselected = only(qualify({ target: null }));
    expect(unselected.authorizedTarget).toBeNull();
    expect(unselected.qualificationActions).toEqual([
      'Select a session with a machine and native identity to bind the authorization to a target',
    ]);
  });

  test('declared API billing, a forbidden declaration and a forced forbidden candidate never qualify', () => {
    const api = only(qualify({ declarations: [declaration({ subscription: 'api' })] }));
    expect(api.qualificationActions[0]).toContain("Declared subscription 'api'");
    expect(excluded(run([api]).result, api.id)).toContain('API billing');

    const forbidden = only(qualify({ declarations: [declaration({ authorization: 'forbidden' })] }));
    expect(forbidden.qualificationActions).toEqual([]);
    const forced = run([forbidden], { forcedCandidateId: forbidden.id });
    expect(forced.result.chosenCandidateId).toBeNull();
    expect(forced.result.reasons.join(' ')).toContain('cannot bypass constraints');
    expect(forced.recommendation.kind).toBe('none');
  });

  test('a fresh API-key sign-in contradicts a declared verified subscription and excludes the candidate', () => {
    for (const authMethod of ['api-key', 'console', 'apiKey']) {
      const contradicted = only(qualify({ executorObservations: [observation({ authMethod })] }));
      expect(contradicted.subscription).toBe('api');
      expect(contradicted.provenance.subscription).toBe('observed-now');
      expect(contradicted.availability).toBe('available');
      expect(contradicted.qualificationActions).toEqual([
        `subscription: declared verified, but the CLI reports API-key authentication (authMethod ${authMethod} observed 2026-10-21T11:50:00.000Z); sign claude in with the subscription account or declare 'api'`,
      ]);
      const { recommendation, result } = run([contradicted]);
      expect(result.chosenCandidateId).toBeNull();
      expect(excluded(result, contradicted.id)).toContain('API billing observed from the CLI sign-in');
      expect(recommendation.kind).toBe('none');
    }
    // A subscription sign-in, no named method, or a stale API-key observation leaves the declaration as written.
    for (const observed of [
      observation({ authMethod: 'claude.ai' }),
      observation(),
      observation({ authMethod: 'api-key', observedAt: '2026-10-21T10:00:00.000Z' }),
    ]) {
      const kept = only(qualify({ executorObservations: [observed] }));
      expect(kept.subscription).toBe('verified');
      expect(kept.provenance.subscription).toBe('declared');
    }
    // A declaration that already says 'api' keeps its own, declared, reason.
    const declaredApi = only(
      qualify({
        declarations: [declaration({ subscription: 'api' })],
        executorObservations: [observation({ authMethod: 'api-key' })],
      }),
    );
    expect(declaredApi.provenance.subscription).toBe('declared');
    expect(excluded(run([declaredApi]).result, declaredApi.id)).toContain('API billing is outside');
  });

  test("a declaration for another machine cannot review this machine's session", () => {
    const elsewhere = only(
      qualify({
        declarations: [declaration({ machineId: 'machine-b' })],
        executorObservations: [observation({ machineId: 'machine-b' })],
        providers: [bareQuota('claude', { machineId: 'machine-b' })],
      }),
    );
    expect(elsewhere.availability).toBe('available');
    const result = run([elsewhere]).result;
    expect(result.chosenCandidateId).toBeNull();
    expect(excluded(result, elsewhere.id)).toContain('cannot access this machine-scoped session');
  });

  test('the observed plan is carried as evidence beside the declaration, never as verification', () => {
    const candidates = qualify({
      declarations: [],
      executorObservations: [],
      providers: [bareQuota('claude', { plan: 'max' })],
    });
    const observed = only(candidates);
    expect(observed.quota?.plan).toBe('max');
    expect(observed.subscription).toBe('unverified');
    expect(observed.provenance.subscription).toBe('unknown');
  });

  test('rejects a non-canonical reference time instead of guessing freshness', () => {
    expect(() => qualify({ now: 'now' })).toThrow(RangeError);
  });
});
