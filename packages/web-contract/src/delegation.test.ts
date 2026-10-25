import { describe, expect, test } from 'bun:test';
import { DELEGATION_BOUNDS } from '@ai-usage/report-core/delegation-vocabulary';
import { parse, safeParse } from 'valibot';
import {
  DELEGATION_WEB_BOUNDS,
  type DelegationJobViewWire,
  type DelegationQualificationWire,
  type DelegationSettingsView,
  delegationCancelInputSchema,
  delegationContract,
  delegationJobInputSchema,
  delegationJobsInputSchema,
  delegationRecordAcceptanceInputSchema,
  delegationSaveSettingsInputSchema,
  delegationSimulateInputSchema,
  parseDelegationCancelOutput,
  parseDelegationJobsOutput,
  parseDelegationJobView,
  parseDelegationQualificationWire,
  parseDelegationRecordAcceptanceOutput,
  parseDelegationSaveSettingsOutput,
  parseDelegationSettingsView,
} from './delegation';

const JOB_ID = '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f';
const QUALIFICATION_ID = '7d3a9b2c-1e4f-4a5b-8c6d-9e0f1a2b3c4d';
const ROUTE_ID = 'declared:["machine-a","claude-code","personal"]';

const settingsFixture: DelegationSettingsView = {
  catalogRevision: '0123456789abcdef',
  configPath: '/home/operator/.config/ai-usage/config.json',
  delegation: {
    config: {
      defaults: {
        identityEvidence: 'declared',
        maxAttempts: 2,
        maxConcurrentPerPool: 1,
        qualificationTtlSeconds: 600,
        reservePercent: 20,
      },
      models: [
        {
          alias: 'opus',
          declaredAt: '2026-10-20T08:00:00.000Z',
          discouragedFor: ['documentation'],
          harnesses: ['claude-code'],
          id: 'claude-opus',
          nativeId: 'claude-opus-4-1',
          note: null,
          provider: 'anthropic',
          recommendedFor: ['correctness', 'security'],
          resolvedVersion: null,
        },
      ],
      preferences: { harnesses: ['claude-code'], models: ['claude-opus-4-1'], nearResetMinutes: null },
      routes: [{ accountScope: 'personal', context: 'personal', harness: 'claude-code', label: 'Claude personal' }],
      rules: [
        {
          description: 'Work repositories never run on the personal account.',
          effect: 'forbid',
          id: 'no-personal-on-work',
          match: { githubOwner: 'acme' },
          routes: { contexts: ['personal'] },
        },
      ],
    },
    issues: [],
  },
  executors: {
    declarations: [
      {
        accountScope: 'personal',
        authorization: 'allowed',
        capabilities: ['read-only-review'],
        declaredAt: '2026-10-20T08:00:00.000Z',
        effort: 'high',
        harness: 'claude-code',
        machineId: 'machine-a',
        model: 'claude-opus-4-1',
        quality: 'review-capable',
        subscription: 'verified',
        targets: [{ kind: 'any-local-session' }],
      },
    ],
    issues: [{ path: 'routing.executors[1].subscription', reason: "must be 'verified' or 'api'" }],
  },
  githubAccounts: [{ ghUser: 'operator', owner: 'acme' }],
  harnesses: [
    {
      caller: 'any MCP client',
      executor: 'supported',
      harness: 'claude-code',
      reason: 'read-only enforced by harness controls',
    },
    {
      caller: 'any MCP client',
      executor: 'not-supported',
      harness: 'opencode',
      reason: 'no per-invocation read-only mode in this version',
    },
  ],
  machineId: 'machine-a',
  models: [
    {
      entry: {
        alias: 'opus',
        declaredAt: '2026-10-20T08:00:00.000Z',
        discouragedFor: ['documentation'],
        harnesses: ['claude-code'],
        id: 'claude-opus',
        nativeId: 'claude-opus-4-1',
        note: null,
        provider: 'anthropic',
        recommendedFor: ['correctness', 'security'],
        resolvedVersion: null,
      },
      observed: { jobs: 2, lastSeenAt: '2026-10-25T09:00:00.000Z', modelResolved: 'claude-opus-4-1-20260901' },
    },
  ],
  observedModels: [
    {
      harness: 'claude-code',
      jobs: 2,
      lastSeenAt: '2026-10-25T09:00:00.000Z',
      modelRequested: 'claude-opus-4-1',
      modelResolved: 'claude-opus-4-1-20260901',
    },
  ],
  reviewTargets: { issues: [], targets: [{ checkoutPath: '/home/operator/src', label: 'src' }] },
  revision: 'fedcba9876543210',
  routes: [
    {
      accountScope: 'personal',
      availability: {
        authMethod: 'claude.ai',
        authState: 'logged-in',
        observedAt: '2026-10-25T08:50:00.000Z',
        provenance: 'observed-now',
        state: 'available',
        version: '2.1.306',
      },
      context: 'personal',
      effort: 'high',
      harness: 'claude-code',
      identity: {
        declared: null,
        observed: 'abcdef0123456789',
        observedAt: '2026-10-25T08:50:00.000Z',
        state: 'unpinned',
      },
      label: 'Claude personal',
      lastCheckedAt: '2026-10-25T08:50:00.000Z',
      missing: [],
      model: 'claude-opus-4-1',
      poolId: ROUTE_ID,
      provider: 'anthropic',
      quota: {
        observedAt: '2026-10-25T08:55:00.000Z',
        provenance: 'observed-now',
        windows: [{ label: '5h', remainingPercent: 60, resetsAt: '2026-10-25T12:00:00.000Z', scope: 'account' }],
      },
      routeId: ROUTE_ID,
      subscription: 'verified',
    },
  ],
};

