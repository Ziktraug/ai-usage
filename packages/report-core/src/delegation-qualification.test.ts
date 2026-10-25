import { describe, expect, test } from 'bun:test';
import type {
  DelegationCheckoutFacts,
  DelegationConfig,
  DelegationQualification,
  DelegationRequest,
  DelegationSelection,
  FrozenDelegationScope,
  ResolvedDelegationCheckout,
} from './delegation-contracts';
import { DEFAULT_DELEGATION_CONFIG } from './delegation-policy';
import {
  DELEGATION_QUALIFICATION_BOUNDS,
  decideDelegationLaunch,
  ORDER_HINT_ASSUMPTION,
  observedAccountChangeAt,
  parseDelegationQualification,
  type QualifyDelegationInput,
  qualifyDelegation,
} from './delegation-qualification';
import { DELEGATION_BOUNDS, type DelegationRefusalReason } from './delegation-vocabulary';
import type { ProviderLimitWindow, ProviderStatus } from './provider-status';
import type { ExecutorDeclaration, ExecutorObservation } from './work-executors';

const NOW = '2026-10-21T12:00:00.000Z';
const MACHINE = 'machine-a';
const CHECKOUT_PATH = '/home/operator/projects/alpha';
const QUALIFICATION_ID = '0f8d2c4e-9a1b-4c3d-8e7f-123456789abc';
const RETRY_OF = '2f8d2c4e-9a1b-4c3d-8e7f-123456789abc';
const DIGEST = 'a'.repeat(64);
const FINGERPRINT = '0123456789abcdef';
const OTHER_FINGERPRINT = 'fedcba9876543210';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HEAD_SHA = '1'.repeat(40);
const OPUS_ID = `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`;
const SONNET_ID = `${OPUS_ID}:model:1:Sonnet`;
const CODEX_ID = `declared:${JSON.stringify([MACHINE, 'codex', 'work'])}`;

const window = (overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow => ({
  blocked: false,
  group: '5h',
  id: 'five_hour',
  label: '5h',
  limitSeconds: 18_000,
  remainingPercent: 50,
  resetsAt: '2026-10-21T16:00:00.000Z',
  scope: 'global',
  usedPercent: 50,
  ...overrides,
});
const WEEKLY = window({
  group: 'weekly',
  id: 'seven_day',
  label: 'Weekly',
  remainingPercent: 60,
  resetsAt: '2026-10-25T00:00:00.000Z',
  usedPercent: 40,
});
const OPUS_WEEKLY = window({
  group: 'weekly',
  id: 'model:Opus',
  label: 'Opus · Weekly',
  remainingPercent: 70,
  resetsAt: '2026-10-25T00:00:00.000Z',
  scope: 'model',
  usedPercent: 30,
});

const quota = (overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  generatedAt: '2026-10-21T11:59:00.000Z',
  key: 'claude',
  label: 'Claude',
  machineId: MACHINE,
  machineLabel: 'Fixture machine',
  plan: 'max',
  source: 'live-api',
  state: 'ok',
  windows: [window(), WEEKLY, OPUS_WEEKLY],
  ...overrides,
});
const codexQuota = (overrides: Partial<ProviderStatus> = {}): ProviderStatus =>
  quota({ key: 'codex', label: 'Codex', windows: [window(), WEEKLY], ...overrides });

const declaration = (overrides: Partial<ExecutorDeclaration> = {}): ExecutorDeclaration => ({
  accountFingerprint: FINGERPRINT,
  accountScope: 'personal',
  alternateModels: ['Sonnet'],
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-20T08:00:00.000Z',
  effort: null,
  harness: 'claude-code',
  machineId: MACHINE,
  model: 'Opus',
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
  ...overrides,
});
/** Codex exposes no fingerprint, so its declaration pins none (ADR 0057: `not-observable`). */
const codexDeclaration = (overrides: Partial<ExecutorDeclaration> = {}): ExecutorDeclaration => {
  const { accountFingerprint: _ignored, ...base } = declaration({
    accountScope: 'work',
    alternateModels: [],
    harness: 'codex',
    model: null,
    ...overrides,
  });
  return base;
};
const observation = (overrides: Partial<ExecutorObservation> = {}): ExecutorObservation => ({
  accountFingerprint: FINGERPRINT,
  authEvidence: 'claude auth status exit 0 loggedIn=true',
  authMethod: 'claude.ai',
  authState: 'logged-in',
  binaryPath: '/usr/bin/claude',
  harness: 'claude-code',
  machineId: MACHINE,
  observedAt: '2026-10-21T11:50:00.000Z',
  outcome: 'observed',
  version: '2.1.303 (Claude Code)',
  ...overrides,
});
const codexObservation = (overrides: Partial<ExecutorObservation> = {}): ExecutorObservation => {
  const { accountFingerprint: _ignored, ...base } = observation({
    authEvidence: 'codex login status exit 0',
    authMethod: null,
    binaryPath: '/usr/bin/codex',
    harness: 'codex',
    version: 'codex-cli 0.163.0',
    ...overrides,
  });
  return base;
};

