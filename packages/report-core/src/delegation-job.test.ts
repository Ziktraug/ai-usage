import { describe, expect, test } from 'bun:test';
import type { DelegationEvaluation, DelegationJob, DelegationReviewResult } from './delegation-contracts';
import {
  DELEGATION_JOB_BOUNDS,
  DELEGATION_JOB_SUMMARY_BOUNDS,
  parseDelegationEvaluation,
  parseDelegationEvaluationInput,
  parseDelegationJob,
  projectDelegationJobView,
  summarizeDelegationJobView,
} from './delegation-job';
import { DELEGATION_RESULT_BOUNDS } from './delegation-result';
import { DELEGATION_BOUNDS, DELEGATION_ROUTE_BLOCKERS } from './delegation-vocabulary';

const NOW = '2026-10-25T10:00:00.000Z';
const LATER = '2026-10-25T10:05:00.000Z';
const JOB_ID = '7d3f9d2a-3b1c-4e8f-9a6b-1c2d3e4f5a6b';
const QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';

const review: DelegationReviewResult = {
  checks: ['read the patch'],
  coverage: { notReviewed: [], reviewed: 'Everything in the patch.' },
  findings: [
    {
      detail: 'The null branch returns before the lock is released.',
      evidence: [{ line: 42, path: 'src/lock.ts' }],
      severity: 'major',
      title: 'Lock leaks on the null branch',
    },
  ],
  limits: ['did not run the tests'],
  summary: 'One major finding.',
};

const job: DelegationJob = {
  accountScope: 'personal',
  action: 'read-only-review',
  attemptNumber: 1,
  cancelRequestedAt: null,
  checkoutPath: '/home/fixture/work/project',
  context: 'personal',
  effort: 'high',
  endedAt: LATER,
  executedScope: {
    fileCount: 2,
    files: [
      { coverage: 'complete', path: 'src/lock.ts' },
      { coverage: 'partial', path: 'src/lock.test.ts' },
    ],
    includedBytes: 100,
    patchBytes: 120,
    patchSha256: 'c'.repeat(64),
    truncated: true,
    workingTreeDirty: false,
  },
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  guarantee: {
    cliVersion: '2.1.303 (Claude Code)',
    controls: ['tools Read Grep Glob', 'setting sources none', 'safe mode', 'no MCP servers'],
    effort: 'high',
    harness: 'claude-code',
    limits: ['managed policy not excluded'],
    model: 'claude-opus-4-1',
  },
  harnessVersion: '2.1.303',
  idempotencyKey: 'caller:session-1:review-7',
  jobId: JOB_ID,
  launchMarker: '2f6a0c4e-5d7b-4a9c-8e1f-2b3c4d5e6f70',
  machineId: 'machine-a',
  modelRequested: 'claude-opus-4-1',
  modelResolved: 'claude-opus-4-1-20250805',
  nativeSessionId: 'native-1',
  pid: 4242,
  poolId: 'machine-a/claude-code/personal',
  qualification: {
    admissibleRouteIds: ['route-a'],
    appliedRules: [],
    assumptions: [],
    checkout: { admittedBy: '/home/fixture/work', path: '/home/fixture/work/project', projectLabel: 'project' },
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
        accountScope: 'personal',
        admissible: true,
        advantages: [],
        blockers: [],
        context: 'personal',
        effort: 'high',
        exclusions: [],
        harness: 'claude-code',
        identity: null,
        label: 'Claude Code (personal)',
        limits: [],
        liveJobsInPool: 0,
        missing: [],
        model: 'claude-opus-4-1',
        orderHint: 0,
        poolId: 'machine-a/claude-code/personal',
        provider: 'anthropic',
        quota: [],
        requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
        routeId: 'route-a',
      },
      {
        accountScope: 'work',
        admissible: false,
        advantages: [],
        blockers: ['reserve', 'forbidden-by-rule'],
        context: 'professional',
        effort: null,
        exclusions: ['reserve 20% not met'],
        harness: 'codex',
        identity: null,
        label: 'Codex (work)',
        limits: [],
        liveJobsInPool: 0,
        missing: [],
        model: 'gpt-5-codex',
        orderHint: null,
        poolId: 'machine-a/codex/work',
        provider: 'openai',
        quota: [],
        requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
        routeId: 'route-b',
      },
    ],
    schemaVersion: 1,
    scope: null,
    validUntil: LATER,
    versions: {
      catalogRevision: 'cat0123456789abc',
      policyRevision: 'pol0123456789abc',
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
    checkout: { path: '/home/fixture/work/project' },
    client: { name: 'claude-code', sessionRef: 'session-1' },
    constraints: ['Stay on the diff.'],
    criteria: ['Every public function keeps its contract.'],
    objective: 'Review the lock refactor for correctness.',
    schemaVersion: 1,
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestDigest: 'd'.repeat(64),
  requestedAt: NOW,
  result: { excerpt: null, kind: 'review', review },
  retryOf: null,
  routeId: 'route-a',
  scope: {
    base: 'first-parent',
    baseRef: null,
    baseSha: 'b'.repeat(40),
    commitCount: 1,
    headRef: 'HEAD',
    headSha: 'a'.repeat(40),
    kind: 'commit',
  },
  selection: {
    confidence: 0.8,
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    rationale: ['recommended for correctness'],
    routeId: 'route-a',
    selectorVersion: 'calling-model/claude-code',
  },
  startedAt: NOW,
  state: 'finished',
  taskCategory: 'correctness',
  traceVersion: 1,
  updatedAt: LATER,
  usage: { cachedInputTokens: 1000, inputTokens: 5000, outputTokens: 800, source: 'harness-reported' },
};

const plain = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** A lone surrogate: what a cut inside a pair would leave behind. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Every truncation counter at zero: the view carried the whole record. */
const NO_CUT = {
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
} as const;

const evaluation = (overrides: Partial<DelegationEvaluation> = {}): DelegationEvaluation => ({
  author: 'calling-model',
  authorLabel: 'claude-code',
  checks: ['re-read src/lock.ts'],
  evaluationId: 'eval-1',
  jobId: JOB_ID,
  kind: 'verification',
  note: 'The leak is real.',
  recordedAt: LATER,
  verdict: 'confirmed',
  ...overrides,
});

