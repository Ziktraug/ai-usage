import { describe, expect, test } from 'bun:test';
import type { DelegationEvaluation, DelegationJob } from '@ai-usage/report-core/delegation-contracts';
import { DELEGATION_JOB_BOUNDS, projectDelegationJobView } from '@ai-usage/report-core/delegation-job';
import { DELEGATION_RESULT_BOUNDS } from '@ai-usage/report-core/delegation-result';
import { DELEGATION_BOUNDS, DELEGATION_ROUTE_BLOCKERS } from '@ai-usage/report-core/delegation-vocabulary';
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
  delegationJobViewSchema,
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
  frozenScope: {
    base: 'first-parent',
    baseRef: null,
    baseSha: 'c'.repeat(40),
    commitCount: 1,
    headRef: 'HEAD',
    headSha: 'b'.repeat(40),
    kind: 'commit',
  },
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
  truncation: {
    automatedChecks: 0,
    characters: 0,
    constraints: 0,
    criteria: 0,
    evaluationChecks: 0,
    evaluations: 0,
    evidence: 0,
    findings: 0,
    guaranteeControls: 0,
    guaranteeLimits: 0,
    notReviewed: 0,
    rationale: 0,
    resultChecks: 0,
    resultLimits: 0,
    scopeFiles: 0,
  },
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

// ---------------------------------------------------------------------------------------------
// Views projected by report-core through this schema: under the byte bound and accepted as is
// ---------------------------------------------------------------------------------------------

const NOW = '2026-10-25T09:00:00.000Z';
const LATER = '2026-10-25T09:05:00.000Z';
const FILL = '語';
const fill = (length: number, char = FILL): string => char.repeat(length);
const lines = (count: number, length: number, char = FILL): string[] =>
  Array.from({ length: count }, (_, index) => `${index} ${fill(length - 3, char)}`);
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** A lone surrogate: what a cut inside a pair would leave behind. */
const LONE_SURROGATE = /\p{Cs}/u;

const frozenCommit = {
  base: 'first-parent',
  baseRef: null,
  baseSha: 'b'.repeat(40),
  commitCount: 1,
  headRef: 'HEAD',
  headSha: 'a'.repeat(40),
  kind: 'commit',
} as const;

const EXCLUDED_ROUTE_ID = 'declared:["machine-a","codex","work"]';