const REQUEST: DelegationRequest = {
  action: 'read-only-review',
  checkout: { path: CHECKOUT_PATH },
  constraints: [],
  criteria: ['Bounds are tested'],
  objective: 'Review the parser change.',
  schemaVersion: 1,
  scope: { commit: 'HEAD', kind: 'commit' },
  taskCategory: 'correctness',
};
const CHECKOUT: ResolvedDelegationCheckout = {
  admittedBy: '/home/operator/projects',
  path: CHECKOUT_PATH,
  projectLabel: 'alpha',
};
const SCOPE: FrozenDelegationScope = {
  base: 'first-parent',
  baseRef: 'HEAD^',
  baseSha: EMPTY_TREE,
  commitCount: 1,
  headRef: 'HEAD',
  headSha: HEAD_SHA,
  kind: 'commit',
};
const FACTS: DelegationCheckoutFacts = {
  gitAuthorEmail: { provenance: 'observed', source: 'git config user.email', value: 'dev@example.test' },
  githubAccount: { provenance: 'declared', source: 'github.accounts[owner=acme]', value: 'dev-acme' },
  githubOwners: { provenance: 'observed', source: 'git remote -v', value: ['acme'] },
  repositories: { provenance: 'observed', source: 'git remote -v', value: ['acme/alpha'] },
};
const CONFIG: DelegationConfig = {
  ...DEFAULT_DELEGATION_CONFIG,
  routes: [
    { accountScope: 'personal', context: 'personal', harness: 'claude-code', machineId: MACHINE },
    { accountScope: 'work', context: 'professional', harness: 'codex', machineId: MACHINE },
  ],
};
const CONTROLS: QualifyDelegationInput['harnessControls'] = {
  'claude-code': { controls: ['tools Read, Grep, Glob', 'plan mode'], limits: ['managed policy not inspected'] },
  codex: { controls: ['sandbox read-only'], limits: ['account identity not exposed by the CLI'] },
};

const input = (overrides: Partial<QualifyDelegationInput> = {}): QualifyDelegationInput => ({
  checkout: CHECKOUT,
  checkoutFacts: FACTS,
  config: CONFIG,
  declarations: [declaration()],
  executorObservations: [observation()],
  harnessControls: CONTROLS,
  machineId: MACHINE,
  now: NOW,
  providers: [quota()],
  purpose: 'delegation',
  qualificationId: QUALIFICATION_ID,
  request: REQUEST,
  requestDigest: DIGEST,
  reservations: { attemptsInChain: 0, liveJobsByPool: new Map(), targetReservedBy: null },
  scope: SCOPE,
  versions: { catalogRevision: '0'.repeat(16), policyRevision: '1'.repeat(16) },
  ...overrides,
});

const qualify = (overrides: Partial<QualifyDelegationInput> = {}): DelegationQualification =>
  qualifyDelegation(input(overrides));
const routeOf = (qualification: DelegationQualification, routeId: string) => {
  const route = qualification.routes.find((entry) => entry.routeId === routeId);
  if (!route) {
    throw new Error(`route ${routeId} missing from ${qualification.routes.map((entry) => entry.routeId).join(', ')}`);
  }
  return route;
};
const choose = (routeId: string, qualificationId: string = QUALIFICATION_ID): DelegationSelection => ({
  kind: 'choice',
  qualificationId,
  routeId,
  selectorVersion: 'calling-model/test',
});