const jobFixture: DelegationJobViewWire = {
  attemptNumber: 1,
  cancelRequestedAt: null,
  endedAt: '2026-10-25T09:05:00.000Z',
  evaluations: {
    acceptance: null,
    acceptances: [],
    automatedChecks: [
      {
        author: 'automated-check',
        authorLabel: 'engine',
        checks: ['output contract satisfied'],
        evaluationId: 'eval-check-1',
        kind: 'verification',
        note: null,
        recordedAt: '2026-10-25T09:05:01.000Z',
        verdict: 'confirmed',
      },
    ],
    verifications: [],
  },
  executedScope: {
    fileCount: 2,
    files: [
      { coverage: 'complete', path: 'src/a.ts' },
      { coverage: 'omitted', path: 'src/b.ts' },
    ],
    includedBytes: 2048,
    patchBytes: 5120,
    patchSha256: 'd'.repeat(64),
    truncated: true,
    workingTreeDirty: false,
  },
  failure: null,
  guarantee: {
    cliVersion: '2.1.306',
    controls: ['tools Read Grep Glob', 'safe mode', 'no MCP servers'],
    effort: 'high',
    harness: 'claude-code',
    limits: ['managed policy hooks still run'],
    model: 'claude-opus-4-1',
  },
  heartbeatAgeSeconds: null,
  jobId: JOB_ID,
  live: false,
  machineId: 'machine-a',
  notes: ['A finished execution is not a verification.', 'A verification is not an acceptance.'],
  qualification: {
    admissibleRoutes: 1,
    catalogRevision: '0123456789abcdef',
    excludedRoutes: [{ blockers: ['forbidden-by-rule'], routeId: 'declared:["machine-a","codex","work"]' }],
    omittedExcludedRoutes: 0,
    policyRevision: 'fedcba9876543210',
    qualificationId: QUALIFICATION_ID,
    qualifiedAt: '2026-10-25T09:00:00.000Z',
  },
  refusal: null,
  request: {
    action: 'read-only-review',
    checkoutPath: '/home/operator/src/ai-usage',
    constraints: ['do not run tests'],
    criteria: ['every public function is covered'],
    objective: 'Review the delegation contract for bounds.',
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestedAt: '2026-10-25T09:00:00.000Z',
  reservation: { evidence: null, held: false, releasedAt: null },
  result: {
    checks: ['bun test'],
    coverage: { notReviewed: ['src/b.ts (omitted from the patch)'], reviewed: 'src/a.ts' },
    excerpt: null,
    findings: [
      {
        detail: 'The limit is not bounded before the read.',
        evidence: [{ line: 12, path: 'src/a.ts' }],
        severity: 'major',
        title: 'Unbounded list limit',
      },
    ],
    kind: 'review',
    limits: ['patch truncated'],
    summary: 'One major finding; the rest holds.',
  },
  retryOf: null,
  route: {
    accountScope: 'personal',
    context: 'personal',
    effort: 'high',
    harness: 'claude-code',
    harnessVersion: '2.1.306',
    modelRequested: 'claude-opus-4-1',
    modelResolved: 'claude-opus-4-1-20260901',
    poolId: ROUTE_ID,
    routeId: ROUTE_ID,
  },
  selection: {
    confidence: 0.7,
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    rationale: ['recommended for correctness'],
    routeId: ROUTE_ID,
    selectorVersion: 'calling-model/claude-code',
  },
  startedAt: '2026-10-25T09:00:02.000Z',
  state: 'finished',
  status: { accepted: 'pending', executed: 'succeeded', verified: 'not-verified' },
  truncation: { evaluations: 0, evidence: 0, findings: 0, notReviewed: 0 },
  updatedAt: '2026-10-25T09:05:01.000Z',
  usage: { cachedInputTokens: null, inputTokens: 12_000, outputTokens: 900, source: 'harness-reported' },
};

const qualificationFixture: DelegationQualificationWire = {
  admissibleRouteIds: [ROUTE_ID],
  appliedRules: [{ applies: 'yes', effect: 'forbid', id: 'no-personal-on-work', reason: 'githubOwner acme' }],
  assumptions: ['orderHint is a deterministic tie-break from preferences, not a judgment of the task'],
  checkout: { admittedBy: '/home/operator/src', path: '/home/operator/src/ai-usage', projectLabel: 'ai-usage' },
  checkoutFacts: {
    gitAuthorEmail: { provenance: 'observed', source: 'git config user.email', value: 'operator@example.test' },
    githubAccount: { provenance: 'declared', source: 'github.accounts[owner=acme]', value: 'operator' },
    githubOwners: { provenance: 'observed', source: 'git remote -v', value: ['acme'] },
    repositories: { provenance: 'observed', source: 'git remote -v', value: ['acme/ai-usage'] },
  },
  omittedRoutes: 0,
  outcome: 'routes-available',
  purpose: 'simulation',
  qualificationId: QUALIFICATION_ID,
  qualifiedAt: '2026-10-25T09:00:00.000Z',
  refusal: null,
  request: { action: 'read-only-review', digest: 'a'.repeat(64), taskCategory: 'correctness' },
  routes: [
    {
      accountScope: 'personal',
      admissible: true,
      advantages: ['declared recommended for correctness'],
      blockers: [],
      context: 'personal',
      effort: 'high',
      exclusions: [],
      harness: 'claude-code',
      identity: { declared: null, observed: 'abcdef0123456789', state: 'unpinned' },
      label: 'Claude personal',
      limits: ['identity only declared'],
      liveJobsInPool: 0,
      missing: [],
      model: 'claude-opus-4-1',
      orderHint: 0,
      poolId: ROUTE_ID,
      provider: 'anthropic',
      quota: [
        {
          label: '5h',
          observedAt: '2026-10-25T08:55:00.000Z',
          remainingPercent: 60,
          resetsAt: '2026-10-25T12:00:00.000Z',
          scope: 'account',
        },
      ],
      requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
      routeId: ROUTE_ID,
    },
  ],
  schemaVersion: 1,
  scope: {
    base: 'first-parent',
    baseRef: null,
    baseSha: 'c'.repeat(40),
    commitCount: 1,
    headRef: 'HEAD',
    headSha: 'b'.repeat(40),
    kind: 'commit',
  },
  validUntil: '2026-10-25T09:10:00.000Z',
  versions: {
    catalogRevision: '0123456789abcdef',
    policyRevision: 'fedcba9876543210',
    qualifier: 'delegation-qualifier/1',
    selectorContract: 'delegation-selection/1',
  },
};

describe('delegation web contract', () => {
  test('accepts the settings, job and qualification fixtures unchanged', () => {
    expect(parseDelegationSettingsView(settingsFixture)).toEqual(settingsFixture);
    expect(parseDelegationJobView(jobFixture)).toEqual(jobFixture);
    expect(parseDelegationJobsOutput({ jobs: [jobFixture], omitted: 2, skipped: 1 })).toEqual({
      jobs: [jobFixture],
      omitted: 2,
      skipped: 1,
    });
    // Both counts are part of the answer: a list that omitted jobs by size always says how many.
    expect(() => parseDelegationJobsOutput({ jobs: [jobFixture], skipped: 1 })).toThrow();
    expect(DELEGATION_WEB_BOUNDS.maxJobsListBytes).toBe(512 * 1024);
    expect(parseDelegationQualificationWire(qualificationFixture)).toEqual(qualificationFixture);
    expect(parseDelegationSaveSettingsOutput({ issues: [], result: 'written', revision: 'fedcba9876543210' })).toEqual({
      issues: [],
      result: 'written',
      revision: 'fedcba9876543210',
    });
    expect(parseDelegationCancelOutput({ jobId: JOB_ID, result: 'cancelling', state: 'running' })).toEqual({
      jobId: JOB_ID,
      result: 'cancelling',
      state: 'running',
    });
    expect(parseDelegationRecordAcceptanceOutput({ evaluationId: 'eval-1' })).toEqual({ evaluationId: 'eval-1' });
  });

  test('refuses unknown keys, oversize entries and values outside the vocabulary', () => {
    expect(() => parseDelegationJobView({ ...jobFixture, pid: 4242 })).toThrow();
    expect(() => parseDelegationJobView({ ...jobFixture, state: 'paused' })).toThrow();
    expect(() => parseDelegationJobView({ ...jobFixture, jobId: JOB_ID.toUpperCase() })).toThrow();
    expect(() =>
      parseDelegationJobView({
        ...jobFixture,
        request: { ...jobFixture.request, objective: 'x'.repeat(DELEGATION_BOUNDS.maxObjectiveCharacters + 1) },
      }),
    ).toThrow();
    expect(() =>
      parseDelegationJobView({
        ...jobFixture,
        status: { ...jobFixture.status, accepted: 'approved' },
      }),
    ).toThrow();
    expect(() => parseDelegationSettingsView({ ...settingsFixture, databasePath: '/private/store.sqlite' })).toThrow();
    expect(() =>
      parseDelegationSettingsView({
        ...settingsFixture,
        delegation: {
          ...settingsFixture.delegation,
          config: {
            ...settingsFixture.delegation.config,
            defaults: { ...settingsFixture.delegation.config.defaults, reservePercent: 91 },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseDelegationSettingsView({
        ...settingsFixture,
        delegation: {
          ...settingsFixture.delegation,
          config: {
            ...settingsFixture.delegation.config,
            rules: [{ ...settingsFixture.delegation.config.rules[0], id: 'Not A Slug' }],
          },
        },
      }),
    ).toThrow();
    expect(() => parseDelegationQualificationWire({ ...qualificationFixture, purpose: 'launch' })).toThrow();
    expect(() =>
      parseDelegationQualificationWire({
        ...qualificationFixture,
        request: { ...qualificationFixture.request, digest: 'xyz' },
      }),
    ).toThrow();
    expect(() =>
      parseDelegationJobsOutput({
        jobs: Array.from({ length: DELEGATION_WEB_BOUNDS.maxListLimit + 1 }, () => jobFixture),
        omitted: 0,
        skipped: 0,
      }),
    ).toThrow();
  });

  test('bounds every input and keeps revisions, scopes and verdicts within the vocabulary', () => {
    expect(safeParse(delegationJobsInputSchema, {}).success).toBe(true);
    expect(
      safeParse(delegationJobsInputSchema, { limit: DELEGATION_WEB_BOUNDS.maxListLimit, liveOnly: true }).success,
    ).toBe(true);
    expect(safeParse(delegationJobsInputSchema, { limit: DELEGATION_WEB_BOUNDS.maxListLimit + 1 }).success).toBe(false);
    expect(safeParse(delegationJobsInputSchema, { limit: 0 }).success).toBe(false);
    expect(safeParse(delegationJobInputSchema, { jobId: JOB_ID }).success).toBe(true);
    expect(safeParse(delegationJobInputSchema, { jobId: 'not-a-uuid' }).success).toBe(false);
    expect(safeParse(delegationCancelInputSchema, { jobId: JOB_ID, force: true }).success).toBe(false);
    expect(safeParse(delegationRecordAcceptanceInputSchema, { jobId: JOB_ID, verdict: 'accepted' }).success).toBe(true);
    expect(
      safeParse(delegationRecordAcceptanceInputSchema, { jobId: JOB_ID, note: 'Looks right.', verdict: 'taken-over' })
        .success,
    ).toBe(true);
    // The author is this edge's; a payload may not claim one.
    expect(
      safeParse(delegationRecordAcceptanceInputSchema, { author: 'operator', jobId: JOB_ID, verdict: 'accepted' })
        .success,
    ).toBe(false);
    expect(safeParse(delegationRecordAcceptanceInputSchema, { jobId: JOB_ID, verdict: 'confirmed' }).success).toBe(
      false,
    );
    expect(
      safeParse(delegationRecordAcceptanceInputSchema, {
        jobId: JOB_ID,
        note: 'x'.repeat(DELEGATION_BOUNDS.maxEvaluationNoteCharacters + 1),
        verdict: 'rejected',
      }).success,
    ).toBe(false);
    expect(
      safeParse(delegationSimulateInputSchema, {
        checkoutPath: '/home/operator/src/ai-usage',
        scope: { commit: 'HEAD~1', kind: 'commit' },
        taskCategory: 'security',
      }).success,
    ).toBe(true);
    expect(
      safeParse(delegationSimulateInputSchema, {
        checkoutPath: '/home/operator/src/ai-usage',
        objective: 'Check the migration.',
        scope: { base: 'main', head: 'feature/x', kind: 'range' },
        taskCategory: 'design',
      }).success,
    ).toBe(true);
    expect(
      safeParse(delegationSimulateInputSchema, {
        checkoutPath: 'relative/path',
        scope: { commit: 'HEAD', kind: 'commit' },
        taskCategory: 'security',
      }).success,
    ).toBe(false);
    expect(
      safeParse(delegationSimulateInputSchema, {
        checkoutPath: '/home/operator/src/ai-usage',
        scope: { commit: '--output=/tmp/x', kind: 'commit' },
        taskCategory: 'security',
      }).success,
    ).toBe(false);
    expect(
      safeParse(delegationSimulateInputSchema, {
        checkoutPath: '/home/operator/src/ai-usage',
        scope: { kind: 'working-tree' },
        taskCategory: 'security',
      }).success,
    ).toBe(false);
  });

  test('saveSettings carries raw bounded sections and requires at least one', () => {
    expect(
      safeParse(delegationSaveSettingsInputSchema, {
        delegation: { defaults: { reservePercent: 30 }, rules: [] },
        expectedRevision: 'fedcba9876543210',
      }).success,
    ).toBe(true);
    expect(
      safeParse(delegationSaveSettingsInputSchema, {
        executors: [{ accountScope: 'personal', harness: 'claude-code' }],
        expectedRevision: 'fedcba9876543210',
        reviewTargets: [{ checkoutPath: '/home/operator/src' }],
      }).success,
    ).toBe(true);
    expect(safeParse(delegationSaveSettingsInputSchema, { expectedRevision: 'fedcba9876543210' }).success).toBe(false);
    expect(
      safeParse(delegationSaveSettingsInputSchema, { expectedRevision: 'fedcba9876543210', github: { accounts: [] } })
        .success,
    ).toBe(false);
    expect(
      safeParse(delegationSaveSettingsInputSchema, {
        delegation: { note: 'x'.repeat(DELEGATION_WEB_BOUNDS.maxSaveInputBytes) },
        expectedRevision: 'fedcba9876543210',
      }).success,
    ).toBe(false);
    expect(
      safeParse(delegationSaveSettingsInputSchema, {
        delegation: { when: new Date() },
        expectedRevision: 'fedcba9876543210',
      }).success,
    ).toBe(false);
  });

  test('declares seven procedures with GET reads and POST writes', () => {
    const routes = Object.fromEntries(
      Object.entries(delegationContract).map(([name, procedure]) => [name, procedure['~orpc'].route]),
    );
    expect(routes).toEqual({
      cancel: { method: 'POST', path: '/delegation/cancel' },
      job: { method: 'GET', path: '/delegation/job' },
      jobs: { method: 'GET', path: '/delegation/jobs' },
      recordAcceptance: { method: 'POST', path: '/delegation/acceptance' },
      saveSettings: { method: 'POST', path: '/delegation/settings' },
      settings: { method: 'GET', path: '/delegation/settings' },
      simulate: { method: 'POST', path: '/delegation/simulate' },
    });
    expect(Object.keys(delegationContract.saveSettings['~orpc'].errorMap ?? {}).sort()).toEqual([
      'Conflict',
      'EngineUnavailable',
      'ForbiddenDemo',
      'InvalidInput',
      'Unavailable',
    ]);
    expect(Object.keys(delegationContract.jobs['~orpc'].errorMap ?? {}).sort()).toEqual([
      'ForbiddenDemo',
      'IncompatibleStore',
      'Unavailable',
    ]);
    // The conflict data names the current revision; an invalid write its issues.
    const conflictData = delegationContract.saveSettings['~orpc'].errorMap?.Conflict?.data;
    expect(conflictData && parse(conflictData, { revision: 'fedcba9876543210' })).toEqual({
      revision: 'fedcba9876543210',
    });
    const invalidData = delegationContract.saveSettings['~orpc'].errorMap?.InvalidInput?.data;
    expect(
      invalidData && parse(invalidData, { issues: [{ path: 'delegation.rules[0].id', reason: 'must be a slug' }] }),
    ).toEqual({ issues: [{ path: 'delegation.rules[0].id', reason: 'must be a slug' }] });
  });
});
