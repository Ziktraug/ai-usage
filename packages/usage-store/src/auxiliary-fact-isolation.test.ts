import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import type {
  CheckoutStatusObservation,
  JiraIssueObservation,
  PullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { NewDelegationJob } from './delegation-store';
import {
  queryDelegationEvaluations,
  queryDelegationJobs,
  queryLatestCheckoutStatusObservations,
  queryLatestExecutorObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryLocalMergeBundle,
  queryReviewAttempts,
  queryUsageStoreGeneration,
  queryWorkFactRunStates,
  readDelegationQualification,
} from './reader';
import type { NewReviewAttempt } from './review-attempt-store';
import {
  exportLocalMergeBundle,
  importCheckoutStatusObservations,
  importExecutorObservations,
  importJiraIssueObservations,
  importLocalRows,
  importPullRequestObservations,
  initializeUsageStore,
  publishServedReportRevision,
  recordDelegationEvaluation,
  recordDelegationQualification,
  recordWorkFactRun,
  requestDelegationJob,
  requestReviewAttempt,
  transitionDelegationJob,
  transitionReviewAttempt,
  updateUsageMachineLabel,
} from './writer';

/**
 * The Work view's auxiliary fact tables describe this machine only: pull requests, checkouts,
 * producer runs, executor observations, Jira issues (ADR 0054), review attempts (ADR 0053) and
 * delegation jobs, evaluations and qualifications (design 2026-10-25). This proves that none of
 * them leaks into what leaves it or what the report serves: the served revision, the merge bundle
 * (export and local read) and the replication outbox, and that writing them never moves the store
 * generation.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-aux-facts';
const SENTINELS = {
  authEvidence: 'PRIVATE_EXECUTOR_EVIDENCE_SENTINEL_117',
  authMethod: 'PRIVATE_AUTH_METHOD_SENTINEL',
  binaryPath: '/private/PRIVATE_EXECUTOR_PATH_SENTINEL/claude',
  checkoutPath: '/home/private/PRIVATE_CHECKOUT_PATH_SENTINEL',
  delegationCheckoutPath: '/home/private/PRIVATE_DELEGATION_CHECKOUT_SENTINEL',
  delegationEvaluationNote: 'PRIVATE_DELEGATION_EVALUATION_NOTE_SENTINEL',
  delegationExcerpt: 'PRIVATE_DELEGATION_EXCERPT_SENTINEL',
  delegationFailureReason: 'PRIVATE_DELEGATION_FAILURE_SENTINEL',
  delegationObjective: 'PRIVATE_DELEGATION_OBJECTIVE_SENTINEL',
  delegationQualificationAssumption: 'PRIVATE_DELEGATION_QUALIFICATION_SENTINEL',
  jiraComment: 'PRIVATE_JIRA_COMMENT_EXCERPT_SENTINEL',
  jiraOutcomeMessage: 'PRIVATE_JIRA_OUTCOME_SENTINEL',
  jiraSummary: 'PRIVATE_JIRA_SUMMARY_SENTINEL',
  outcomeMessage: 'PRIVATE_PR_OUTCOME_SENTINEL',
  pullRequestTitle: 'PRIVATE_PR_TITLE_SENTINEL',
  pullRequestUrl: 'https://github.example/PRIVATE_PR_URL_SENTINEL/pull/1',
  reviewCheckoutPath: '/home/private/PRIVATE_REVIEW_CHECKOUT_SENTINEL',
  reviewExcerpt: 'PRIVATE_REVIEW_EXCERPT_SENTINEL',
  reviewFailureReason: 'PRIVATE_REVIEW_FAILURE_SENTINEL',
  reviewSessionTitle: 'PRIVATE_REVIEW_TITLE_SENTINEL',
  runMessage: 'PRIVATE_RUN_MESSAGE_SENTINEL',
} as const;

const jiraIssue: JiraIssueObservation = {
  assigneeLabel: 'Alex',
  commentCount: 1,
  comments: [
    {
      authorLabel: 'Sam',
      createdAt: parseCanonicalInstant('2026-10-21T19:30:00.000Z'),
      excerpt: SENTINELS.jiraComment,
      id: '1',
    },
  ],
  key: 'PRV-1',
  machineId: MACHINE,
  observedAt: parseCanonicalInstant('2026-10-21T20:00:00.000Z'),
  outcome: 'observed',
  outcomeMessage: SENTINELS.jiraOutcomeMessage,
  parentKey: null,
  sprint: null,
  status: 'In Progress',
  statusCategory: 'in-progress',
  summary: SENTINELS.jiraSummary,
  updatedAt: parseCanonicalInstant('2026-10-21T19:30:00.000Z'),
};

const reviewAttempt: NewReviewAttempt = {
  attemptId: 'attempt-private-1',
  candidateId: `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`,
  declaration: null,
  executorHarness: 'claude-code',
  idempotencyKey: 'k'.repeat(64),
  machineId: MACHINE,
  requestedAt: '2026-10-21T20:00:00.000Z',
  reservation: {
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    maxConcurrent: 1,
    poolId: `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`,
  },
  state: 'requested',
  target: {
    checkoutOrigin: 'desktop-cwd',
    checkoutPath: SENTINELS.reviewCheckoutPath,
    desktopSessionId: 'local_private',
    harness: 'claude',
    projectLabel: 'project',
    sessionTitle: SENTINELS.reviewSessionTitle,
    sourceSessionId: 'cli-1',
  },
};

const DELEGATION_QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const delegationJob: NewDelegationJob = {
  accountScope: 'personal',
  action: 'read-only-review',
  checkoutPath: SENTINELS.delegationCheckoutPath,
  context: 'personal',
  effort: null,
  executorHarness: 'claude-code',
  idempotencyKey: 'private:session-1:review-1',
  jobId: 'job-private-1',
  machineId: MACHINE,
  modelRequested: null,
  poolId: `${MACHINE}/claude-code/personal`,
  qualification: {
    admissibleRouteIds: ['route-a'],
    appliedRules: [],
    assumptions: [SENTINELS.delegationQualificationAssumption],
    checkout: { admittedBy: '/home/private', path: SENTINELS.delegationCheckoutPath, projectLabel: 'project' },
    checkoutFacts: null,
    omittedRoutes: 0,
    outcome: 'routes-available',
    purpose: 'delegation',
    qualificationId: DELEGATION_QUALIFICATION_ID,
    qualifiedAt: '2026-10-21T20:00:00.000Z',
    refusal: null,
    request: { action: 'read-only-review', digest: 'd'.repeat(64), taskCategory: 'correctness' },
    routes: [],
    schemaVersion: 1,
    scope: null,
    validUntil: '2026-10-21T20:10:00.000Z',
    versions: {
      catalogRevision: 'cat0123456789abc',
      policyRevision: 'pol0123456789abc',
      qualifier: 'delegation-qualifier/1',
      selectorContract: 'delegation-selection/1',
    },
  },
  qualificationId: DELEGATION_QUALIFICATION_ID,
  request: {
    action: 'read-only-review',
    checkout: { path: SENTINELS.delegationCheckoutPath },
    constraints: [],
    criteria: [],
    objective: SENTINELS.delegationObjective,
    schemaVersion: 1,
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestDigest: 'd'.repeat(64),
  requestedAt: '2026-10-21T20:00:00.000Z',
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
    kind: 'choice',
    qualificationId: DELEGATION_QUALIFICATION_ID,
    routeId: 'route-a',
    selectorVersion: 'calling-model/claude-code',
  },
  selectionDigest: 's'.repeat(64),
  state: 'requested',
  taskCategory: 'correctness',
};

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-aux-isolation-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const pullRequest = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'main',
  checksRollup: 'success',
  draft: false,
  headRef: 'feat/private',
  host: 'github.example',
  machineId: MACHINE,
  mergedAt: null,
  number: 1,
  observedAt: parseCanonicalInstant('2026-10-21T20:00:00.000Z'),
  outcome: 'observed',
  outcomeMessage: SENTINELS.outcomeMessage,
  repository: 'private/project',
  reviewDecision: null,
  state: 'OPEN',
  title: SENTINELS.pullRequestTitle,
  updatedAt: parseCanonicalInstant('2026-10-21T19:00:00.000Z'),
  url: SENTINELS.pullRequestUrl,
  ...overrides,
});

const checkout: CheckoutStatusObservation = {
  ahead: 0,
  behind: 0,
  branch: 'feat/private',
  checkoutPath: SENTINELS.checkoutPath,
  dirty: true,
  headSha: 'c'.repeat(40),
  lastCommitAt: parseCanonicalInstant('2026-10-21T18:00:00.000Z'),
  machineId: MACHINE,
  modifiedCount: 3,
  observedAt: parseCanonicalInstant('2026-10-21T20:00:00.000Z'),
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 1,
  upstream: null,
};

const executor: ExecutorObservation = {
  authEvidence: SENTINELS.authEvidence,
  authMethod: SENTINELS.authMethod,
  authState: 'logged-in',
  binaryPath: SENTINELS.binaryPath,
  harness: 'claude-code',
  machineId: MACHINE,
  observedAt: '2026-10-21T20:00:00.000Z',
  outcome: 'observed',
  version: '2.1.303 (Claude Code)',
};

const servedRow = (machineLabel: string): SerializedRow => ({
  activeDate: '2026-10-20T08:01:00.000Z',
  calls: 1,
  costActual: 0.1,
  costApprox: 0.1,
  costKnown: true,
  costQuota: 0,
  date: '2026-10-20T08:00:00.000Z',
  durationMs: 1000,
  endDate: '2026-10-20T08:01:00.000Z',
  freshTokens: 30,
  harness: 'Claude Code',
  lineDelta: 0,
  linesAdded: 0,
  linesDeleted: 0,
  model: 'claude-fixture',
  name: 'Served session',
  project: 'project',
  provider: 'Claude sub',
  sessionLabel: 'Served session',
  source: {
    harnessKey: 'claude',
    machineId: MACHINE,
    machineLabel,
    rootSourceSessionId: 'cli-1',
    sourceSessionId: 'cli-1',
  },
  tokCr: 0,
  tokCw: 0,
  tokIn: 10,
  tokOut: 20,
  tokenTotal: 30,
  tools: 0,
  turns: 1,
});

const support = (machineLabel: string): FocusedReportSupport => ({
  analytics: {
    averageDurationMs: null,
    byHarness: [],
    byModel: [],
    byProvider: [],
    costPer100Lines: null,
    durationMs: 0,
    durationRows: 0,
    lineCount: 0,
    linesA: 0,
    linesD: 0,
    meanCost: 0,
    medianCost: 0,
    pricedCount: 0,
    recentSessions: 0,
    sessionCount: 1,
    tools: 0,
    totalCost: 0,
    turns: 0,
    unpricedCount: 0,
  },
  filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt: '2026-10-21T21:10:00.000Z',
  machineFreshness: {
    kind: 'available',
    machines: [{ id: MACHINE, label: machineLabel, lastSeenAt: '2026-10-21T21:10:00.000Z' }],
    observedAt: '2026-10-21T21:10:00.000Z',
    omittedMachines: 0,
    skippedRows: 0,
  },
  omittedRows: 0,
  timeZone: 'UTC',
});

describe('auxiliary fact tables stay local', () => {
  test('pull request, checkout, run state, executor, Jira issue, review attempt and delegation rows never reach the served revision, the bundle or the outbox', async () => {
    const dbPath = await createStore();
    const machine = { id: MACHINE, label: 'Aux Machine' };
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [
          {
            ...normalizeUsageRow({
              calls: 1,
              cost: actualCost(null),
              date: new Date('2026-10-20T08:00:00.000Z'),
              durationMs: 1000,
              endDate: new Date('2026-10-20T08:01:00.000Z'),
              harness: 'Claude Code',
              model: 'claude-fixture',
              name: 'Served session',
              project: 'project',
              provider: 'Claude sub',
              tokens: { cr: 0, cw: 0, in: 10, out: 20 },
            }),
            source: { harnessKey: 'claude', sourcePath: '/home/fixture/work/project', sourceSessionId: 'cli-1' },
          },
        ],
      }),
    );
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    await Effect.runPromise(importPullRequestObservations({ dbPath, observations: [pullRequest()] }));
    await Effect.runPromise(importCheckoutStatusObservations({ dbPath, observations: [checkout] }));
    await Effect.runPromise(
      recordWorkFactRun({
        dbPath,
        disabled: false,
        failed: 0,
        machineId: MACHINE,
        message: SENTINELS.runMessage,
        observed: 1,
        ranAt: new Date('2026-10-21T20:00:00.000Z'),
        sourceId: 'github.pull-requests',
      }),
    );
    await Effect.runPromise(importExecutorObservations({ dbPath, observations: [executor] }));
    await Effect.runPromise(importJiraIssueObservations({ dbPath, observations: [jiraIssue] }));
    await Effect.runPromise(requestReviewAttempt({ attempt: reviewAttempt, dbPath }));
    await Effect.runPromise(
      transitionReviewAttempt({
        at: '2026-10-21T20:05:00.000Z',
        attemptId: reviewAttempt.attemptId ?? '',
        dbPath,
        patch: {
          endedAt: '2026-10-21T20:05:00.000Z',
          failureReason: SENTINELS.reviewFailureReason,
          resultExcerpt: SENTINELS.reviewExcerpt,
          resultKind: 'error',
          state: 'failed',
        },
      }),
    );
    if (delegationJob.qualification === null) {
      throw new Error('fixture');
    }
    await Effect.runPromise(
      recordDelegationQualification({
        dbPath,
        machineId: MACHINE,
        purpose: 'delegation',
        qualification: delegationJob.qualification,
        requestDigest: delegationJob.requestDigest,
      }),
    );
    await Effect.runPromise(
      requestDelegationJob({ dbPath, job: delegationJob, limits: { maxAttempts: 2, maxConcurrent: 1 } }),
    );
    await Effect.runPromise(
      transitionDelegationJob({
        at: '2026-10-21T20:05:00.000Z',
        dbPath,
        jobId: 'job-private-1',
        patch: {
          endedAt: '2026-10-21T20:05:00.000Z',
          failureReason: SENTINELS.delegationFailureReason,
          result: { excerpt: SENTINELS.delegationExcerpt, kind: 'unstructured', review: null },
          state: 'finished',
        },
      }),
    );
    await Effect.runPromise(
      recordDelegationEvaluation({
        dbPath,
        evaluation: {
          author: 'calling-model',
          authorLabel: 'claude-code',
          checks: [],
          evaluationId: 'evaluation-private-1',
          jobId: 'job-private-1',
          kind: 'verification',
          note: SENTINELS.delegationEvaluationNote,
          recordedAt: '2026-10-21T20:06:00.000Z',
          verdict: 'inconclusive',
        },
      }),
    );
    // The auxiliary tables hold the rows, with their private text, for the local Work view.
    expect((await Effect.runPromise(queryDelegationJobs({ dbPath, machineId: MACHINE }))).jobs[0]).toMatchObject({
      checkoutPath: SENTINELS.delegationCheckoutPath,
      failureReason: SENTINELS.delegationFailureReason,
      request: { objective: SENTINELS.delegationObjective },
      result: { excerpt: SENTINELS.delegationExcerpt },
      state: 'finished',
    });
    expect(
      (await Effect.runPromise(queryDelegationEvaluations({ dbPath, jobIds: ['job-private-1'] }))).evaluations[0]?.note,
    ).toBe(SENTINELS.delegationEvaluationNote);
    expect(
      (
        await Effect.runPromise(
          readDelegationQualification({ dbPath, machineId: MACHINE, qualificationId: DELEGATION_QUALIFICATION_ID }),
        )
      ).record?.qualification.assumptions,
    ).toEqual([SENTINELS.delegationQualificationAssumption]);
    expect(
      (
        await Effect.runPromise(
          queryLatestJiraIssueObservations({ dbPath, keys: ['PRV-1'], limit: 10, machineId: MACHINE }),
        )
      ).items[0]?.latest,
    ).toMatchObject({ comments: [{ excerpt: SENTINELS.jiraComment }], summary: SENTINELS.jiraSummary });
    expect((await Effect.runPromise(queryReviewAttempts({ dbPath, machineId: MACHINE }))).attempts[0]).toMatchObject({
      failureReason: SENTINELS.reviewFailureReason,
      resultExcerpt: SENTINELS.reviewExcerpt,
      state: 'failed',
      target: { checkoutPath: SENTINELS.reviewCheckoutPath, sessionTitle: SENTINELS.reviewSessionTitle },
    });
    expect(
      (await Effect.runPromise(queryLatestPullRequestObservations({ dbPath, machineId: MACHINE }))).items[0]?.latest
        .title,
    ).toBe(SENTINELS.pullRequestTitle);
    expect(
      (await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath, machineId: MACHINE }))).items[0]?.latest
        .checkoutPath,
    ).toBe(SENTINELS.checkoutPath);
    expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath }))).runs[0]?.message).toBe(SENTINELS.runMessage);
    expect(
      (await Effect.runPromise(queryLatestExecutorObservations({ dbPath, machineId: MACHINE }))).observations[0]
        ?.authMethod,
    ).toBe(SENTINELS.authMethod);
    // None of those imports is report data: the generation that drives publication did not move.
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toEqual(generationBefore);

    await Effect.runPromise(
      publishServedReportRevision({
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: support(machine.label).generatedAt,
          projectAliases: [],
          projectGroupConfigs: [],
          rows: [servedRow(machine.label)],
          sourceAuthorities: ['local-observed'],
          support: support(machine.label),
        }),
        dbPath,
        now: 1000,
        revision: 'revision-aux',
        ttlMs: 300_000,
      }),
    );

    const db = new Database(dbPath, { readonly: true });
    const served = db.query('SELECT row_json, source_row_json, search_text FROM served_report_rows').all();
    const servedSupport = db.query('SELECT support_json FROM served_report_support').all();
    const outbox = db.query('SELECT COUNT(*) AS count FROM replication_outbox_events').get() as { count: number };
    const usageRows = db.query('SELECT row_json FROM usage_rows').all();
    db.close(true);
    const exported = await Effect.runPromise(exportLocalMergeBundle({ dbPath, machine }));
    const local = await Effect.runPromise(queryLocalMergeBundle({ dbPath }));

    expect(served).toHaveLength(1);
    expect(exported.rows).toHaveLength(1);
    expect(local.rows).toHaveLength(1);
    expect(outbox.count).toBe(0);
    for (const payload of [served, servedSupport, usageRows, exported, local]) {
      const text = JSON.stringify(payload);
      for (const sentinel of Object.values(SENTINELS)) {
        expect(text).not.toContain(sentinel);
      }
    }
  });
});