describe('qualifyDelegation', () => {
  test('a declared, observed, quota-backed and annotated route is admissible with factual advantages and limits', () => {
    const qualification = qualify();
    expect(qualification.outcome).toBe('routes-available');
    expect(qualification.admissibleRouteIds).toEqual([OPUS_ID, SONNET_ID]);
    expect(qualification.refusal).toBeNull();
    expect(qualification.checkout).toEqual(CHECKOUT);
    expect(qualification.scope).toEqual(SCOPE);
    expect(qualification.checkoutFacts).toEqual(FACTS);
    expect(qualification.appliedRules).toEqual([]);
    expect(qualification.assumptions).toEqual([ORDER_HINT_ASSUMPTION]);
    expect(qualification.omittedRoutes).toBe(0);
    expect(qualification.versions).toEqual({
      catalogRevision: '0'.repeat(16),
      policyRevision: '1'.repeat(16),
      qualifier: 'delegation-qualifier/1',
      selectorContract: 'delegation-selection/1',
    });
    const opus = routeOf(qualification, OPUS_ID);
    expect(opus).toMatchObject({
      accountScope: 'personal',
      admissible: true,
      blockers: [],
      context: 'personal',
      exclusions: [],
      harness: 'claude-code',
      identity: { declared: FINGERPRINT, observed: FINGERPRINT, state: 'confirmed' },
      label: 'claude-code · personal · Opus',
      liveJobsInPool: 0,
      model: 'Opus',
      orderHint: 0,
      poolId: OPUS_ID,
      provider: 'anthropic',
      requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
    });
    expect(opus.quota).toEqual([
      {
        label: '5h',
        observedAt: '2026-10-21T11:59:00.000Z',
        remainingPercent: 50,
        resetsAt: '2026-10-21T16:00:00.000Z',
        scope: 'account',
      },
      {
        label: 'Weekly',
        observedAt: '2026-10-21T11:59:00.000Z',
        remainingPercent: 60,
        resetsAt: '2026-10-25T00:00:00.000Z',
        scope: 'account',
      },
      {
        label: 'Opus · Weekly',
        observedAt: '2026-10-21T11:59:00.000Z',
        remainingPercent: 70,
        resetsAt: '2026-10-25T00:00:00.000Z',
        scope: 'model',
      },
    ]);
    expect(opus.advantages).toEqual([
      'Account identity confirmed by the current observation (2026-10-21T11:50:00.000Z)',
      'Read-only control: tools Read, Grep, Glob',
      'Read-only control: plan mode',
    ]);
    expect(opus.limits).toEqual([
      `Shares pool ${OPUS_ID} with 1 other model route(s): models of one account share one quota resource`,
      'managed policy not inspected',
    ]);
    // The Sonnet alternate shares the pool and is not bound by the Opus window.
    const sonnet = routeOf(qualification, SONNET_ID);
    expect(sonnet.poolId).toBe(OPUS_ID);
    expect(sonnet.quota.map((entry) => entry.label)).toEqual(['5h', 'Weekly']);
    expect(sonnet.orderHint).toBe(1);
  });

  test('validUntil is the earliest of the ttl, the fact freshness expiries and the next applicable reset', () => {
    // ttl 600 s → 12:10; executor 11:50 + 30 min → 12:20; quota 11:59 + 15 min → 12:14; reset 16:00.
    expect(qualify().validUntil).toBe('2026-10-21T12:10:00.000Z');
    const soonReset = qualify({
      providers: [quota({ windows: [window({ resetsAt: '2026-10-21T12:05:00.000Z' }), WEEKLY] })],
    });
    expect(soonReset.validUntil).toBe('2026-10-21T12:05:00.000Z');
    const longTtl = qualify({ config: { ...CONFIG, defaults: { ...CONFIG.defaults, qualificationTtlSeconds: 3600 } } });
    expect(longTtl.validUntil).toBe('2026-10-21T12:14:00.000Z');
    expect(() => qualify({ now: 'now' })).toThrow(RangeError);
  });

  test.each([
    [
      'the checkout could not be resolved',
      { checkout: { failure: 'checkout-unavailable' as const, message: 'not a git checkout' } },
      'checkout-unavailable',
      'not a git checkout',
    ],
    [
      'the checkout is not admitted',
      { checkout: { ...CHECKOUT, admittedBy: null } },
      'checkout-not-admitted',
      'routing.reviewTargets',
    ],
    [
      'the scope is unsupported',
      { scope: { failure: 'scope-unsupported' as const, message: 'working-tree is not frozen' } },
      'scope-unsupported',
      'working-tree is not frozen',
    ],
    [
      'the scope could not be resolved',
      { scope: { failure: 'scope-unavailable' as const, message: 'unknown revision' } },
      'scope-unavailable',
      'unknown revision',
    ],
    [
      'another job reserves the target',
      { reservations: { attemptsInChain: 0, liveJobsByPool: new Map(), targetReservedBy: RETRY_OF } },
      'target-reserved',
      `Job ${RETRY_OF} already reserves this review`,
    ],
  ] as const)('refuses when %s and lists no route', (_label, overrides, reason: DelegationRefusalReason, message) => {
    const qualification = qualify(overrides);
    expect(qualification.outcome).toBe('refused');
    expect(qualification.refusal?.reason).toBe(reason);
    expect(qualification.refusal?.message).toContain(message);
    expect(qualification.routes).toEqual([]);
    expect(qualification.admissibleRouteIds).toEqual([]);
    if (reason === 'target-reserved') {
      expect(qualification.refusal?.message).toContain('follow it with delegation status instead of starting another');
    }
  });

  test('a route without a context annotation is excluded, and a forbid rule beats every preference', () => {
    const undeclared = qualify({ config: { ...CONFIG, routes: [] } });
    expect(undeclared.outcome).toBe('no-admissible-route');
    expect(routeOf(undeclared, OPUS_ID).blockers).toEqual(['context-undeclared']);
    expect(routeOf(undeclared, OPUS_ID).orderHint).toBeNull();
    expect(undeclared.assumptions).toEqual([]);
    const forbidden = qualify({
      config: {
        ...CONFIG,
        preferences: { harnesses: ['claude-code'], models: ['Opus'], nearResetMinutes: 600 },
        rules: [
          {
            effect: 'forbid',
            id: 'no-acme-on-personal',
            match: { githubOwner: 'acme' },
            routes: { contexts: ['personal'] },
          },
        ],
      },
    });
    expect(forbidden.appliedRules).toEqual([
      { applies: 'yes', effect: 'forbid', id: 'no-acme-on-personal', reason: 'matches githubOwner acme' },
    ]);
    expect(routeOf(forbidden, OPUS_ID).blockers).toEqual(['forbidden-by-rule']);
    expect(forbidden.admissibleRouteIds).toEqual([]);
  });

  test('an unknown checkout fact fails closed and is reported as an assumption', () => {
    const qualification = qualify({
      checkoutFacts: { ...FACTS, githubOwners: { provenance: 'unknown', source: 'git remote -v', value: null } },
      config: { ...CONFIG, rules: [{ effect: 'forbid', id: 'no-acme', match: { githubOwner: 'acme' } }] },
    });
    expect(qualification.appliedRules[0]?.applies).toBe('assumed');
    expect(qualification.assumptions[0]).toContain('Rule no-acme (forbid) is assumed to apply');
    expect(routeOf(qualification, OPUS_ID).blockers).toEqual(['forbidden-by-rule']);
  });

  test('stale quota or a stale executor observation leaves the route non-admissible with the fact named', () => {
    const staleQuota = qualify({ providers: [quota({ generatedAt: '2026-10-21T11:40:00.000Z' })] });
    const quotaRoute = routeOf(staleQuota, OPUS_ID);
    expect(quotaRoute.admissible).toBe(false);
    expect(quotaRoute.blockers).toContain('unsettled-fact');
    expect(quotaRoute.blockers).toContain('quota');
    expect(quotaRoute.missing).toContain('quota observation');
    const staleExecutor = qualify({ executorObservations: [observation({ observedAt: '2026-10-21T11:00:00.000Z' })] });
    const executorRoute = routeOf(staleExecutor, OPUS_ID);
    expect(executorRoute.admissible).toBe(false);
    expect(executorRoute.blockers).toEqual(['availability', 'unsettled-fact']);
    expect(executorRoute.missing).toContain('executor availability observation');
    expect(staleExecutor.outcome).toBe('no-admissible-route');
  });

  test('models of one account share one pool: a reserving job in the pool blocks every model of it', () => {
    const busy = qualify({
      reservations: { attemptsInChain: 0, liveJobsByPool: new Map([[OPUS_ID, 1]]), targetReservedBy: null },
    });
    for (const id of [OPUS_ID, SONNET_ID]) {
      expect(routeOf(busy, id).blockers).toEqual(['pool-busy']);
      expect(routeOf(busy, id).liveJobsInPool).toBe(1);
      expect(routeOf(busy, id).exclusions[0]).toContain('the limit is 1');
    }
    const wider = qualify({
      config: { ...CONFIG, defaults: { ...CONFIG.defaults, maxConcurrentPerPool: 2 } },
      reservations: { attemptsInChain: 0, liveJobsByPool: new Map([[OPUS_ID, 1]]), targetReservedBy: null },
    });
    expect(routeOf(wider, OPUS_ID).admissible).toBe(true);
  });

  test('the reserve is judged per applicable window, never averaged: one low window excludes', () => {
    const lopsided = qualify({
      providers: [
        quota({
          windows: [
            window({ remainingPercent: 95, usedPercent: 5 }),
            { ...WEEKLY, remainingPercent: 15, usedPercent: 85 },
            { ...OPUS_WEEKLY, remainingPercent: 90, usedPercent: 10 },
          ],
        }),
      ],
    });
    const opus = routeOf(lopsided, OPUS_ID);
    expect(opus.blockers).toEqual(['reserve']);
    expect(opus.exclusions).toEqual(['Quota window Weekly: 15% remaining is below the 20% reserve.']);
    // A low window of another model does not bound this one.
    const otherModelLow = qualify({
      providers: [quota({ windows: [window(), WEEKLY, { ...OPUS_WEEKLY, remainingPercent: 5, usedPercent: 95 }] })],
    });
    expect(routeOf(otherModelLow, OPUS_ID).blockers).toEqual(['reserve']);
    expect(routeOf(otherModelLow, SONNET_ID).admissible).toBe(true);
    // A stricter annotation raises the reserve for its route only.
    const strict = qualify({
      config: { ...CONFIG, routes: [{ ...CONFIG.routes[0]!, reservePercent: 55 }, CONFIG.routes[1]!] },
    });
    expect(routeOf(strict, OPUS_ID).requirements.reservePercent).toBe(55);
    expect(routeOf(strict, OPUS_ID).exclusions).toEqual(['Quota window 5h: 50% remaining is below the 55% reserve.']);
  });

  test('a quota observed before the observed account change is unattributable until a new observation', () => {
    const history = [
      observation({ accountFingerprint: OTHER_FINGERPRINT, observedAt: '2026-10-21T10:00:00.000Z' }),
      observation({ observedAt: '2026-10-21T11:00:00.000Z' }),
      observation({ observedAt: '2026-10-21T11:50:00.000Z' }),
    ];
    expect(observedAccountChangeAt(history)).toBe('2026-10-21T11:00:00.000Z');
    expect(observedAccountChangeAt([history[1]!, history[2]!])).toBeNull();
    expect(observedAccountChangeAt([])).toBeNull();
    const before = qualify({
      executorObservations: history,
      providers: [quota({ generatedAt: '2026-10-21T10:30:00.000Z' })],
    });
    const route = routeOf(before, OPUS_ID);
    expect(route.blockers).toContain('quota-before-account-change');
    expect(route.exclusions.join(' ')).toContain('predates the account change observed 2026-10-21T11:00:00.000Z');
    const after = qualify({
      executorObservations: history,
      providers: [quota({ generatedAt: '2026-10-21T11:55:00.000Z' })],
    });
    expect(routeOf(after, OPUS_ID).blockers).toEqual([]);
  });

  test('a contradicted identity is identity-changed; observed identity evidence blocks Codex and unpinned routes', () => {
    const contradicted = qualify({ executorObservations: [observation({ accountFingerprint: OTHER_FINGERPRINT })] });
    expect(routeOf(contradicted, OPUS_ID).blockers).toEqual(['identity-changed']);
    const observedEvidence = qualify({
      config: { ...CONFIG, defaults: { ...CONFIG.defaults, identityEvidence: 'observed' } },
      declarations: [declaration(), codexDeclaration()],
      executorObservations: [observation(), codexObservation()],
      providers: [quota(), codexQuota()],
    });
    expect(routeOf(observedEvidence, OPUS_ID).admissible).toBe(true);
    const codex = routeOf(observedEvidence, CODEX_ID);
    expect(codex.blockers).toEqual(['identity-evidence']);
    expect(codex.exclusions[0]).toBe(
      "Policy requires an observed account identity; this route's identity is not-observable.",
    );
    expect(codex.limits).toContain('Account identity not observable for this harness; bound by the declaration only');
    const declaredEvidence = qualify({
      declarations: [declaration(), codexDeclaration()],
      executorObservations: [observation(), codexObservation()],
      providers: [quota(), codexQuota()],
    });
    expect(routeOf(declaredEvidence, CODEX_ID).admissible).toBe(true);
    expect(routeOf(declaredEvidence, CODEX_ID).provider).toBe('openai');
    expect(routeOf(declaredEvidence, CODEX_ID).context).toBe('professional');
  });

  test('API billing is never admissible, nor is an observed-only quota stream', () => {
    const api = qualify({ declarations: [declaration({ subscription: 'api' })] });
    expect(routeOf(api, OPUS_ID).blockers).toEqual(['subscription']);
    const observedOnly = qualify({ declarations: [] });
    expect(observedOnly.outcome).toBe('no-admissible-route');
    const [stream] = observedOnly.routes;
    expect(stream).toMatchObject({
      admissible: false,
      blockers: ['authorization'],
      context: null,
      harness: 'claude-code',
      orderHint: null,
      routeId: `observed:${JSON.stringify([MACHINE, 'claude', null])}`,
    });
    expect(stream?.exclusions[1]).toContain('Add routing.executors[] for claude');
  });

  test('attempts are counted only for a retry, against the strictest maxAttempts', () => {
    const retry: DelegationRequest = { ...REQUEST, retryOf: RETRY_OF };
    const exhausted = qualify({
      request: retry,
      reservations: { attemptsInChain: 2, liveJobsByPool: new Map(), targetReservedBy: null },
    });
    expect(routeOf(exhausted, OPUS_ID).blockers).toEqual(['attempts-exhausted']);
    expect(routeOf(exhausted, OPUS_ID).exclusions[0]).toContain(
      `The retry chain of ${RETRY_OF} already counts 2 attempt(s); the limit is 2.`,
    );
    const fresh = qualify({ reservations: { attemptsInChain: 2, liveJobsByPool: new Map(), targetReservedBy: null } });
    expect(routeOf(fresh, OPUS_ID).admissible).toBe(true);
    const oneMore = qualify({
      request: retry,
      reservations: { attemptsInChain: 1, liveJobsByPool: new Map(), targetReservedBy: null },
    });
    expect(routeOf(oneMore, OPUS_ID).admissible).toBe(true);
  });

  test('the model catalog annotates (recommended, discouraged) and never excludes; preferences only order', () => {
    const qualification = qualify({
      config: {
        ...CONFIG,
        models: [
          {
            alias: null,
            declaredAt: '2026-10-19T09:00:00.000Z',
            discouragedFor: ['correctness'],
            harnesses: ['claude-code'],
            id: 'opus',
            nativeId: 'opus',
            note: null,
            provider: 'anthropic',
            recommendedFor: ['design'],
            resolvedVersion: null,
          },
          {
            alias: 'Sonnet',
            declaredAt: '2026-10-19T09:00:00.000Z',
            discouragedFor: [],
            harnesses: ['claude-code'],
            id: 'sonnet',
            nativeId: 'claude-sonnet-4-5',
            note: null,
            provider: 'anthropic',
            recommendedFor: ['correctness'],
            resolvedVersion: '2026-09-29',
          },
        ],
        preferences: { harnesses: [], models: ['Sonnet'], nearResetMinutes: null },
      },
    });
    const opus = routeOf(qualification, OPUS_ID);
    expect(opus.admissible).toBe(true);
    expect(opus.limits[0]).toBe(
      'Declared discouraged for correctness (operator declaration, declaredAt 2026-10-19T09:00:00.000Z; resolved version unknown)',
    );
    const sonnet = routeOf(qualification, SONNET_ID);
    expect(sonnet.advantages[0]).toBe(
      'Declared recommended for correctness (operator declaration, declaredAt 2026-10-19T09:00:00.000Z; resolved version 2026-09-29)',
    );
    expect(sonnet.orderHint).toBe(0);
    expect(opus.orderHint).toBe(1);
    expect(qualification.admissibleRouteIds).toEqual([SONNET_ID, OPUS_ID]);
  });

  test('orderHint ranks by preferred model, then harness, then the nearest reset within the horizon, then id', () => {
    const base = {
      declarations: [declaration(), codexDeclaration()],
      executorObservations: [observation(), codexObservation()],
      providers: [quota(), codexQuota({ windows: [window({ resetsAt: '2026-10-21T12:20:00.000Z' }), WEEKLY] })],
    };
    const byHarness = qualify({
      ...base,
      config: { ...CONFIG, preferences: { harnesses: ['codex'], models: [], nearResetMinutes: null } },
    });
    expect(byHarness.admissibleRouteIds).toEqual([CODEX_ID, OPUS_ID, SONNET_ID]);
    const byReset = qualify({
      ...base,
      config: { ...CONFIG, preferences: { harnesses: [], models: [], nearResetMinutes: 30 } },
    });
    expect(byReset.admissibleRouteIds).toEqual([CODEX_ID, OPUS_ID, SONNET_ID]);
    expect(routeOf(byReset, CODEX_ID).advantages).toContain(
      'observed reset of 5h at 2026-10-21T12:20:00.000Z; preference',
    );
    expect(routeOf(byReset, OPUS_ID).advantages.join(' ')).not.toContain('observed reset');
    const noHorizon = qualify({ ...base });
    expect(noHorizon.admissibleRouteIds).toEqual([OPUS_ID, SONNET_ID, CODEX_ID]);
    expect(routeOf(noHorizon, CODEX_ID).advantages.join(' ')).not.toContain('observed reset');
  });

  test('respects the route and byte bounds, dropping non-admissible routes first and counting them', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      declaration({ accountScope: `account-${String(index).padStart(2, '0')}`, alternateModels: [] }),
    );
    const bounded = qualify({ declarations: many, providers: [] });
    expect(bounded.routes).toHaveLength(DELEGATION_QUALIFICATION_BOUNDS.maxRoutes);
    expect(bounded.omittedRoutes).toBe(40 - DELEGATION_QUALIFICATION_BOUNDS.maxRoutes);
    const longControls = Array.from({ length: 12 }, (_, index) => `${'c'.repeat(290)}${index}`);
    const heavy = qualify({
      declarations: Array.from({ length: 30 }, (_, index) =>
        declaration({ accountScope: `account-${String(index).padStart(2, '0')}`, alternateModels: [] }),
      ),
      harnessControls: { ...CONTROLS, 'claude-code': { controls: longControls, limits: longControls } },
      providers: [],
    });
    expect(new TextEncoder().encode(JSON.stringify(heavy)).byteLength).toBeLessThanOrEqual(
      DELEGATION_BOUNDS.maxQualificationBytes,
    );
    expect(heavy.routes.length + heavy.omittedRoutes).toBe(30);
    expect(heavy.omittedRoutes).toBeGreaterThan(0);
    // With many declarations and no admissible route, the admissible list stays empty and consistent.
    expect(heavy.admissibleRouteIds).toEqual(
      heavy.routes.filter((route) => route.admissible).map((route) => route.routeId),
    );
  });

  test('is deterministic for identical inputs and survives a JSON round trip through the strict parser', () => {
    const first = qualify();
    const second = qualify();
    expect(second).toEqual(first);
    expect(parseDelegationQualification(JSON.parse(JSON.stringify(first)))).toEqual(first);
    const refused = qualify({ checkout: { ...CHECKOUT, admittedBy: null } });
    expect(parseDelegationQualification(JSON.parse(JSON.stringify(refused)))).toEqual(refused);
  });

  test.each([
    ['an extra key', (value: DelegationQualification) => ({ ...value, forged: true })],
    ['a forged admissible id', (value: DelegationQualification) => ({ ...value, admissibleRouteIds: ['forged'] })],
    [
      'an admissible route with a blocker',
      (value: DelegationQualification) => ({
        ...value,
        routes: value.routes.map((route) => ({ ...route, blockers: ['pool-busy'] })),
      }),
    ],
    [
      'a refusal on an open outcome',
      (value: DelegationQualification) => ({ ...value, refusal: { message: 'x', reason: 'pool-busy' } }),
    ],
    ['an unknown purpose', (value: DelegationQualification) => ({ ...value, purpose: 'audit' })],
    [
      'an uppercase qualification id',
      (value: DelegationQualification) => ({ ...value, qualificationId: QUALIFICATION_ID.toUpperCase() }),
    ],
    [
      'a short policy revision',
      (value: DelegationQualification) => ({ ...value, versions: { ...value.versions, policyRevision: 'abc' } }),
    ],
    [
      'an oversize label',
      (value: DelegationQualification) => ({
        ...value,
        routes: value.routes.map((route) => ({
          ...route,
          label: 'l'.repeat(DELEGATION_QUALIFICATION_BOUNDS.maxText + 1),
        })),
      }),
    ],
    [
      'a non-canonical scope sha',
      (value: DelegationQualification) => ({ ...value, scope: { ...value.scope, headSha: 'HEAD' } }),
    ],
    [
      'a relative checkout path',
      (value: DelegationQualification) => ({ ...value, checkout: { ...value.checkout, path: 'alpha' } }),
    ],
  ])('parseDelegationQualification refuses %s', (_label, forge) => {
    expect(parseDelegationQualification(JSON.parse(JSON.stringify(forge(qualify()))))).toBeNull();
  });
});

