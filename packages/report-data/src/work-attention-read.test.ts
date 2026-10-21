import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  type CheckoutStatusObservation,
  type ClaudeDesktopSessionObservation,
  type PullRequestObservation,
  parseClaudeDesktopSessionObservation,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { type UsageStoreError, usageStoreErrorReasonFrom, type WorkFactRunState } from '@ai-usage/usage-store/reader';
import {
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  importPullRequestObservations,
  initializeUsageStore,
  publishServedReportRevision,
  recordWorkFactRun,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import {
  assembleWorkAttention,
  NO_EXTERNAL_FACTS,
  NO_SERVED_REVISION,
  queryWorkAttention,
  type WorkAttentionExternalFacts,
} from './work-attention-read';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-work';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const hoursAgo = (hours: number) => canonicalInstantFromDate(new Date(NOW.getTime() - hours * 3_600_000));

interface SessionSpec {
  readonly cliSessionId?: string;
  readonly id: string;
  readonly lastActivityHoursAgo: number;
  readonly needsAction?: string;
  readonly openSuggestions?: number;
  readonly pullRequestState?: 'MERGED' | 'OPEN';
  readonly resolvedSuggestions?: Record<string, 'dismissed' | 'started_notified'>;
  readonly spawnedFromId?: string;
  readonly status?: 'blocked' | 'completed' | 'review_ready';
  readonly title: string;
  readonly unsupported?: boolean;
  readonly worktree?: boolean;
}

const session = (spec: SessionSpec): ClaudeDesktopSessionObservation => {
  const lastActivityAt = hoursAgo(spec.lastActivityHoursAgo);
  const parsed = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account',
    archived: false,
    branch: spec.worktree ? 'fixture/worktree' : null,
    cliSessionId: spec.cliSessionId ?? `cli-${spec.id}`,
    completedTurns: 2,
    createdAt: hoursAgo(spec.lastActivityHoursAgo + 2),
    cwd: spec.worktree ? '/home/fixture/work/project/.claude/worktrees/wt-1' : '/home/fixture/work/project',
    declaredPullRequests:
      spec.pullRequestState === undefined
        ? []
        : [
            {
              baseRef: 'main',
              branch: 'fixture/pr',
              host: 'github.com',
              number: 117,
              own: true,
              repository: 'fixture/project',
              state: spec.pullRequestState,
              url: 'https://github.com/fixture/project/pull/117',
            },
          ],
    desktopSessionId: `local_${spec.id}`,
    effort: null,
    fileModifiedAt: lastActivityAt,
    filePath: `.config/Claude/claude-code-sessions/account/org/local_${spec.id}.json`,
    format: spec.unsupported ? 'unsupported' : 'claude-desktop-session-v1',
    lastActivityAt,
    lastTurnReport: spec.status === 'blocked' ? 'Report.' : null,
    machineId: MACHINE,
    model: null,
    observedAt: NOW.toISOString(),
    openSuggestions: Array.from({ length: spec.openSuggestions ?? 0 }, (_value, index) => ({
      createdAt: null,
      expiresAt: null,
      id: `task_${spec.id}_${index}`,
      title: `Proposal ${index}`,
      tldr: null,
    })),
    organizationDirectory: 'org',
    originCwd: '/home/fixture/work/project',
    priorCliSessionIds: [],
    resolvedSuggestions: spec.resolvedSuggestions ?? {},
    sideSessionNotes: [],
    sourceBranch: null,
    spawnedFrom:
      spec.spawnedFromId === undefined
        ? null
        : { sessionId: spec.spawnedFromId, sideSession: true, taskId: null, title: 'spawn' },
    title: spec.title,
    titleSource: 'auto',
    turnSummary:
      spec.unsupported || spec.status === undefined
        ? null
        : {
            detail: `Declared ${spec.status}.`,
            needsAction: spec.needsAction ?? null,
            status: spec.status,
            summarizesUuid: null,
          },
    unsupportedReason: spec.unsupported ? 'Unsupported field shape: prs.' : null,
    worktreePath: spec.worktree ? '/home/fixture/work/project/.claude/worktrees/wt-1' : null,
    wrapUpDescription: spec.status === 'blocked' ? 'Wrap-up.' : null,
    writtenBranches: spec.pullRequestState === undefined ? [] : ['fixture/pr'],
  });
  if (parsed === null) {
    throw new Error(`fixture session ${spec.id} must satisfy the contract`);
  }
  return parsed;
};

