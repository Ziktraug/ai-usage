import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  type ClaudeDesktopSessionObservation,
  parseClaudeDesktopSessionObservation,
} from '@ai-usage/report-core/work-attention';
import { type UsageStoreError, usageStoreErrorReasonFrom } from '@ai-usage/usage-store/reader';
import {
  importClaudeDesktopSessions,
  initializeUsageStore,
  publishServedReportRevision,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { queryWorkAttention } from './work-attention-read';

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
      pullRequests: { disabled: true, failed: 0, lastRunAt: null, observed: 0 },
      sessions: { joined: 1, revision: 'revision-work', unmatched: 5 },
    });
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