const FILL = '語';
const fill = (length: number, char = FILL): string => char.repeat(length);
const RETRY_OF = '1e2d3c4b-5a69-4788-9a1b-2c3d4e5f6a7b';
/** `mcpToolOutputBounds.maxOutputBytes` of the MCP adapter: what fifty list entries and their envelope must fit. */
const MCP_TOOL_OUTPUT_BYTES = 192 * 1024;

/** Every list and free text of a record at its bound, filled with `char` wherever the parsers admit text. */
const maximalJob = (char = FILL): DelegationJob => {
  const text = (length: number): string => fill(length, char);
  const lines = (count: number, length: number): string[] =>
    Array.from({ length: count }, (_, index) => `${index} ${text(length - 3)}`);
  const excluded = job.qualification?.routes[1];
  if (job.qualification === null || excluded === undefined) {
    throw new Error('the fixture job needs a qualification with an excluded route');
  }
  const checkoutPath = `/${text(DELEGATION_BOUNDS.maxCheckoutPathCharacters - 1)}`;
  return {
    ...job,
    accountScope: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    checkoutPath,
    effort: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    executedScope: {
      fileCount: DELEGATION_JOB_BOUNDS.maxScopeFiles,
      files: Array.from({ length: DELEGATION_JOB_BOUNDS.maxScopeFiles }, (_, index) => ({
        coverage: 'complete' as const,
        path: `${index}/${text(DELEGATION_JOB_BOUNDS.maxScopePathCharacters - 4)}`,
      })),
      includedBytes: 1,
      patchBytes: 2,
      patchSha256: 'c'.repeat(64),
      truncated: true,
      workingTreeDirty: true,
    },
    failureReason: text(DELEGATION_JOB_BOUNDS.maxFailureReasonCharacters),
    guarantee: {
      cliVersion: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
      controls: lines(DELEGATION_JOB_BOUNDS.maxGuaranteeEntries, DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters),
      effort: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
      harness: 'claude-code',
      limits: lines(DELEGATION_JOB_BOUNDS.maxGuaranteeEntries, DELEGATION_JOB_BOUNDS.maxGuaranteeEntryCharacters),
      model: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    },
    harnessVersion: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    machineId: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    modelRequested: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    modelResolved: text(DELEGATION_JOB_BOUNDS.maxTextCharacters),
    poolId: text(DELEGATION_JOB_BOUNDS.maxIdCharacters),
    qualification: {
      ...job.qualification,
      admissibleRouteIds: [],
      routes: Array.from({ length: 32 }, (_, index) => ({
        ...excluded,
        blockers: [...DELEGATION_ROUTE_BLOCKERS],
        routeId: `${index} ${text(DELEGATION_JOB_BOUNDS.maxIdCharacters - 3)}`,
      })),
    },
    request: {
      ...job.request,
      checkout: { path: checkoutPath },
      constraints: lines(DELEGATION_BOUNDS.maxConstraints, DELEGATION_BOUNDS.maxConstraintCharacters),
      criteria: lines(DELEGATION_BOUNDS.maxCriteria, DELEGATION_BOUNDS.maxCriterionCharacters),
      objective: text(DELEGATION_BOUNDS.maxObjectiveCharacters),
      scope: {
        base: 'r'.repeat(DELEGATION_BOUNDS.maxRevisionCharacters),
        head: 'h'.repeat(DELEGATION_BOUNDS.maxRevisionCharacters),
        kind: 'range',
      },
    },
    result: {
      excerpt: text(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters),
      kind: 'review',
      review: {
        checks: lines(DELEGATION_RESULT_BOUNDS.maxChecks, DELEGATION_RESULT_BOUNDS.maxCheckCharacters),
        coverage: {
          notReviewed: lines(
            DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewed,
            DELEGATION_RESULT_BOUNDS.maxCoverageNotReviewedCharacters,
          ),
          reviewed: text(DELEGATION_RESULT_BOUNDS.maxCoverageReviewedCharacters),
        },
        findings: Array.from({ length: DELEGATION_RESULT_BOUNDS.maxFindings }, (_, index) => ({
          detail: text(DELEGATION_RESULT_BOUNDS.maxDetailCharacters),
          evidence: Array.from({ length: DELEGATION_RESULT_BOUNDS.maxEvidencePerFinding }, (_entry, line) => ({
            line: line + 1,
            path: `${index}/${text(DELEGATION_RESULT_BOUNDS.maxPathCharacters - 4)}`,
          })),
          severity: 'major' as const,
          title: `${index} ${text(DELEGATION_RESULT_BOUNDS.maxTitleCharacters - 3)}`,
        })),
        limits: lines(DELEGATION_RESULT_BOUNDS.maxLimits, DELEGATION_RESULT_BOUNDS.maxLimitCharacters),
        summary: text(DELEGATION_RESULT_BOUNDS.maxSummaryCharacters),
      },
    },
    retryOf: RETRY_OF,
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
      rationale: lines(DELEGATION_BOUNDS.maxSelectionRationale, DELEGATION_BOUNDS.maxSelectionRationaleCharacters),
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

/** An evaluation at every bound, with a stable id and a distinct instant per index. */
const maximalEvaluation = (
  index: number,
  kind: DelegationEvaluation['kind'],
  author: DelegationEvaluation['author'],
  char = FILL,
): DelegationEvaluation =>
  evaluation({
    author,
    authorLabel: fill(DELEGATION_JOB_BOUNDS.maxTextCharacters, char),
    checks: Array.from(
      { length: DELEGATION_BOUNDS.maxEvaluationChecks },
      (_, check) => `${check} ${fill(DELEGATION_BOUNDS.maxEvaluationCheckCharacters - 3, char)}`,
    ),
    evaluationId: `${kind}-${author}-${String(index).padStart(2, '0')}-${fill(DELEGATION_JOB_BOUNDS.maxIdCharacters - 40, char)}`,
    kind,
    note: fill(DELEGATION_BOUNDS.maxEvaluationNoteCharacters, char),
    recordedAt: new Date(Date.parse(LATER) + index * 60_000).toISOString(),
    verdict: kind === 'verification' ? 'confirmed' : 'taken-over',
  });

/** Sixty-one evaluations at every bound: the three lists full, plus the operator's acceptance. */
const maximalCrowd = (char = FILL): DelegationEvaluation[] => [
  ...Array.from({ length: 20 }, (_, index) => maximalEvaluation(index, 'verification', 'calling-model', char)),
  ...Array.from({ length: 20 }, (_, index) => maximalEvaluation(index, 'acceptance', 'calling-model', char)),
  ...Array.from({ length: 20 }, (_, index) => maximalEvaluation(index, 'verification', 'automated-check', char)),
  maximalEvaluation(-1, 'acceptance', 'operator', char),
];

describe('parseDelegationJob', () => {
  test('re-validates a stored job and returns it with the request and selection copied', () => {
    const parsed = parseDelegationJob(plain(job));
    expect(parsed).toEqual(job);
    expect(parsed?.request).not.toBe(job.request);
  });

  test('accepts a refused decision row with nothing launched, and an abstention', () => {
    const refused: DelegationJob = {
      ...job,
      accountScope: null,
      context: null,
      effort: null,
      endedAt: NOW,
      executedScope: null,
      executorHarness: null,
      exitCode: null,
      failureReason: 'route route-a is no longer admissible: reserve 20% not met',
      guarantee: null,
      harnessVersion: null,
      launchMarker: null,
      modelRequested: null,
      modelResolved: null,
      nativeSessionId: null,
      pid: null,
      poolId: null,
      refusalReason: 'route-not-admissible',
      result: null,
      routeId: null,
      startedAt: null,
      state: 'refused',
      usage: null,
    };
    expect(parseDelegationJob(plain(refused))).toEqual(refused);
    const abstained: DelegationJob = {
      ...refused,
      failureReason: null,
      refusalReason: null,
      selection: {
        kind: 'abstain',
        note: 'Too small to delegate.',
        qualificationId: QUALIFICATION_ID,
        reason: 'keep-with-caller',
        selectorVersion: 'calling-model/claude-code',
      },
      state: 'abstained',
    };
    expect(parseDelegationJob(plain(abstained))).toEqual(abstained);
  });

  test('refuses unknown keys, bad vocabulary and inconsistent reservation facts', () => {
    expect(parseDelegationJob({ ...job, extra: true })).toBeNull();
    expect(parseDelegationJob({ ...job, state: 'paused' })).toBeNull();
    expect(parseDelegationJob({ ...job, context: 'hobby' })).toBeNull();
    expect(parseDelegationJob({ ...job, executorHarness: 'cursor' })).toBeNull();
    expect(parseDelegationJob({ ...job, idempotencyKey: 'short' })).toBeNull();
    expect(parseDelegationJob({ ...job, attemptNumber: 0 })).toBeNull();
    expect(parseDelegationJob({ ...job, requestedAt: 'yesterday' })).toBeNull();
    // A refusal reason only on a refused row, and a refused row always names one.
    expect(parseDelegationJob({ ...job, refusalReason: 'pool-busy' })).toBeNull();
    expect(parseDelegationJob({ ...job, state: 'refused' })).toBeNull();
    // Release facts come as a pair, and only on a lost row.
    expect(parseDelegationJob({ ...job, releasedAt: LATER })).toBeNull();
    expect(parseDelegationJob({ ...job, releaseEvidence: 'process-absent' })).toBeNull();
    expect(parseDelegationJob({ ...job, releaseEvidence: 'process-absent', releasedAt: LATER })).toBeNull();
    expect(
      parseDelegationJob({ ...job, releaseEvidence: 'process-absent', releasedAt: LATER, state: 'lost' }),
    ).toMatchObject({ state: 'lost' });
    // A review result carries a review; any other kind carries none.
    expect(parseDelegationJob({ ...job, result: { excerpt: null, kind: 'review', review: null } })).toBeNull();
    expect(parseDelegationJob({ ...job, result: { excerpt: 'x', kind: 'unstructured', review } })).toBeNull();
    expect(
      parseDelegationJob({ ...job, result: { excerpt: 'prose', kind: 'unstructured', review: null } }),
    ).toMatchObject({ result: { kind: 'unstructured' } });
    expect(
      parseDelegationJob({ ...job, result: { excerpt: null, kind: 'review', review: { summary: 1 } } }),
    ).toBeNull();
  });

  test('re-validates the nested facts: frozen scope, executed scope, guarantee, usage, selection', () => {
    expect(parseDelegationJob({ ...job, scope: { ...job.scope, kind: 'working-tree' } })).toBeNull();
    expect(parseDelegationJob({ ...job, scope: { ...job.scope, base: 'range-base' } })).toBeNull();
    expect(parseDelegationJob({ ...job, scope: { ...job.scope, headSha: 'not-a-sha' } })).toBeNull();
    expect(parseDelegationJob({ ...job, scope: { ...job.scope, commitCount: 0 } })).toBeNull();
    expect(parseDelegationJob({ ...job, executedScope: { ...job.executedScope, includedBytes: 200 } })).toBeNull();
    expect(parseDelegationJob({ ...job, executedScope: { ...job.executedScope, truncated: false } })).toBeNull();
    expect(
      parseDelegationJob({
        ...job,
        executedScope: { ...job.executedScope, files: [{ coverage: 'skipped', path: 'a' }] },
      }),
    ).toBeNull();
    expect(
      parseDelegationJob({
        ...job,
        executedScope: {
          ...job.executedScope,
          fileCount: DELEGATION_JOB_BOUNDS.maxScopeFiles + 1,
          files: Array.from({ length: DELEGATION_JOB_BOUNDS.maxScopeFiles + 1 }, () => ({
            coverage: 'complete',
            path: 'a',
          })),
        },
      }),
    ).toBeNull();
    expect(parseDelegationJob({ ...job, guarantee: { ...job.guarantee, harness: 'opencode' } })).toBeNull();
    expect(parseDelegationJob({ ...job, guarantee: { ...job.guarantee, controls: 'read-only' } })).toBeNull();
    expect(parseDelegationJob({ ...job, usage: { ...job.usage, source: 'estimated' } })).toBeNull();
    expect(parseDelegationJob({ ...job, usage: { ...job.usage, inputTokens: -1 } })).toBeNull();
    expect(parseDelegationJob({ ...job, selection: { ...job.selection, confidence: 2 } })).toBeNull();
    expect(parseDelegationJob({ ...job, selection: { ...job.selection, kind: 'pick' } })).toBeNull();
    expect(
      parseDelegationJob({
        ...job,
        selection: { kind: 'abstain', qualificationId: QUALIFICATION_ID, reason: 'bored', selectorVersion: 'x' },
      }),
    ).toBeNull();
  });

  test('checks the stored request for shape and bounds but leaves its deep validation to the producer', () => {
    expect(parseDelegationJob({ ...job, request: { ...job.request, schemaVersion: 2 } })).toBeNull();
    expect(parseDelegationJob({ ...job, request: { ...job.request, objective: '' } })).toBeNull();
    expect(
      parseDelegationJob({
        ...job,
        request: { ...job.request, objective: 'o'.repeat(DELEGATION_BOUNDS.maxObjectiveCharacters + 1) },
      }),
    ).toBeNull();
    expect(parseDelegationJob({ ...job, request: { ...job.request, criteria: 'all' } })).toBeNull();
    expect(parseDelegationJob({ ...job, request: { ...job.request, checkout: { path: 'relative' } } })).toBeNull();
    // A refused row may carry a request for a reserved action or scope kind: the decision needs the record.
    expect(
      parseDelegationJob({
        ...job,
        request: { ...job.request, action: 'code-change', scope: { kind: 'working-tree' } },
      }),
    ).toMatchObject({ request: { action: 'code-change', scope: { kind: 'working-tree' } } });
    // Keys the producer may add later are dropped, not refused.
    expect(parseDelegationJob({ ...job, request: { ...job.request, future: 1 } })?.request).toEqual(job.request);
    // The qualification snapshot is opaque beyond its version and id.
    expect(parseDelegationJob({ ...job, qualification: { schemaVersion: 1 } })).toBeNull();
    expect(parseDelegationJob({ ...job, qualification: { qualificationId: 'other', schemaVersion: 2 } })).toBeNull();
    expect(
      parseDelegationJob({ ...job, qualification: { qualificationId: QUALIFICATION_ID, schemaVersion: 1 } }),
    ).toMatchObject({ qualification: { qualificationId: QUALIFICATION_ID } });
  });
});

describe('parseDelegationEvaluation', () => {
  test('re-validates a stored evaluation and pairs the verdict with its kind', () => {
    expect(parseDelegationEvaluation(plain(evaluation()))).toEqual(evaluation());
    expect(parseDelegationEvaluation(evaluation({ kind: 'acceptance', verdict: 'taken-over' }))).not.toBeNull();
    expect(parseDelegationEvaluation(evaluation({ kind: 'acceptance', verdict: 'confirmed' }))).toBeNull();
    expect(parseDelegationEvaluation(evaluation({ kind: 'verification', verdict: 'accepted' }))).toBeNull();
    expect(parseDelegationEvaluation(evaluation({ author: 'reviewer' as never }))).toBeNull();
    expect(parseDelegationEvaluation({ ...evaluation(), extra: 1 })).toBeNull();
    expect(
      parseDelegationEvaluation(evaluation({ note: 'n'.repeat(DELEGATION_BOUNDS.maxEvaluationNoteCharacters + 1) })),
    ).toBeNull();
    expect(
      parseDelegationEvaluation(
        evaluation({ checks: Array.from({ length: DELEGATION_BOUNDS.maxEvaluationChecks + 1 }, () => 'c') }),
      ),
    ).toBeNull();
  });
});

describe('parseDelegationEvaluationInput', () => {
  const edge = { author: 'calling-model', authorLabel: 'claude-code' } as const;

  test('takes the author from the edge and refuses one in the payload', () => {
    expect(parseDelegationEvaluationInput({ kind: 'verification', verdict: 'confirmed' }, edge)).toEqual({
      evaluation: {
        author: 'calling-model',
        authorLabel: 'claude-code',
        checks: [],
        kind: 'verification',
        note: null,
        verdict: 'confirmed',
      },
      kind: 'ok',
    });
    const withAuthor = parseDelegationEvaluationInput(
      { author: 'operator', kind: 'acceptance', verdict: 'accepted' },
      edge,
    );
    expect(withAuthor.kind).toBe('invalid');
    if (withAuthor.kind === 'invalid') {
      expect(withAuthor.issues.join(' ')).toContain('author');
    }
    expect(
      parseDelegationEvaluationInput({ authorLabel: 'me', kind: 'acceptance', verdict: 'accepted' }, edge).kind,
    ).toBe('invalid');
    // The edge label is bounded and blank means none.
    expect(
      parseDelegationEvaluationInput(
        { kind: 'acceptance', verdict: 'accepted' },
        { author: 'operator', authorLabel: '  ' },
      ),
    ).toMatchObject({ evaluation: { author: 'operator', authorLabel: null }, kind: 'ok' });
  });

  test('pairs kind and verdict, bounds the note and the checks, and refuses unknown keys', () => {
    expect(parseDelegationEvaluationInput({ kind: 'verification', verdict: 'accepted' }, edge).kind).toBe('invalid');
    expect(parseDelegationEvaluationInput({ kind: 'acceptance', verdict: 'refuted' }, edge).kind).toBe('invalid');
    expect(parseDelegationEvaluationInput({ kind: 'review', verdict: 'confirmed' }, edge).kind).toBe('invalid');
    expect(
      parseDelegationEvaluationInput(
        {
          kind: 'verification',
          note: 'n'.repeat(DELEGATION_BOUNDS.maxEvaluationNoteCharacters + 1),
          verdict: 'refuted',
        },
        edge,
      ).kind,
    ).toBe('invalid');
    expect(
      parseDelegationEvaluationInput(
        {
          checks: ['c'.repeat(DELEGATION_BOUNDS.maxEvaluationCheckCharacters + 1)],
          kind: 'verification',
          verdict: 'refuted',
        },
        edge,
      ).kind,
    ).toBe('invalid');
    expect(
      parseDelegationEvaluationInput(
        {
          checks: Array.from({ length: DELEGATION_BOUNDS.maxEvaluationChecks + 1 }, () => 'bun test'),
          kind: 'verification',
          verdict: 'refuted',
        },
        edge,
      ).kind,
    ).toBe('invalid');
    expect(parseDelegationEvaluationInput({ kind: 'verification', verdict: 'refuted', when: 'now' }, edge).kind).toBe(
      'invalid',
    );
    expect(parseDelegationEvaluationInput('confirmed', edge).kind).toBe('invalid');
    expect(
      parseDelegationEvaluationInput(
        {
          checks: ['bun test', 'bun x tsc --noEmit'],
          kind: 'verification',
          note: 'Ran both.',
          verdict: 'partially-confirmed',
        },
        edge,
      ),
    ).toMatchObject({
      evaluation: { checks: ['bun test', 'bun x tsc --noEmit'], note: 'Ran both.', verdict: 'partially-confirmed' },
      kind: 'ok',
    });
  });
});

describe('projectDelegationJobView', () => {
  test('separates execution, verification and acceptance and says so in its notes', () => {
    const view = projectDelegationJobView(job, [], { now: LATER });
    expect(view).toMatchObject({
      jobId: JOB_ID,
      live: false,
      reservation: { evidence: null, held: false, releasedAt: null },
      result: { kind: 'review', summary: 'One major finding.' },
      route: { harness: 'claude-code', modelResolved: 'claude-opus-4-1-20250805', routeId: 'route-a' },
      state: 'finished',
      status: { accepted: 'pending', executed: 'succeeded', verified: 'not-verified' },
      truncation: { evidence: 0, findings: 0, notReviewed: 0 },
    });
    expect(view.heartbeatAgeSeconds).toBeNull();
    expect(view.notes.join(' ')).toContain('finished execution is not a verification');
    expect(view.notes.join(' ')).toContain('verification is not an acceptance');
    expect(view.qualification).toMatchObject({
      admissibleRoutes: 1,
      catalogRevision: 'cat0123456789abc',
      excludedRoutes: [{ blockers: ['reserve', 'forbidden-by-rule'], routeId: 'route-b' }],
      policyRevision: 'pol0123456789abc',
      qualificationId: QUALIFICATION_ID,
    });
    expect(view.request).toEqual({
      action: 'read-only-review',
      checkoutPath: '/home/fixture/work/project',
      constraints: ['Stay on the diff.'],
      criteria: ['Every public function keeps its contract.'],
      objective: 'Review the lock refactor for correctness.',
      scope: { commit: 'HEAD', kind: 'commit' },
      taskCategory: 'correctness',
    });
    // JSON-safe: no undefined, survives a round trip unchanged.
    expect(plain(view)).toEqual(view);
  });

  test('returns the frozen scope the engine recorded, apart from the requested one, and null when none was recorded', () => {
    const view = projectDelegationJobView(job, [], { now: LATER });
    // The request named a symbolic revision; the frozen scope is what was actually reviewed.
    expect(view.request.scope).toEqual({ commit: 'HEAD', kind: 'commit' });
    expect(view.frozenScope).toEqual({
      base: 'first-parent',
      baseRef: null,
      baseSha: 'b'.repeat(40),
      commitCount: 1,
      headRef: 'HEAD',
      headSha: 'a'.repeat(40),
      kind: 'commit',
    });
    expect(view.frozenScope).not.toBe(job.scope);
    const range = projectDelegationJobView(
      {
        ...job,
        request: { ...job.request, scope: { base: 'main', head: 'feat/lock', kind: 'range' } },
        scope: {
          base: 'range-base',
          baseRef: 'main',
          baseSha: 'e'.repeat(40),
          commitCount: 3,
          headRef: 'feat/lock',
          headSha: 'f'.repeat(40),
          kind: 'range',
        },
      },
      [],
      { now: LATER },
    );
    expect(range.frozenScope).toEqual({
      base: 'range-base',
      baseRef: 'main',
      baseSha: 'e'.repeat(40),
      commitCount: 3,
      headRef: 'feat/lock',
      headSha: 'f'.repeat(40),
      kind: 'range',
    });
    // A refused decision froze nothing, and an older record may carry no scope: the proof stays missing.
    const refused = projectDelegationJobView(
      { ...job, refusalReason: 'scope-unavailable', result: null, routeId: null, scope: null, state: 'refused' },
      [],
      { now: LATER },
    );
    expect(refused.frozenScope).toBeNull();
    expect(refused.request.scope).toEqual({ commit: 'HEAD', kind: 'commit' });
  });

  test('reads the latest verification and the operator acceptance; a calling model acceptance stays its statement', () => {
    const view = projectDelegationJobView(
      job,
      [
        evaluation({ evaluationId: 'check-1', author: 'automated-check', authorLabel: 'engine', verdict: 'confirmed' }),
        evaluation({ evaluationId: 'v-1', recordedAt: '2026-10-25T10:06:00.000Z', verdict: 'refuted' }),
        evaluation({ evaluationId: 'v-2', recordedAt: '2026-10-25T10:07:00.000Z', verdict: 'partially-confirmed' }),
        evaluation({
          author: 'calling-model',
          evaluationId: 'a-caller',
          kind: 'acceptance',
          recordedAt: '2026-10-25T10:08:00.000Z',
          verdict: 'taken-over',
        }),
      ],
      { now: LATER },
    );
    expect(view.status).toEqual({ accepted: 'pending', executed: 'succeeded', verified: 'partially-confirmed' });
    expect(view.evaluations.automatedChecks.map(({ evaluationId }) => evaluationId)).toEqual(['check-1']);
    expect(view.evaluations.verifications.map(({ evaluationId }) => evaluationId)).toEqual(['v-2', 'v-1']);
    expect(view.evaluations.acceptances.map(({ evaluationId }) => evaluationId)).toEqual(['a-caller']);
    expect(view.evaluations.acceptance).toBeNull();
    const accepted = projectDelegationJobView(
      job,
      [
        evaluation({
          author: 'operator',
          authorLabel: 'web',
          evaluationId: 'a-op',
          kind: 'acceptance',
          recordedAt: '2026-10-25T10:09:00.000Z',
          verdict: 'rejected',
        }),
      ],
      { now: LATER },
    );
    expect(accepted.status.accepted).toBe('rejected');
    expect(accepted.evaluations.acceptance?.evaluationId).toBe('a-op');
  });

  test('describes live, lost and refused jobs', () => {
    const running = projectDelegationJobView(
      { ...job, endedAt: null, modelResolved: null, result: null, state: 'running', updatedAt: NOW },
      [],
      { now: '2026-10-25T10:00:42.000Z' },
    );
    expect(running).toMatchObject({
      heartbeatAgeSeconds: 42,
      live: true,
      reservation: { held: true },
      result: null,
      route: { modelResolved: 'unknown' },
      status: { executed: 'running' },
    });
    expect(running.notes.join(' ')).toContain('did not report');
    const lost = projectDelegationJobView(
      { ...job, failureReason: 'engine restarted while running', result: null, state: 'lost' },
      [],
      { now: LATER },
    );
    expect(lost).toMatchObject({
      failure: 'engine restarted while running',
      live: false,
      reservation: { held: true },
      status: { executed: 'unknown' },
    });
    expect(lost.notes.join(' ')).toContain('lost contact');
    expect(lost.notes.join(' ')).toContain('nothing was relaunched');
    const released = projectDelegationJobView(
      { ...job, releaseEvidence: 'process-absent', releasedAt: LATER, result: null, state: 'lost' },
      [],
      { now: LATER },
    );
    expect(released.reservation).toEqual({ evidence: 'process-absent', held: false, releasedAt: LATER });
    const refused = projectDelegationJobView(
      {
        ...job,
        failureReason: 'pool machine-a/claude-code/personal already runs 1 job',
        refusalReason: 'pool-busy',
        result: null,
        routeId: null,
        startedAt: null,
        state: 'refused',
      },
      [],
      { now: LATER },
    );
    expect(refused).toMatchObject({
      failure: null,
      refusal: { message: 'pool machine-a/claude-code/personal already runs 1 job', reason: 'pool-busy' },
      route: null,
      status: { executed: 'not-run' },
    });
  });

  test('stays under the view byte bound by trimming findings, then evidence, and counts what it trimmed', () => {
    const heavy: DelegationJob = {
      ...job,
      result: {
        excerpt: null,
        kind: 'review',
        review: {
          ...review,
          coverage: { notReviewed: Array.from({ length: 50 }, (_, index) => `skipped/${index}.ts`), reviewed: 'x' },
          findings: Array.from({ length: 50 }, (_, index) => ({
            detail: `${index} ${'d'.repeat(1990)}`,
            evidence: Array.from({ length: 8 }, (_entry, line) => ({ line: line + 1, path: `src/${'p'.repeat(400)}` })),
            severity: 'minor' as const,
            title: `Finding ${index}`,
          })),
        },
      },
    };
    const view = projectDelegationJobView(heavy, [], { now: LATER });
    const bytes = new TextEncoder().encode(JSON.stringify(view)).byteLength;
    expect(bytes).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxJobViewBytes);
    expect(view.truncation.findings).toBeGreaterThan(0);
    expect(view.result?.findings.length).toBe(50 - view.truncation.findings);
    expect(view.notes.join(' ')).toContain('omitted');
    // Findings are kept in order; the last ones go first.
    expect(view.result?.findings[0]?.title).toBe('Finding 0');
    // Evidence is trimmed only once no finding is left to drop, so a mid-size result keeps every finding.
    const medium: DelegationJob = {
      ...job,
      result: {
        excerpt: null,
        kind: 'review',
        review: {
          ...review,
          findings: Array.from({ length: 12 }, (_, index) => ({
            detail: 'd'.repeat(1000),
            evidence: Array.from({ length: 8 }, (_entry, line) => ({ line: line + 1, path: `src/${index}.ts` })),
            severity: 'note' as const,
            title: `Finding ${index}`,
          })),
        },
      },
    };
    const mediumView = projectDelegationJobView(medium, [], { now: LATER });
    expect(mediumView.truncation).toEqual(NO_CUT);
    expect(mediumView.result?.findings).toHaveLength(12);
  });

  test('keeps a scope of many long paths under the bound by omitting scope files, never the findings', () => {
    // 64 files with 943-character paths (components of at most 200 characters), as the engine admits
    // them (`maxScopePathCharacters`, `maxScopeFiles`): about 60 KiB of scope before any result.
    const component = (seed: string): string => `${seed}${'x'.repeat(200 - seed.length)}`;
    const longPath = (index: number): string => {
      const parts = [component(`dir${index}-a`), component('b'), component('c'), component('d')];
      return `${parts.join('/')}/${`f${index}`.padEnd(943 - parts.join('/').length - 1, 'y')}`;
    };
    const coverages = ['complete', 'partial', 'omitted', 'binary'] as const;
    const wide: DelegationJob = {
      ...job,
      request: {
        ...job.request,
        constraints: Array.from({ length: 12 }, (_, index) => `${index} ${'k'.repeat(200)}`),
        criteria: Array.from({ length: 12 }, (_, index) => `${index} ${'c'.repeat(200)}`),
      },
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
    };
    const view = projectDelegationJobView(wide, [], { now: LATER });
    expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeLessThanOrEqual(
      DELEGATION_BOUNDS.maxJobViewBytes,
    );
    expect(view.truncation.scopeFiles).toBeGreaterThan(0);
    expect(view.executedScope?.files.length).toBe(64 - view.truncation.scopeFiles);
    expect(view.executedScope?.fileCount).toBe(64);
    // The deliverable is kept: the scope file list goes before the findings.
    expect(view.truncation.findings).toBe(0);
    expect(view.result?.findings).toHaveLength(1);
    expect(view.notes.join(' ')).toContain('scope files');
    expect(plain(view)).toEqual(view);
  });

  test('stays under the bound with large evaluations: the oldest verifications go first, then older acceptances, never the operator acceptance', () => {
    const maximal = (
      index: number,
      kind: DelegationEvaluation['kind'] = 'verification',
      author: DelegationEvaluation['author'] = 'calling-model',
    ): DelegationEvaluation =>
      evaluation({
        author,
        authorLabel: 'l'.repeat(DELEGATION_JOB_BOUNDS.maxTextCharacters),
        checks: Array.from(
          { length: DELEGATION_BOUNDS.maxEvaluationChecks },
          (_, check) => `${check} ${'c'.repeat(DELEGATION_BOUNDS.maxEvaluationCheckCharacters - 3)}`,
        ),
        evaluationId: `${kind}-${author}-${String(index).padStart(2, '0')}`,
        kind,
        note: 'n'.repeat(DELEGATION_BOUNDS.maxEvaluationNoteCharacters),
        recordedAt: new Date(Date.parse(LATER) + index * 60_000).toISOString(),
        verdict: kind === 'verification' ? 'confirmed' : 'taken-over',
      });
    const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

    const twelve = Array.from({ length: 12 }, (_, index) => maximal(index));
    const view = projectDelegationJobView(job, twelve, { now: LATER });
    expect(bytes(view)).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxJobViewBytes);
    expect(view.truncation.evaluations).toBeGreaterThan(0);
    const kept = view.evaluations.verifications.map(({ evaluationId }) => evaluationId);
    expect(kept).toHaveLength(12 - view.truncation.evaluations);
    // The newest are listed, in order; the oldest were cut.
    expect(kept[0]).toBe('verification-calling-model-11');
    expect(kept.at(-1)).toBe(`verification-calling-model-${String(12 - kept.length).padStart(2, '0')}`);
    // The result, which the evaluations judge, is left whole; the status still reads the latest verdict.
    expect(view.truncation).toMatchObject({ evidence: 0, findings: 0, notReviewed: 0 });
    expect(view.result?.findings).toHaveLength(1);
    expect(view.status.verified).toBe('confirmed');
    expect(view.notes.join(' ')).toContain(`${view.truncation.evaluations} evaluations`);

    // The operator's acceptance is the oldest of all and still listed; model acceptances go oldest first,
    // and only once every verification is gone.
    const operator = maximal(-1, 'acceptance', 'operator');
    const modelAcceptances = Array.from({ length: 11 }, (_, index) => maximal(index, 'acceptance'));
    const crowded = projectDelegationJobView(job, [...twelve, operator, ...modelAcceptances], { now: LATER });
    expect(bytes(crowded)).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxJobViewBytes);
    expect(crowded.evaluations.acceptance?.evaluationId).toBe('acceptance-operator--1');
    expect(crowded.evaluations.acceptances.map(({ evaluationId }) => evaluationId)).toContain('acceptance-operator--1');
    expect(crowded.status.accepted).toBe('taken-over');
    const droppedAcceptances = 12 - crowded.evaluations.acceptances.length;
    expect(droppedAcceptances).toBeGreaterThan(0);
    expect(crowded.evaluations.verifications).toHaveLength(0);
    expect(crowded.truncation.evaluations).toBe(12 + droppedAcceptances);
    const listedModelAcceptances = crowded.evaluations.acceptances
      .map(({ evaluationId }) => evaluationId)
      .filter((id) => id !== 'acceptance-operator--1');
    expect(listedModelAcceptances[0]).toBe('acceptance-calling-model-10');
    expect(listedModelAcceptances).toEqual(
      Array.from(
        { length: listedModelAcceptances.length },
        (_, index) => `acceptance-calling-model-${String(10 - index).padStart(2, '0')}`,
      ),
    );
  });

  test('the maximal record fits: every list and text at its bound in three-byte characters, identifiers and the frozen scope whole, notes within 512 characters', () => {
    const heavy = maximalJob();
    const crowd = maximalCrowd();
    const view = projectDelegationJobView(heavy, crowd, { now: LATER });
    expect(bytesOf(view)).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxJobViewBytes);
    // Nothing that identifies the job, the route, the checkout or the reviewed revisions is cut.
    expect(view).toMatchObject({
      frozenScope: heavy.scope,
      jobId: JOB_ID,
      machineId: heavy.machineId,
      request: { checkoutPath: heavy.request.checkout.path, scope: heavy.request.scope },
      retryOf: RETRY_OF,
      route: { poolId: heavy.poolId, routeId: heavy.routeId },
      state: 'finished',
      status: { accepted: 'taken-over', executed: 'succeeded', verified: 'confirmed' },
    });
    expect(view.evaluations.acceptance?.evaluationId).toBe(crowd.at(-1)?.evaluationId ?? '');
    expect(view.evaluations.acceptances.map(({ evaluationId }) => evaluationId)).toEqual([
      crowd.at(-1)?.evaluationId ?? '',
    ]);
    // Every list went before the free texts, which are cut to well-formed prefixes and counted.
    expect(view.truncation).toMatchObject({
      automatedChecks: 20,
      constraints: 12,
      criteria: 12,
      evaluationChecks: 12,
      evaluations: 40,
      evidence: 0,
      findings: 50,
      guaranteeControls: 32,
      guaranteeLimits: 32,
      notReviewed: 50,
      rationale: 4,
      resultChecks: 20,
      resultLimits: 20,
      scopeFiles: 256,
    });
    expect(view.truncation.characters).toBeGreaterThan(0);
    expect(view.qualification?.omittedExcludedRoutes).toBe(32);
    expect(view.executedScope).toMatchObject({ fileCount: 256, files: [] });
    for (const text of [
      view.request.objective,
      view.failure,
      view.result?.summary,
      view.result?.excerpt,
      view.result?.coverage?.reviewed,
      view.evaluations.acceptance?.note,
    ]) {
      expect(typeof text).toBe('string');
      expect(text?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(LONE_SURROGATE.test(text ?? '')).toBe(false);
    }
    expect(view.notes.every((note) => note.length <= 512)).toBe(true);
    expect(view.notes.at(-1)).toContain('free-text characters');
    expect(plain(view)).toEqual(view);
  });

  test('cuts multibyte free texts without splitting a surrogate pair, and bounds a job without a result', () => {
    const emoji = '😀';
    const base = maximalJob();
    const wide: DelegationJob = {
      ...base,
      request: { ...base.request, objective: fill(DELEGATION_BOUNDS.maxObjectiveCharacters / 2, emoji) },
      result:
        base.result === null
          ? null
          : { ...base.result, excerpt: fill(DELEGATION_RESULT_BOUNDS.maxExcerptCharacters / 2, emoji) },
    };
    const view = projectDelegationJobView(wide, maximalCrowd(), { now: LATER });
    expect(bytesOf(view)).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxJobViewBytes);
    expect(view.truncation.characters).toBeGreaterThan(0);
    for (const text of [view.request.objective, view.result?.excerpt ?? '']) {
      expect(text.length).toBeGreaterThanOrEqual(2);
      expect(text.length % 2).toBe(0);
      expect(LONE_SURROGATE.test(text)).toBe(false);
      expect(wide.request.objective.startsWith(view.request.objective)).toBe(true);
    }
    expect(view.result?.findings).toEqual([]);
    // No result at all: the early path is bounded too, by cutting the lists that are there.
    const bare = projectDelegationJobView({ ...base, result: null }, [], { now: LATER });
    expect(bytesOf(bare)).toBeLessThanOrEqual(DELEGATION_BOUNDS.maxJobViewBytes);
    expect(bare.result).toBeNull();
    expect(bare.truncation.scopeFiles).toBeGreaterThan(0);
    expect(bare.executedScope?.fileCount).toBe(256);
    expect(bare.frozenScope).toEqual(base.scope);
  });
});