const sessions: readonly ClaudeDesktopSessionObservation[] = [
  session({
    id: 'a',
    lastActivityHoursAgo: 5,
    needsAction: 'Open the pull request for the collector branch.',
    status: 'blocked',
    title: 'Fixture: A asks for a pull request',
    worktree: true,
  }),
  session({
    id: 'a1',
    lastActivityHoursAgo: 3,
    pullRequestState: 'OPEN',
    spawnedFromId: 'local_a',
    status: 'completed',
    title: 'Fixture: A child opened it',
  }),
  session({ id: 'a2', lastActivityHoursAgo: 4, spawnedFromId: 'local_a', status: 'review_ready', title: 'Enquête' }),
  // A grandchild: spawned from a child, folded under the same root.
  session({
    id: 'a3',
    lastActivityHoursAgo: 2.5,
    spawnedFromId: 'local_a1',
    status: 'completed',
    title: 'Fixture: A grandchild',
  }),
  session({
    cliSessionId: 'cli-served',
    id: 'b',
    lastActivityHoursAgo: 2,
    needsAction: 'Decide the layout.',
    status: 'blocked',
    title: 'Fixture: B asks a question',
  }),
  session({
    id: 'c',
    lastActivityHoursAgo: 6,
    openSuggestions: 1,
    resolvedSuggestions: { task_old: 'dismissed' },
    status: 'completed',
    title: 'Fixture: C has a proposal',
  }),
  session({ id: 'd', lastActivityHoursAgo: 7, title: 'Fixture: D unsupported', unsupported: true }),
  session({
    id: 'e',
    lastActivityHoursAgo: 8,
    spawnedFromId: 'local_missing-parent',
    status: 'review_ready',
    title: 'Fixture: E orphan',
  }),
  session({ id: 'f', lastActivityHoursAgo: 45 * 24, status: 'completed', title: 'Fixture: F outside the window' }),
  session({ id: 'g', lastActivityHoursAgo: 1, status: 'review_ready', title: 'Fixture: G review ready' }),
];

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-attention-read-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(
    importClaudeDesktopSessions({
      collectedAt: new Date('2026-10-20T11:59:00.000Z'),
      completeness: { filesParsed: 9, filesSeen: 10, rejected: 0, truncated: false, unsupported: 1 },
      dbPath,
      machineId: MACHINE,
      observations: sessions,
    }),
  );
  return dbPath;
};

const publishServedSession = async (dbPath: string): Promise<void> => {
  const machine = { id: MACHINE, label: 'Work Machine' };
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
  const row: SerializedRow = {
    activeDate: '2026-10-20T10:01:00.000Z',
    calls: 1,
    costActual: 0.1,
    costApprox: 0.1,
    costKnown: true,
    costQuota: 0,
    date: '2026-10-20T10:00:00.000Z',
    durationMs: 1000,
    endDate: '2026-10-20T10:01:00.000Z',
    freshTokens: 30,
    harness: 'Claude Code',
    lineDelta: 0,
    linesAdded: 0,
    linesDeleted: 0,
    model: 'claude-fixture',
    name: 'Served session',
    project: 'Served project',
    provider: 'Claude sub',
    sessionLabel: 'Served session',
    source: {
      harnessKey: 'claude',
      machineId: MACHINE,
      machineLabel: machine.label,
      rootSourceSessionId: 'cli-served',
      sourceSessionId: 'cli-served',
    },
    tokCr: 0,
    tokCw: 0,
    tokIn: 10,
    tokOut: 20,
    tokenTotal: 30,
    tools: 0,
    turns: 1,
  };
  const support: FocusedReportSupport = {
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
    generatedAt: '2026-10-20T11:00:00.000Z',
    machineFreshness: {
      kind: 'available',
      machines: [{ id: MACHINE, label: machine.label, lastSeenAt: '2026-10-20T11:00:00.000Z' }],
      observedAt: '2026-10-20T11:00:00.000Z',
      omittedMachines: 0,
      skippedRows: 0,
    },
    omittedRows: 0,
    timeZone: 'UTC',
  };
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: support.generatedAt,
        projectAliases: [],
        projectGroupConfigs: [],
        rows: [row],
        sourceAuthorities: ['local-observed'],
        support,
      }),
      dbPath,
      now: 1000,
      revision: 'revision-work',
      ttlMs: 300_000,
    }),
  );
};