/** A finished review as the store returns it; the projection under test turns it into the view. */
const storedJob: DelegationJob = {
  accountScope: 'personal',
  action: 'read-only-review',
  attemptNumber: 1,
  cancelRequestedAt: null,
  checkoutPath: '/home/operator/src/ai-usage',
  context: 'personal',
  effort: 'high',
  endedAt: LATER,
  executedScope: {
    fileCount: 1,
    files: [{ coverage: 'complete', path: 'src/a.ts' }],
    includedBytes: 10,
    patchBytes: 10,
    patchSha256: 'd'.repeat(64),
    truncated: false,
    workingTreeDirty: false,
  },
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  guarantee: {
    cliVersion: '2.1.306',
    controls: ['tools Read Grep Glob'],
    effort: 'high',
    harness: 'claude-code',
    limits: ['managed policy hooks still run'],
    model: 'claude-opus-4-1',
  },
  harnessVersion: '2.1.306',
  idempotencyKey: 'caller:session-1:review-7',
  jobId: JOB_ID,
  launchMarker: '2f6a0c4e-5d7b-4a9c-8e1f-2b3c4d5e6f70',
  machineId: 'machine-a',
  modelRequested: 'claude-opus-4-1',
  modelResolved: 'claude-opus-4-1-20260901',
  nativeSessionId: 'native-1',
  pid: 4242,
  poolId: ROUTE_ID,
  qualification: {
    admissibleRouteIds: [ROUTE_ID],
    appliedRules: [],
    assumptions: [],
    checkout: { admittedBy: '/home/operator/src', path: '/home/operator/src/ai-usage', projectLabel: 'ai-usage' },
    checkoutFacts: null,
    omittedRoutes: 0,
    outcome: 'routes-available',
    purpose: 'delegation',
    qualificationId: QUALIFICATION_ID,
    qualifiedAt: NOW,
    refusal: null,
    request: { action: 'read-only-review', digest: 'd'.repeat(64), taskCategory: 'correctness' },
    routes: [
      {
        accountScope: 'work',
        admissible: false,
        advantages: [],
        blockers: ['forbidden-by-rule'],
        context: 'professional',
        effort: null,
        exclusions: ['forbidden by rule no-personal-on-work'],
        harness: 'codex',
        identity: null,
        label: 'Codex (work)',
        limits: [],
        liveJobsInPool: 0,
        missing: [],
        model: 'gpt-5-codex',
        orderHint: null,
        poolId: EXCLUDED_ROUTE_ID,
        provider: 'openai',
        quota: [],
        requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
        routeId: EXCLUDED_ROUTE_ID,
      },
    ],
    schemaVersion: 1,
    scope: frozenCommit,
    validUntil: LATER,
    versions: {
      catalogRevision: '0123456789abcdef',
      policyRevision: 'fedcba9876543210',
      qualifier: 'delegation-qualifier/1',
      selectorContract: 'delegation-selection/1',
    },
  },
  qualificationId: QUALIFICATION_ID,
  refusalReason: null,
  releasedAt: null,
  releaseEvidence: null,
  request: {
    action: 'read-only-review',
    checkout: { path: '/home/operator/src/ai-usage' },
    constraints: ['do not run tests'],
    criteria: ['every public function is covered'],
    objective: 'Review the delegation contract for bounds.',
    schemaVersion: 1,
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestDigest: 'd'.repeat(64),
  requestedAt: NOW,
  result: {
    excerpt: null,
    kind: 'review',
    review: {
      checks: ['bun test'],
      coverage: { notReviewed: [], reviewed: 'src/a.ts' },
      findings: [
        {
          detail: 'The limit is not bounded before the read.',
          evidence: [{ line: 12, path: 'src/a.ts' }],
          severity: 'major',
          title: 'Unbounded list limit',
        },
      ],
      limits: [],
      summary: 'One major finding; the rest holds.',
    },
  },
  retryOf: null,
  routeId: ROUTE_ID,
  scope: frozenCommit,
  selection: {
    confidence: 0.7,
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    rationale: ['recommended for correctness'],
    routeId: ROUTE_ID,
    selectorVersion: 'calling-model/claude-code',
  },
  startedAt: NOW,
  state: 'finished',
  taskCategory: 'correctness',
  traceVersion: 1,
  updatedAt: LATER,
  usage: { cachedInputTokens: null, inputTokens: 12_000, outputTokens: 900, source: 'harness-reported' },
};

const storedEvaluation = (
  index: number,
  kind: DelegationEvaluation['kind'],
  author: DelegationEvaluation['author'],
  char = FILL,
): DelegationEvaluation => ({
  author,
  authorLabel: fill(DELEGATION_JOB_BOUNDS.maxTextCharacters, char),
  checks: lines(DELEGATION_BOUNDS.maxEvaluationChecks, DELEGATION_BOUNDS.maxEvaluationCheckCharacters, char),
  evaluationId: `${kind}-${author}-${String(index).padStart(2, '0')}`,
  jobId: JOB_ID,
  kind,
  note: fill(DELEGATION_BOUNDS.maxEvaluationNoteCharacters, char),
  recordedAt: new Date(Date.parse(LATER) + index * 60_000).toISOString(),
  verdict: kind === 'verification' ? 'confirmed' : 'taken-over',
});

/** Sixty-one evaluations at every bound: the three lists full, plus the operator's acceptance. */
const crowd = (char = FILL): DelegationEvaluation[] => [
  ...Array.from({ length: 20 }, (_, index) => storedEvaluation(index, 'verification', 'calling-model', char)),
  ...Array.from({ length: 20 }, (_, index) => storedEvaluation(index, 'acceptance', 'calling-model', char)),
  ...Array.from({ length: 20 }, (_, index) => storedEvaluation(index, 'verification', 'automated-check', char)),
  storedEvaluation(-1, 'acceptance', 'operator', char),
];

const maximalReview = (char = FILL): NonNullable<DelegationJob['result']> => ({
  excerpt: fill(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters, char),
  kind: 'review',
  review: {
    checks: lines(DELEGATION_RESULT_BOUNDS.maxChecks, DELEGATION_RESULT_BOUNDS.maxCheckCharacters, char),
    coverage: {
      notReviewed: lines(
        DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewed,
        DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewedCharacters,
        char,
      ),
      reviewed: fill(DELEGATION_RESULT_BOUNDS.maxCoverageReviewedCharacters, char),
    },
    findings: Array.from({ length: DELEGATION_RESULT_BOUNDS.maxFindings }, (_, index) => ({
      detail: fill(DELEGATION_RESULT_BOUNDS.maxDetailCharacters, char),
      evidence: Array.from({ length: DELEGATION_RESULT_BOUNDS.maxEvidencePerFinding }, (_entry, line) => ({
        line: line + 1,
        path: `${index}/${fill(DELEGATION_RESULT_BOUNDS.maxPathCharacters - 4, char)}`,
      })),
      severity: 'major' as const,
      title: `${index} ${fill(DELEGATION_RESULT_BOUNDS.maxTitleCharacters - 3, char)}`,
    })),
    limits: lines(DELEGATION_RESULT_BOUNDS.maxLimits, DELEGATION_RESULT_BOUNDS.maxLimitCharacters, char),
    summary: fill(DELEGATION_RESULT_BOUNDS.maxSummaryCharacters, char),
  },
});

const maximalScope = (char = FILL): NonNullable<DelegationJob['executedScope']> => ({
  fileCount: DELEGATION_JOB_BOUNDS.maxScopeFiles,
  files: Array.from({ length: DELEGATION_JOB_BOUNDS.maxScopeFiles }, (_, index) => ({
    coverage: 'complete' as const,
    path: `${index}/${fill(DELEGATION_JOB_BOUNDS.maxScopePathCharacters - 4, char)}`,
  })),
  includedBytes: 1,
  patchBytes: 2,
  patchSha256: 'c'.repeat(64),
  truncated: true,
  workingTreeDirty: true,
});

/** Every list and free text of the stored job at its bound, filled with `char` wherever the parsers admit text. */
const maximalJob = (char = FILL): DelegationJob => {
  const text = (length: number): string => fill(length, char);
  const excluded = storedJob.qualification?.routes[0];
  if (storedJob.qualification === null || excluded === undefined) {
    throw new Error('the stored job fixture needs a qualification with an excluded route');
  }
  const checkoutPath = `/${text(DELEGATION_BOUNDS.maxCheckoutPathCharacters - 1)}`;
  return {
    ...storedJob,
    accountScope: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    checkoutPath,
    effort: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    executedScope: maximalScope(char),
    failureReason: text(DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters),
    guarantee: {
      cliVersion: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
      controls: lines(
        DELEGATION_JOB_BOUNDS.maxGuaranteeEntries,
        DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters,
        char,
      ),
      effort: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
      harness: 'claude-code',
      limits: lines(DELEGATION_JOB_BOUNDS.maxGuaranteeEntries, DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters, char),
      model: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    },
    harnessVersion: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    machineId: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    modelRequested: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    modelResolved: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    poolId: text(DELEGATION_JOB_BOUNDS.maxIdCharacters),
    qualification: {
      ...storedJob.qualification,
      admissibleRouteIds: [],
      routes: Array.from({ length: 32 }, (_, index) => ({
        ...excluded,
        blockers: [...DELEGATION_ROUTE_BLOCKERS],
        routeId: `${index} ${text(DELEGATION_JOB_BOUNDS.maxIdCharacters - 3)}`,
      })),
    },
    request: {
      ...storedJob.request,
      checkout: { path: checkoutPath },
      constraints: lines(DELEGATION_BOUNDS.maxConstraints, DELEGATION_BOUNDS.maxConstraintCharacters, char),
      criteria: lines(DELEGATION_BOUNDS.maxCriteria, DELEGATION_BOUNDS.maxCriterionCharacters, char),
      objective: text(DELEGATION_BOUNDS.maxObjectiveCharacters),
      scope: {
        base: 'r'.repeat(DELEGATION_BOUNDS.maxRevisionCharacters),
        head: 'h'.repeat(DELEGATION_BOUNDS.maxRevisionCharacters),
        kind: 'range',
      },
    },
    result: maximalReview(char),
    retryOf: '1e2d3c4b-5a69-4788-9a1b-2c3d4e5f6a7b',
    routeId: text(DELEGATION_JOB_BOUNDS.maxIdCharacters),
    scope: {
      base: 'range-base',
      baseRef: 'r'.repeat(DELEGATION_BOUNDS.maxRevisionCharacters),
      baseSha: 'b'.repeat(64),
      commitCount: Number.MAX_SAFE_INTEGER,
      headRef: 'h'.repeat(DELEGATION_BOUNDS.maxRevisionCharacters),
      headSha: 'a'.repeat(64),
      kind: 'range',
    },
    selection: {
      confidence: 1,
      kind: 'choice',
      qualificationId: QUALIFICATION_ID,
      rationale: lines(
        DELEGATION_BOUNDS.maxSelectionRationale,
        DELEGATION_BOUNDS.maxSelectionRationaleCharacters,
        char,
      ),
      routeId: text(256),
      selectorVersion: text(DELEGATION_BOUNDS.maxSelectorVersionCharacters),
    },
    usage: {
      cachedInputTokens: Number.MAX_SAFE_INTEGER,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      source: 'harness-reported',
    },
  };
};

const projected = (job: DelegationJob, evaluations: readonly DelegationEvaluation[] = []) => {
  const view = projectDelegationJobView(job, evaluations, { now: LATER });
  const parsed = safeParse(delegationJobViewSchema, view);
  return {
    bytes: bytesOf(view),
    issues: parsed.success ? [] : parsed.issues.map((issue) => issue.message),
    view,
  };
};

/** How a projected view stands against the schema and the byte bound; `ACCEPTED` when it passes both. */
const acceptance = (result: ReturnType<typeof projected>): { issues: string[]; overBy: number } => ({
  issues: result.issues,
  overBy: Math.max(0, result.bytes - DELEGATION_BOUNDS.maxJobViewBytes),
});
const ACCEPTED: ReturnType<typeof acceptance> = { issues: [], overBy: 0 };

describe('job views projected by report-core through the web schema', () => {
  test('many long scope paths with realistic coverages: accepted, with scope files omitted and the findings kept', () => {
    // 64 files with 943-character paths (components of at most 200 characters), twelve criteria and
    // twelve constraints of 200 characters: what the producer admits, over the bound before any finding.
    const component = (seed: string): string => `${seed}${'x'.repeat(200 - seed.length)}`;
    const longPath = (index: number): string => {
      const parts = [component(`dir${index}-a`), component('b'), component('c'), component('d')];
      return `${parts.join('/')}/${`f${index}`.padEnd(943 - parts.join('/').length - 1, 'y')}`;
    };
    const coverages = ['complete', 'partial', 'omitted', 'binary'] as const;
    const wide: DelegationJob = {
      ...storedJob,
      executedScope: {
        fileCount: 64,
        files: Array.from({ length: 64 }, (_, index) => ({
          coverage: coverages[index % coverages.length] ?? 'complete',
          path: longPath(index),
        })),
        includedBytes: 60_000,
        patchBytes: 120_000,
        patchSha256: 'c'.repeat(64),
        truncated: true,
        workingTreeDirty: false,
      },
      request: { ...storedJob.request, constraints: lines(12, 203, 'k'), criteria: lines(12, 203, 'c') },
    };
    const result = projected(wide);
    expect(acceptance(result)).toEqual(ACCEPTED);
    expect(result.view.truncation.scopeFiles).toBeGreaterThan(0);
    expect(result.view.truncation.findings).toBe(0);
    expect(result.view.result?.findings).toHaveLength(1);
    expect(result.view.executedScope?.fileCount).toBe(64);
  });

  test('multibyte paths, findings and notes are accepted under the bound', () => {
    const emoji = '😀';
    const multibyte: DelegationJob = {
      ...storedJob,
      executedScope: maximalScope(),
      request: { ...storedJob.request, objective: fill(DELEGATION_BOUNDS.maxObjectiveCharacters / 2, emoji) },
      result: maximalReview(),
    };
    const result = projected(multibyte, crowd());
    expect(acceptance(result)).toEqual(ACCEPTED);
    expect(result.view.truncation.scopeFiles).toBeGreaterThan(0);
    expect(LONE_SURROGATE.test(result.view.request.objective)).toBe(false);
  });

  test('a job without a result, and a refused decision with no frozen scope, are accepted', () => {
    const bare = projected({ ...maximalJob(), result: null }, crowd());
    expect(acceptance(bare)).toEqual(ACCEPTED);
    expect(bare.view.result).toBeNull();
    expect(bare.view.frozenScope).toEqual(maximalJob().scope);
    const refused = projected({
      ...storedJob,
      failureReason: 'No route is admissible for this request.',
      refusalReason: 'no-admissible-route',
      result: null,
      routeId: null,
      scope: null,
      startedAt: null,
      state: 'refused',
    });
    expect(acceptance(refused)).toEqual(ACCEPTED);
    expect(refused.view.frozenScope).toBeNull();
    expect(refused.view.refusal).toEqual({
      message: 'No route is admissible for this request.',
      reason: 'no-admissible-route',
    });
  });

  test('large evaluations with every finding already removed are accepted; the operator acceptance stays listed', () => {
    const heavy: DelegationJob = { ...storedJob, executedScope: null, result: maximalReview() };
    const result = projected(heavy, crowd());
    expect(acceptance(result)).toEqual(ACCEPTED);
    expect(result.view.truncation.findings).toBe(DELEGATION_RESULT_BOUNDS.maxFindings);
    expect(result.view.result?.findings).toEqual([]);
    expect(result.view.evaluations.acceptance?.evaluationId).toBe('acceptance-operator--1');
    expect(result.view.status).toEqual({ accepted: 'taken-over', executed: 'succeeded', verified: 'confirmed' });
  });

  test('the frozen scope travels in the view for a commit and for a base..head range', () => {
    const commit = projected(storedJob);
    expect(acceptance(commit)).toEqual(ACCEPTED);
    expect(commit.view.frozenScope).toEqual(frozenCommit);
    expect(commit.view.request.scope).toEqual({ commit: 'HEAD', kind: 'commit' });
    const frozenRange = {
      base: 'range-base',
      baseRef: 'main',
      baseSha: 'e'.repeat(40),
      commitCount: 3,
      headRef: 'release/1.2',
      headSha: 'f'.repeat(40),
      kind: 'range',
    } as const;
    const range = projected({
      ...storedJob,
      request: { ...storedJob.request, scope: { base: 'main', head: 'release/1.2', kind: 'range' } },
      scope: frozenRange,
    });
    expect(acceptance(range)).toEqual(ACCEPTED);
    expect(range.view.frozenScope).toEqual(frozenRange);
  });

  test('the maximal record is accepted, its notes within the note bound, and fifty such views pass the list schema', () => {
    const result = projected(maximalJob(), crowd());
    expect(acceptance(result)).toEqual(ACCEPTED);
    expect(result.view.truncation.characters).toBeGreaterThan(0);
    expect(result.view.truncation.scopeFiles).toBe(DELEGATION_JOB_BOUNDS.maxScopeFiles);
    expect(result.view.notes.every((note) => note.length <= DELEGATION_WEB_BOUNDS.maxNoteCharacters)).toBe(true);
    // The Web list carries whole views; its byte bound is the server's (`maxJobsListBytes`, counted in `omitted`).
    const list = parseDelegationJobsOutput({
      jobs: Array.from({ length: DELEGATION_WEB_BOUNDS.maxListLimit }, () => result.view),
      omitted: 0,
      skipped: 0,
    });
    expect(list.jobs).toHaveLength(DELEGATION_WEB_BOUNDS.maxListLimit);
  });
});

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

  test('a list fact may be partly identified; a scalar fact may not', () => {
    const source = 'git remote -v (1 of 3 remote URLs not identified)';
    const partial: DelegationQualificationWire = {
      ...qualificationFixture,
      checkoutFacts: {
        gitAuthorEmail: { provenance: 'observed', source: 'git config user.email', value: 'operator@example.test' },
        githubAccount: { provenance: 'unknown', source: 'github.accounts (remotes not all identified)', value: null },
        githubOwners: { provenance: 'partial', source, value: ['acme'] },
        repositories: { provenance: 'partial', source, value: ['acme/ai-usage'] },
      },
    };
    expect(parseDelegationQualificationWire(partial)).toEqual(partial);
    expect(() =>
      parseDelegationQualificationWire({
        ...partial,
        checkoutFacts: {
          ...partial.checkoutFacts,
          gitAuthorEmail: { provenance: 'partial', source: 'git config user.email', value: 'operator@example.test' },
        },
      }),
    ).toThrow();
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