describe('summarizeDelegationJobView', () => {
  test('carries the identifiers, the state, the route, the short scope, the three facts and a bounded result digest', () => {
    const heavy: DelegationJob = {
      ...job,
      request: { ...job.request, scope: { commit: 'a'.repeat(40), kind: 'commit' } },
      result: {
        excerpt: null,
        kind: 'review',
        review: {
          ...review,
          findings: Array.from({ length: 50 }, (_, index) => ({
            detail: `${index} ${'d'.repeat(1990)}`,
            evidence: Array.from({ length: 8 }, (_entry, line) => ({ line: line + 1, path: `src/${'p'.repeat(400)}` })),
            severity: 'minor' as const,
            title: `Finding ${index}`,
          })),
          summary: 's'.repeat(400),
        },
      },
    };
    const view = projectDelegationJobView(heavy, [evaluation({ verdict: 'refuted' })], { now: LATER });
    expect(view.truncation.findings).toBeGreaterThan(0);
    const summary = summarizeDelegationJobView(view);
    expect(summary).toEqual({
      checkoutPath: '/home/fixture/work/project',
      endedAt: LATER,
      failure: null,
      // The whole result's count, not the trimmed view's.
      findingCount: 50,
      // The frozen scope travels whole: the list entry shortens only the requested revisions.
      frozenScope: {
        base: 'first-parent',
        baseRef: null,
        baseSha: 'b'.repeat(40),
        commitCount: 1,
        headRef: 'HEAD',
        headSha: 'a'.repeat(40),
        kind: 'commit',
      },
      jobId: JOB_ID,
      live: false,
      refusalReason: null,
      requestedAt: NOW,
      resultKind: 'review',
      route: {
        context: 'personal',
        harness: 'claude-code',
        modelRequested: 'claude-opus-4-1',
        modelResolved: 'claude-opus-4-1-20250805',
      },
      scope: { base: null, head: 'a'.repeat(12), kind: 'commit' },
      state: 'finished',
      status: { accepted: 'pending', executed: 'succeeded', verified: 'refuted' },
      summary: 's'.repeat(DELEGATION_JOB_SUMMARY_BOUNDS.maxTextCharacters),
    });
    // Fifty entries of this size, with their envelope, stay well under the MCP tool bound (192 KiB).
    expect(bytesOf(summary)).toBeLessThan(2048);
    expect(plain(summary)).toEqual(summary);

    // A range given by refs keeps the refs; a refused decision has no route and no result; a failure is cut.
    const refused = summarizeDelegationJobView(
      projectDelegationJobView(
        {
          ...job,
          failureReason: 'Pool machine-a/claude-code/personal runs 1 reserving job(s); the limit is 1.',
          refusalReason: 'pool-busy',
          request: { ...job.request, scope: { base: 'main', head: 'feat/lock', kind: 'range' } },
          result: null,
          routeId: null,
          startedAt: null,
          state: 'refused',
        },
        [],
        { now: LATER },
      ),
    );
    expect(refused).toMatchObject({
      failure: null,
      findingCount: null,
      refusalReason: 'pool-busy',
      resultKind: null,
      route: null,
      scope: { base: 'main', head: 'feat/lock', kind: 'range' },
      status: { executed: 'not-run' },
    });
    const failed = summarizeDelegationJobView(
      projectDelegationJobView(
        {
          ...job,
          failureReason: 'f'.repeat(900),
          result: { excerpt: 'partial', kind: 'error', review: null },
          state: 'failed',
        },
        [],
        { now: LATER },
      ),
    );
    expect(failed).toMatchObject({
      failure: 'f'.repeat(DELEGATION_JOB_SUMMARY_BOUNDS.maxTextCharacters),
      findingCount: null,
      resultKind: 'error',
      summary: null,
    });
  });

  test('fifty entries of a maximal ASCII record with a realistic checkout path stay under the MCP tool bound', () => {
    const ascii = maximalJob('x');
    const checkoutPath = `/${'p'.repeat(255)}`;
    const realistic: DelegationJob = {
      ...ascii,
      checkoutPath,
      request: { ...ascii.request, checkout: { path: checkoutPath } },
    };
    const summary = summarizeDelegationJobView(projectDelegationJobView(realistic, maximalCrowd('x'), { now: LATER }));
    expect(summary.frozenScope).toEqual(realistic.scope);
    expect(summary.scope).toEqual({ base: 'r'.repeat(256), head: 'h'.repeat(256), kind: 'range' });
    // The list answer wraps the entries in its envelope (notice, counts); one KiB covers it.
    expect(50 * bytesOf(summary) + 1024).toBeLessThanOrEqual(MCP_TOOL_OUTPUT_BYTES);
  });
});