const failureReason = async (effect: Effect.Effect<unknown, UsageStoreError>): Promise<string | undefined> => {
  const result = await Effect.runPromise(Effect.either(effect));
  return result._tag === 'Left' ? usageStoreErrorReasonFrom(result.left) : undefined;
};

describe('queryWorkAttention', () => {
  test('folds children, joins the served Session, interprets and ranks the roots', async () => {
    const dbPath = await createStore();
    await publishServedSession(dbPath);

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: MACHINE, now: NOW }));

    expect(dataset.generatedAt).toBe(canonicalInstantFromDate(NOW));
    expect(dataset.machineId).toBe(MACHINE);
    expect(dataset.totalRoots).toBe(6);
    expect(dataset.truncated).toBe(false);
    // Ranking: human requests by declaration recency, then the optional lead, then the rest by activity.
    expect(dataset.roots.map((root) => [root.desktopSessionId, root.attention])).toEqual([
      ['local_g', 'human-request'],
      ['local_b', 'human-request'],
      ['local_e', 'human-request'],
      ['local_c', 'optional-lead'],
      ['local_a', 'none'],
      ['local_d', 'none'],
    ]);
    const byId = new Map(dataset.roots.map((root) => [root.desktopSessionId, root]));

    const a = byId.get('local_a');
    expect(a?.children).toEqual({
      blocked: 0,
      completed: 2,
      count: 3,
      reviewReady: 1,
      // Most recently active first, the order the family was read in.
      titles: ['Fixture: A grandchild', 'Fixture: A child opened it', 'Enquête'],
    });
    expect(a?.declared).toEqual({
      at: hoursAgo(5),
      detail: 'Declared blocked.',
      needsAction: 'Open the pull request for the collector branch.',
      status: 'blocked',
    });
    // The revision is published and carries no row for A's transcript: that gap is named, not hidden.
    expect(a?.interpretations.map(({ kind }) => kind)).toEqual(['request-satisfied-elsewhere', 'coverage-gap']);
    expect(a?.interpretations[0]?.evidence).toEqual(['local_a1:pr:github.com/fixture/project#117']);
    expect(a?.facts.map(({ kind }) => kind)).toEqual([
      'declared-turn',
      'wrap-up',
      'turn-report',
      'declared-pull-request',
    ]);
    expect(a?.project).toEqual({
      branch: 'fixture/worktree',
      checkoutPath: '/home/fixture/work/project/.claude/worktrees/wt-1',
      label: 'wt-1',
      worktreeName: 'wt-1',
    });
    expect(a?.session).toBeNull();
    expect(a?.key).toEqual({ harness: 'claude', machineId: MACHINE, sourceSessionId: 'cli-a' });
    expect(a?.age).toEqual({
      createdAt: hoursAgo(7),
      declaredAt: hoursAgo(5),
      lastActivityAt: hoursAgo(5),
      lastObservedAt: hoursAgo(5),
    });

    const b = byId.get('local_b');
    expect(b?.session?.rowId).toEqual(expect.any(String));
    expect(b?.project.label).toBe('Served project');
    expect(b?.interpretations.map(({ kind }) => kind)).toEqual(['request-open']);

    const c = byId.get('local_c');
    expect(c?.interpretations.map(({ kind }) => kind)).toEqual(['proposal-open', 'proposal-resolved', 'coverage-gap']);
    expect(
      c?.facts.filter(({ kind }) => kind === 'proposal').map((fact) => fact.kind === 'proposal' && fact.resolution),
    ).toEqual(['open', 'dismissed']);

    const d = byId.get('local_d');
    expect(d?.declared).toBeNull();
    expect(d?.interpretations.map(({ kind, text }) => [kind, text.slice(0, 24)])).toEqual([
      ['coverage-gap', 'The Desktop registry fil'],
      ['coverage-gap', 'No collected Session mat'],
    ]);

    const e = byId.get('local_e');
    expect(e?.facts.some(({ kind }) => kind === 'spawned-from')).toBe(true);
    expect(e?.interpretations.map(({ kind }) => kind)).toEqual(['review-ready', 'coverage-gap', 'coverage-gap']);

    expect(byId.has('local_f')).toBe(false);
    expect(dataset.coverage).toEqual({
      checkouts: { failed: 0, lastRunAt: null, observed: 0 },
      desktopSessions: {
        collectedAt: canonicalInstantFromDate(new Date('2026-10-20T11:59:00.000Z')),
        filesParsed: 9,
        filesSeen: 10,
        refusedRows: 0,
        truncated: false,
        unsupported: 1,
      },
      // No producer has run: no date, zero counts, and not disabled (only a run can say so).
      pullRequests: { disabled: false, failed: 0, lastRunAt: null, observed: 0 },
      sessions: { joined: 1, revision: 'revision-work', unmatched: 5 },
    });
  });

  test('reads the facts the family declared from the store, with the producers’ run states', async () => {
    const dbPath = await createStore();
    await Effect.runPromise(
      importPullRequestObservations({
        dbPath,
        observations: [
          pullRequestObservation({ observedAt: hoursAgo(2), reviewDecision: null }),
          // Declared by nobody in the registry: never looked up, never attached.
          pullRequestObservation({ number: 555, observedAt: hoursAgo(1), url: null }),
        ],
      }),
    );
    await Effect.runPromise(
      importCheckoutStatusObservations({
        dbPath,
        observations: [checkoutObservation({ checkoutPath: WORKTREE_PATH, observedAt: hoursAgo(0.5) })],
      }),
    );
    await Effect.runPromise(
      recordWorkFactRun({ ...runInput('github.pull-requests', { failed: 1, observed: 2 }), dbPath }),
    );
    await Effect.runPromise(recordWorkFactRun({ ...runInput('checkouts.status', { failed: 0, observed: 1 }), dbPath }));

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: MACHINE, now: NOW }));
    const a = dataset.roots.find((root) => root.desktopSessionId === 'local_a');
    expect(a?.attention).toBe('external-wait');
    expect(a?.facts.map(({ kind }) => kind)).toEqual([
      'declared-turn',
      'wrap-up',
      'turn-report',
      'declared-pull-request',
      'pull-request',
      'checkout-status',
    ]);
    expect(a?.interpretations.map(({ kind }) => kind)).toEqual([
      'request-satisfied-elsewhere',
      'external-review-pending',
      'local-changes-unvalidated',
    ]);
    const others = dataset.roots.filter((root) => root.desktopSessionId !== 'local_a');
    expect(others.flatMap((root) => root.facts).some(({ kind }) => kind === 'pull-request')).toBe(false);
    expect(JSON.stringify(dataset)).not.toContain('#555');
    expect(dataset.coverage.pullRequests).toEqual({
      disabled: false,
      failed: 1,
      lastRunAt: hoursAgo(0.25),
      observed: 2,
    });
    expect(dataset.coverage.checkouts).toEqual({ failed: 0, lastRunAt: hoursAgo(0.25), observed: 1 });
  });

  test('without a served revision the join is reported as unavailable, not as a gap per root', async () => {
    const dbPath = await createStore();
    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, now: NOW, sinceDays: 60 }));

    expect(dataset.machineId).toBeNull();
    expect(dataset.totalRoots).toBe(7);
    expect(dataset.coverage.sessions).toEqual({ joined: 0, revision: null, unmatched: 0 });
    expect(dataset.roots.every((root) => root.session === null)).toBe(true);
    expect(dataset.roots.find((root) => root.desktopSessionId === 'local_b')?.project.label).toBe('project');
    expect(
      dataset.roots.flatMap((root) => root.interpretations).some(({ text }) => text.includes('No collected Session')),
    ).toBe(false);
    const f = dataset.roots.find((root) => root.desktopSessionId === 'local_f');
    expect(f?.interpretations.map(({ kind }) => kind)).toEqual(['declared-status-stale']);
  });

  test('truncates to the limit and reports the total, and refuses invalid bounds', async () => {
    const dbPath = await createStore();
    const page = await Effect.runPromise(queryWorkAttention({ dbPath, limit: 2, machineId: MACHINE, now: NOW }));
    expect(page.roots.map((root) => root.desktopSessionId)).toEqual(['local_g', 'local_b']);
    expect(page.totalRoots).toBe(6);
    expect(page.truncated).toBe(true);

    expect(await failureReason(queryWorkAttention({ dbPath, limit: 0 }))).toBe('invalid-input');
    expect(await failureReason(queryWorkAttention({ dbPath, limit: 201 }))).toBe('invalid-input');
    expect(await failureReason(queryWorkAttention({ dbPath, sinceDays: 0 }))).toBe('invalid-input');
  });
});