describe('decideDelegationLaunch', () => {
  const cited = qualify();
  const decide = (overrides: Partial<Parameters<typeof decideDelegationLaunch>[0]> = {}) =>
    decideDelegationLaunch({
      cited,
      fresh: qualify(),
      now: '2026-10-21T12:05:00.000Z',
      requestDigest: DIGEST,
      selection: choose(OPUS_ID),
      ...overrides,
    });

  test('allows an admissible route cited from a current qualification of the same request', () => {
    const decision = decide();
    expect(decision.kind).toBe('allowed');
    expect(decision.kind === 'allowed' && decision.route.routeId).toBe(OPUS_ID);
  });

  test('an abstention never starts anything', () => {
    expect(
      decide({
        selection: {
          kind: 'abstain',
          qualificationId: QUALIFICATION_ID,
          reason: 'keep-with-caller',
          selectorVersion: 'x',
        },
      }),
    ).toEqual({ kind: 'abstained' });
  });

  test('a forged or forced route id cannot bypass the cited qualification', () => {
    expect(decide({ selection: choose('declared:forged') })).toMatchObject({
      kind: 'refused',
      reason: 'route-not-admissible',
      message: 'Route declared:forged was not offered by the cited qualification.',
    });
    // Forbidden then, admissible now: the citation still rules.
    const forbiddenThen = qualify({
      config: { ...CONFIG, rules: [{ effect: 'forbid', id: 'no-acme', match: { githubOwner: 'acme' } }] },
    });
    expect(decide({ cited: forbiddenThen })).toMatchObject({ kind: 'refused', reason: 'route-not-admissible' });
    // Admissible then, forbidden now under the same policy revision: fresh facts rule too.
    const decision = decide({ fresh: forbiddenThen });
    expect(decision).toMatchObject({ kind: 'refused', reason: 'route-not-admissible' });
    expect(decision.kind === 'refused' && decision.message).toContain('Forbidden by rule no-acme');
  });

  test.each([
    ['no cited qualification', { cited: null }, 'qualification-unknown'],
    ['another request digest', { requestDigest: 'b'.repeat(64) }, 'qualification-mismatch'],
    ['a simulation cited for a launch', { cited: qualify({ purpose: 'simulation' }) }, 'qualification-mismatch'],
    ['another qualification id in the selection', { selection: choose(OPUS_ID, RETRY_OF) }, 'qualification-mismatch'],
    ['an expired qualification', { now: '2026-10-21T12:10:00.001Z' }, 'qualification-expired'],
    [
      'a fresh refusal',
      {
        fresh: qualify({ reservations: { attemptsInChain: 0, liveJobsByPool: new Map(), targetReservedBy: RETRY_OF } }),
      },
      'target-reserved',
    ],
    [
      'a changed policy revision',
      { fresh: qualify({ versions: { catalogRevision: '0'.repeat(16), policyRevision: '2'.repeat(16) } }) },
      'policy-changed',
    ],
    ['a moved scope', { fresh: qualify({ scope: { ...SCOPE, headSha: '2'.repeat(40) } }) }, 'scope-changed'],
    [
      'a busy pool now',
      {
        fresh: qualify({
          reservations: { attemptsInChain: 0, liveJobsByPool: new Map([[OPUS_ID, 1]]), targetReservedBy: null },
        }),
      },
      'pool-busy',
    ],
    [
      'a changed account now',
      { fresh: qualify({ executorObservations: [observation({ accountFingerprint: OTHER_FINGERPRINT })] }) },
      'identity-changed',
    ],
    [
      'a route excluded now for another reason',
      {
        fresh: qualify({ providers: [quota({ windows: [window({ remainingPercent: 5, usedPercent: 95 }), WEEKLY] })] }),
      },
      'route-not-admissible',
    ],
    ['a route absent now', { fresh: qualify({ declarations: [codexDeclaration()] }) }, 'route-not-admissible'],
  ])('refuses %s', (_label, overrides, reason) => {
    const decision = decide(overrides);
    expect(decision).toMatchObject({ kind: 'refused', reason });
  });

  test('a catalog change alone does not refuse: it is not policy', () => {
    const fresh = qualify({ versions: { catalogRevision: 'f'.repeat(16), policyRevision: '1'.repeat(16) } });
    expect(decide({ fresh }).kind).toBe('allowed');
  });
});