const PROJECT_PATH = '/home/fixture/work/project';
const WORKTREE_PATH = '/home/fixture/work/project/.claude/worktrees/wt-1';

const pullRequestObservation = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'main',
  checksRollup: 'success',
  draft: false,
  headRef: 'fixture/pr',
  host: 'github.com',
  machineId: MACHINE,
  mergedAt: null,
  number: 117,
  observedAt: hoursAgo(1),
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'fixture/project',
  reviewDecision: null,
  state: 'OPEN',
  title: 'Fixture pull request',
  updatedAt: hoursAgo(2.5),
  url: 'https://github.com/fixture/project/pull/117',
  ...overrides,
});

const failedPullRequestObservation = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation =>
  pullRequestObservation({
    baseRef: null,
    checksRollup: null,
    draft: null,
    headRef: null,
    outcome: 'unauthenticated',
    outcomeMessage: 'gh exited 4',
    reviewDecision: null,
    state: null,
    title: null,
    updatedAt: null,
    url: null,
    ...overrides,
  });

const checkoutObservation = (overrides: Partial<CheckoutStatusObservation> = {}): CheckoutStatusObservation => ({
  ahead: 1,
  behind: 0,
  branch: 'fixture/worktree',
  checkoutPath: PROJECT_PATH,
  dirty: true,
  headSha: 'a'.repeat(40),
  lastCommitAt: hoursAgo(20),
  machineId: MACHINE,
  modifiedCount: 2,
  observedAt: hoursAgo(0.5),
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 1,
  upstream: null,
  ...overrides,
});

const runState = (
  sourceId: WorkFactRunState['sourceId'],
  overrides: Partial<Omit<WorkFactRunState, 'sourceId'>> = {},
): WorkFactRunState => ({
  disabled: false,
  failed: 0,
  machineId: MACHINE,
  message: null,
  observed: 1,
  ranAt: hoursAgo(0.25),
  sourceId,
  ...overrides,
});

const runInput = (sourceId: WorkFactRunState['sourceId'], counts: { failed: number; observed: number }) => ({
  disabled: false,
  machineId: MACHINE,
  message: null,
  ranAt: hoursAgo(0.25),
  sourceId,
  ...counts,
});

const assemble = (externalFacts: WorkAttentionExternalFacts, observations = sessions) =>
  assembleWorkAttention({
    collectionStates: [],
    externalFacts,
    machineId: MACHINE,
    now: NOW,
    observations,
    sessions: NO_SERVED_REVISION,
  });

const rootOf = (dataset: ReturnType<typeof assemble>, desktopSessionId: string) => {
  const root = dataset.roots.find((candidate) => candidate.desktopSessionId === desktopSessionId);
  if (root === undefined) {
    throw new Error(`expected root ${desktopSessionId}`);
  }
  return root;
};

describe('assembleWorkAttention with external facts', () => {
  test('attaches a pull request only to the roots whose family declared it, never by branch', () => {
    const observed = pullRequestObservation();
    const dataset = assemble({
      ...NO_EXTERNAL_FACTS,
      pullRequests: [
        { latest: observed, latestObserved: observed },
        // Same head branch as the declared pull request, another number: declared by nobody.
        { latest: pullRequestObservation({ number: 118 }), latestObserved: pullRequestObservation({ number: 118 }) },
        // The declared number on another repository: not the same pull request.
        {
          latest: pullRequestObservation({ repository: 'other/project' }),
          latestObserved: pullRequestObservation({ repository: 'other/project' }),
        },
        // The declared pull request as another machine observed it: another observer, not attached.
        {
          latest: pullRequestObservation({ machineId: 'machine-elsewhere' }),
          latestObserved: pullRequestObservation({ machineId: 'machine-elsewhere' }),
        },
      ],
    });
    const a = rootOf(dataset, 'local_a');
    const pullRequests = a.facts.filter((fact) => fact.kind === 'pull-request');
    expect(pullRequests).toEqual([
      {
        accountLabel: null,
        checksRollup: 'success',
        draft: false,
        host: 'github.com',
        id: `local_a:gh:github.com/fixture/project#117@${hoursAgo(1)}`,
        kind: 'pull-request',
        number: 117,
        outcome: 'observed',
        provenance: { coverage: 'complete', machineId: MACHINE, observedAt: hoursAgo(1), source: 'github' },
        repository: 'fixture/project',
        reviewDecision: null,
        state: 'OPEN',
        updatedAt: hoursAgo(2.5),
        url: 'https://github.com/fixture/project/pull/117',
      },
    ]);
    // The request was satisfied by the child's declaration; GitHub now shows it awaiting review.
    expect(a.attention).toBe('external-wait');
    expect(a.interpretations.map(({ kind }) => kind)).toEqual([
      'request-satisfied-elsewhere',
      'external-review-pending',
    ]);
    for (const root of dataset.roots.filter((candidate) => candidate.desktopSessionId !== 'local_a')) {
      expect(root.facts.some((fact) => fact.kind === 'pull-request')).toBe(false);
    }
  });

  test('a draft pull request, or an approved one, is not an external wait', () => {
    const draft = pullRequestObservation({ draft: true });
    expect(
      rootOf(assemble({ ...NO_EXTERNAL_FACTS, pullRequests: [{ latest: draft, latestObserved: draft }] }), 'local_a'),
    ).toMatchObject({ attention: 'none' });
    const approved = pullRequestObservation({ reviewDecision: 'APPROVED' });
    const a = rootOf(
      assemble({ ...NO_EXTERNAL_FACTS, pullRequests: [{ latest: approved, latestObserved: approved }] }),
      'local_a',
    );
    expect(a.attention).toBe('none');
    expect(a.interpretations.map(({ kind }) => kind)).toEqual(['request-satisfied-elsewhere']);
  });

  test('a human request outranks an external wait; an external wait outranks an optional lead', () => {
    // B asked a question and has no pull request; C has a proposal and declares no pull request.
    const withPullRequest = (id: string) =>
      session({
        id,
        lastActivityHoursAgo: 1,
        ...(id === 'q' ? { needsAction: 'Decide the layout.' } : {}),
        openSuggestions: id === 'p' ? 1 : 0,
        pullRequestState: 'OPEN',
        status: id === 'q' ? 'blocked' : 'completed',
        title: `Fixture: ${id}`,
      });
    const observed = pullRequestObservation();
    const dataset = assemble({ ...NO_EXTERNAL_FACTS, pullRequests: [{ latest: observed, latestObserved: observed }] }, [
      withPullRequest('q'),
      withPullRequest('p'),
    ]);
    expect(dataset.roots.map((root) => [root.desktopSessionId, root.attention])).toEqual([
      ['local_q', 'human-request'],
      ['local_p', 'external-wait'],
    ]);
    expect(rootOf(dataset, 'local_q').interpretations.map(({ kind }) => kind)).toEqual([
      'request-open',
      'external-review-pending',
    ]);
    expect(rootOf(dataset, 'local_p').interpretations.map(({ kind }) => kind)).toEqual([
      'external-review-pending',
      'proposal-open',
    ]);
  });

  test('a checkout shared by several roots reaches each of them, and says so', () => {
    const shared = checkoutObservation();
    const own = checkoutObservation({ branch: 'fixture/worktree', checkoutPath: WORKTREE_PATH, modifiedCount: 5 });
    const dataset = assemble({
      ...NO_EXTERNAL_FACTS,
      checkouts: [
        { latest: shared, latestObserved: shared },
        { latest: own, latestObserved: own },
        // Same path, another machine: another checkout.
        {
          latest: checkoutObservation({ machineId: 'machine-elsewhere', modifiedCount: 99 }),
          latestObserved: checkoutObservation({ machineId: 'machine-elsewhere', modifiedCount: 99 }),
        },
      ],
    });
    expect(dataset.totalRoots).toBe(6);
    // Root A works in its worktree and its children in the project: both checkouts are its family's.
    const a = rootOf(dataset, 'local_a');
    expect(a.facts.filter((fact) => fact.kind === 'checkout-status').map((fact) => fact.checkoutPath)).toEqual([
      WORKTREE_PATH,
      PROJECT_PATH,
    ]);
    const aChanges = a.interpretations.filter(({ kind }) => kind === 'local-changes-unvalidated');
    expect(aChanges.map(({ text }) => text)).toEqual([
      `5 modified, 1 untracked observed at ${hoursAgo(0.5)} on fixture/worktree in wt-1; since when is unknown; validation and delivery unobserved.`,
      `2 modified, 1 untracked observed at ${hoursAgo(0.5)} on fixture/worktree in project; since when is unknown; validation and delivery unobserved. Checkout shared by 6 roots.`,
    ]);
    for (const root of dataset.roots) {
      const projectFacts = root.facts.filter(
        (fact) => fact.kind === 'checkout-status' && fact.checkoutPath === PROJECT_PATH,
      );
      expect(projectFacts).toHaveLength(1);
      expect(projectFacts[0]?.kind === 'checkout-status' && projectFacts[0].modifiedCount).toBe(2);
    }
    expect(JSON.stringify(dataset)).not.toContain('machine-elsewhere');
  });

  test('a failed latest read keeps the last successful one beside it', () => {
    const dataset = assemble({
      ...NO_EXTERNAL_FACTS,
      pullRequests: [
        {
          latest: failedPullRequestObservation({ observedAt: hoursAgo(0.25) }),
          latestObserved: pullRequestObservation({ observedAt: hoursAgo(3) }),
        },
      ],
    });
    const a = rootOf(dataset, 'local_a');
    expect(
      a.facts.filter((fact) => fact.kind === 'pull-request').map((fact) => [fact.outcome, fact.provenance.observedAt]),
    ).toEqual([
      ['observed', hoursAgo(3)],
      ['unauthenticated', hoursAgo(0.25)],
    ]);
    expect(a.interpretations.map(({ kind }) => kind)).toEqual([
      'request-satisfied-elsewhere',
      'external-review-pending',
      'coverage-gap',
    ]);
    expect(a.interpretations[2]?.text).toContain('unauthenticated');
    expect(a.attention).toBe('external-wait');
  });

  test('keeps the declaration and the external facts first when the fact bound cuts', () => {
    const crowded: ClaudeDesktopSessionObservation = {
      ...session({
        id: 'z',
        lastActivityHoursAgo: 1,
        needsAction: 'Open the pull request.',
        openSuggestions: 60,
        pullRequestState: 'OPEN',
        status: 'blocked',
        title: 'Fixture: Z is crowded',
      }),
      writtenBranches: Array.from({ length: 30 }, (_value, index) => `fixture/branch-${String(index)}`),
    };
    const observed = pullRequestObservation();
    const checkout = checkoutObservation();
    const dataset = assemble(
      {
        ...NO_EXTERNAL_FACTS,
        checkouts: [{ latest: checkout, latestObserved: checkout }],
        pullRequests: [{ latest: observed, latestObserved: observed }],
      },
      [crowded],
    );
    const z = rootOf(dataset, 'local_z');
    expect(z.facts).toHaveLength(WORK_ATTENTION_BOUNDS.maxFacts);
    expect(z.facts.map(({ kind }) => kind).slice(0, 7)).toEqual([
      'declared-turn',
      'wrap-up',
      'turn-report',
      'declared-pull-request',
      'pull-request',
      'checkout-status',
      'proposal',
    ]);
    expect(z.facts.some(({ kind }) => kind === 'written-branch')).toBe(false);
    // 1 + 2 + 1 + 1 + 1 + 60 + 30 = 96 facts, 32 of them cut.
    expect(z.interpretations.map(({ kind }) => kind)).toEqual([
      'request-satisfied-elsewhere',
      'coverage-gap',
      'external-review-pending',
      'local-changes-unvalidated',
      'proposal-open',
    ]);
    expect(z.interpretations[1]?.text).toBe(
      '32 facts beyond the bound of 64 are not listed; the declaration and the external observations were kept first.',
    );
  });

  test('coverage comes from the producers’ run states for the dataset’s machine', () => {
    const runs = [
      runState('github.pull-requests', { disabled: true, failed: 0, message: 'github.enabled is false', observed: 0 }),
      runState('checkouts.status', { failed: 2, observed: 7, ranAt: hoursAgo(0.1) }),
    ];
    const dataset = assemble({ ...NO_EXTERNAL_FACTS, runStates: runs });
    expect(dataset.coverage.pullRequests).toEqual({
      disabled: true,
      failed: 0,
      lastRunAt: hoursAgo(0.25),
      observed: 0,
    });
    expect(dataset.coverage.checkouts).toEqual({ failed: 2, lastRunAt: hoursAgo(0.1), observed: 7 });
    // Another machine's runs say nothing about this one.
    const elsewhere = assemble({
      ...NO_EXTERNAL_FACTS,
      runStates: runs.map((run) => ({ ...run, machineId: 'machine-elsewhere' })),
    });
    expect(elsewhere.coverage.pullRequests).toEqual({ disabled: false, failed: 0, lastRunAt: null, observed: 0 });
    expect(elsewhere.coverage.checkouts).toEqual({ failed: 0, lastRunAt: null, observed: 0 });
  });
});
