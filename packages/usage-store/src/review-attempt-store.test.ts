import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { REVIEW_ATTEMPT_BOUNDS, type ReviewAttemptTarget } from '@ai-usage/report-core/work-attempts';
import { parseClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import type { ExecutorDeclaration } from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { queryReviewAttempts, queryReviewTargetResolution } from './reader';
import type { NewReviewAttempt } from './review-attempt-store';
import {
  importClaudeDesktopSessions,
  initializeUsageStore,
  markReviewAttemptsLost,
  publishServedReportRevision,
  requestReviewAttempt,
  transitionReviewAttempt,
  updateUsageMachineLabel,
} from './writer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-attempts';
const NOW = '2026-10-22T10:00:00.000Z';
const LATER = '2026-10-22T10:00:15.000Z';
const declaration: ExecutorDeclaration = {
  accountScope: 'personal',
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  effort: null,
  harness: 'claude-code',
  machineId: MACHINE,
  model: null,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
};
const target: ReviewAttemptTarget = {
  checkoutOrigin: 'desktop-cwd',
  checkoutPath: '/home/fixture/work/project',
  desktopSessionId: 'local_one',
  harness: 'claude',
  projectLabel: 'project',
  sessionTitle: 'Fixture: desktop session',
  sourceSessionId: 'cli-1',
};
const newAttempt = (overrides: Partial<NewReviewAttempt> = {}): NewReviewAttempt => ({
  candidateId: 'declared:["machine-attempts","claude-code","personal"]',
  declaration,
  executorHarness: 'claude-code',
  idempotencyKey: 'k'.repeat(64),
  machineId: MACHINE,
  requestedAt: NOW,
  state: 'requested',
  target,
  ...overrides,
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-review-attempts-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const run = <Value>(effect: Effect.Effect<Value, UsageStoreError>): Promise<Value> => Effect.runPromise(effect);

describe('review attempt store', () => {
  test('creates the additive table on open without touching user_version', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'review_attempts'").get(),
      ).toEqual({
        name: 'review_attempts',
      });
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
      const indexes = db
        .query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'review_attempts'")
        .all() as { name: string }[];
      expect(
        indexes
          .map(({ name }) => name)
          .filter((name) => !name.startsWith('sqlite_autoindex'))
          .sort(),
      ).toEqual(['idx_review_attempts_live_identity', 'idx_review_attempts_target']);
    } finally {
      db.close();
    }
  });

  test('inserts one live attempt per identity and returns the existing one to a second request', async () => {
    const dbPath = await createStore();
    const first = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-1' }), dbPath }));
    expect(first).toMatchObject({
      attempt: { attemptId: 'attempt-1', state: 'requested', acceptance: 'pending' },
      reused: false,
    });
    expect(first.attempt.declaration).toEqual(declaration);
    expect(first.attempt.validations).toEqual([]);

    const second = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-2' }), dbPath }));
    expect(second).toMatchObject({ attempt: { attemptId: 'attempt-1' }, reused: true });

    // A refusal is recorded beside the live attempt and never blocks or reuses it.
    const refused = await run(
      requestReviewAttempt({
        attempt: newAttempt({
          attemptId: 'attempt-3',
          failureReason: 'target-not-allowed: add routing.reviewTargets for /x',
          state: 'refused',
        }),
        dbPath,
      }),
    );
    expect(refused).toMatchObject({ attempt: { attemptId: 'attempt-3', state: 'refused' }, reused: false });

    // Once the live attempt ends, the identity is free again.
    await run(
      transitionReviewAttempt({
        at: LATER,
        attemptId: 'attempt-1',
        dbPath,
        patch: { endedAt: LATER, exitCode: 0, resultExcerpt: 'Findings', resultKind: 'review', state: 'finished' },
      }),
    );
    const third = await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-4' }), dbPath }));
    expect(third).toMatchObject({ attempt: { attemptId: 'attempt-4', state: 'requested' }, reused: false });

    const listed = await run(queryReviewAttempts({ dbPath, target: { harness: 'claude', sourceSessionId: 'cli-1' } }));
    expect(listed.attempts.map(({ attemptId }) => attemptId)).toEqual(['attempt-4', 'attempt-3', 'attempt-1']);
    expect(listed).toMatchObject({ skipped: 0, truncated: false });
  });

  test('guards transitions by state and bounds the written text', async () => {
    const dbPath = await createStore();
    await run(requestReviewAttempt({ attempt: newAttempt({ attemptId: 'attempt-1' }), dbPath }));
    expect(
      await run(
        transitionReviewAttempt({
          at: LATER,
          attemptId: 'attempt-1',
          dbPath,
          patch: { pid: 4242, startedAt: LATER, state: 'starting' },
        }),
      ),
    ).toEqual({ applied: true });
    expect(
      await run(
        transitionReviewAttempt({
          at: LATER,
          attemptId: 'attempt-1',
          dbPath,
          patch: { nativeSessionId: 'native-1', state: 'running' },
        }),
      ),
    ).toEqual({ applied: true });
    // A heartbeat is an empty patch from a live state.
    expect(
      await run(transitionReviewAttempt({ at: '2026-10-22T10:00:30.000Z', attemptId: 'attempt-1', dbPath, patch: {} })),
    ).toEqual({
      applied: true,
    });
    expect(
      await run(
        transitionReviewAttempt({
          at: '2026-10-22T10:01:00.000Z',
          attemptId: 'attempt-1',
          dbPath,
          patch: {
            durationMs: 45_000,
            endedAt: '2026-10-22T10:01:00.000Z',
            exitCode: 1,
            failureReason: 'f'.repeat(2000),
            numTurns: 8,
            resultExcerpt: 'e'.repeat(10_000),
            resultKind: 'error',
            state: 'failed',
          },
        }),
      ),
    ).toEqual({ applied: true });
    // Late writes from the finished process cannot resurrect the row.
    expect(
      await run(transitionReviewAttempt({ at: '2026-10-22T10:02:00.000Z', attemptId: 'attempt-1', dbPath, patch: {} })),
    ).toEqual({
      applied: false,
    });
    expect(
      await run(
        transitionReviewAttempt({
          at: '2026-10-22T10:02:00.000Z',
          attemptId: 'attempt-1',
          dbPath,
          patch: { state: 'running' },
        }),
      ),
    ).toEqual({ applied: false });
    expect(await run(transitionReviewAttempt({ at: LATER, attemptId: 'missing', dbPath, patch: {} }))).toEqual({
      applied: false,
    });

    const [attempt] = (await run(queryReviewAttempts({ dbPath }))).attempts;
    expect(attempt).toMatchObject({
      durationMs: 45_000,
      exitCode: 1,
      nativeSessionId: 'native-1',
      numTurns: 8,
      pid: 4242,
      resultKind: 'error',
      startedAt: LATER,
      state: 'failed',
      updatedAt: '2026-10-22T10:01:00.000Z',
    });
    expect(attempt?.resultExcerpt?.length).toBe(REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
    expect(attempt?.failureReason?.length).toBe(REVIEW_ATTEMPT_BOUNDS.maxFailureReason);
  });

  test('marks every live attempt of the machine lost with a bounded reason and leaves the rest alone', async () => {
    const dbPath = await createStore();
    await run(
      requestReviewAttempt({
        attempt: newAttempt({ attemptId: 'requested-1', idempotencyKey: 'a'.repeat(64) }),
        dbPath,
      }),
    );
    await run(
      requestReviewAttempt({ attempt: newAttempt({ attemptId: 'running-1', idempotencyKey: 'b'.repeat(64) }), dbPath }),
    );
    await run(
      transitionReviewAttempt({ at: LATER, attemptId: 'running-1', dbPath, patch: { pid: 77, state: 'running' } }),
    );
    await run(
      requestReviewAttempt({ attempt: newAttempt({ attemptId: 'done-1', idempotencyKey: 'c'.repeat(64) }), dbPath }),
    );
    await run(
      transitionReviewAttempt({ at: LATER, attemptId: 'done-1', dbPath, patch: { state: 'finished', endedAt: LATER } }),
    );
    await run(
      requestReviewAttempt({
        attempt: newAttempt({ attemptId: 'other-machine', idempotencyKey: 'd'.repeat(64), machineId: 'elsewhere' }),
        dbPath,
      }),
    );

    const lost = await run(
      markReviewAttemptsLost({
        at: '2026-10-22T11:00:00.000Z',
        dbPath,
        machineId: MACHINE,
        reason: ({ pid, state }) => `engine restarted while ${state}${pid === null ? '' : ` (pid ${pid})`}`,
      }),
    );
    expect([...lost.lost].sort()).toEqual(['requested-1', 'running-1']);
    const all = await run(queryReviewAttempts({ dbPath }));
    const byId = new Map(all.attempts.map((attempt) => [attempt.attemptId, attempt]));
    expect(byId.get('running-1')).toMatchObject({
      endedAt: '2026-10-22T11:00:00.000Z',
      failureReason: 'engine restarted while running (pid 77)',
      state: 'lost',
    });
    expect(byId.get('requested-1')?.state).toBe('lost');
    expect(byId.get('done-1')?.state).toBe('finished');
    expect(byId.get('other-machine')?.state).toBe('requested');
    expect((await run(queryReviewAttempts({ dbPath, states: ['lost'] }))).attempts).toHaveLength(2);
    expect((await run(queryReviewAttempts({ dbPath, machineId: 'elsewhere' }))).attempts).toHaveLength(1);
  });

  test('bounds the list, reports truncation and counts rows that no longer re-validate', async () => {
    const dbPath = await createStore();
    for (let index = 0; index < 4; index++) {
      await run(
        requestReviewAttempt({
          attempt: newAttempt({
            attemptId: `attempt-${index}`,
            idempotencyKey: String(index).repeat(64),
            requestedAt: `2026-10-22T10:0${index}:00.000Z`,
          }),
          dbPath,
        }),
      );
    }
    const page = await run(queryReviewAttempts({ dbPath, limit: 2 }));
    expect(page.attempts.map(({ attemptId }) => attemptId)).toEqual(['attempt-3', 'attempt-2']);
    expect(page.truncated).toBe(true);
    await expect(run(queryReviewAttempts({ dbPath, limit: 0 }))).rejects.toThrow();
    await expect(run(queryReviewAttempts({ dbPath, limit: REVIEW_ATTEMPT_BOUNDS.maxListLimit + 1 }))).rejects.toThrow();

    const db = new Database(dbPath);
    try {
      db.query("UPDATE review_attempts SET requested_at = 'yesterday' WHERE attempt_id = 'attempt-0'").run();
    } finally {
      db.close();
    }
    const revalidated = await run(queryReviewAttempts({ dbPath }));
    expect(revalidated.attempts.map(({ attemptId }) => attemptId)).toEqual(['attempt-3', 'attempt-2', 'attempt-1']);
    expect(revalidated.skipped).toBe(1);
  });

  test('resolves the target from the Desktop session and the served Session at the current revision', async () => {
    const dbPath = await createStore();
    const machine = { id: MACHINE, label: 'Attempt Machine' };
    await run(updateUsageMachineLabel({ dbPath, machine }));
    const desktop = parseClaudeDesktopSessionObservation({
      accountDirectory: 'account-a',
      archived: false,
      branch: null,
      cliSessionId: 'cli-1',
      completedTurns: 1,
      createdAt: '2026-10-19T08:00:00.000Z',
      cwd: '/home/fixture/work/project',
      declaredPullRequests: [],
      desktopSessionId: 'local_one',
      effort: null,
      fileModifiedAt: '2026-10-20T09:00:00.000Z',
      filePath: '.config/Claude/claude-code-sessions/account-a/org-a/local_one.json',
      format: 'claude-desktop-session-v1',
      lastActivityAt: '2026-10-20T09:00:00.000Z',
      lastTurnReport: null,
      machineId: MACHINE,
      model: null,
      observedAt: '2026-10-20T09:05:00.000Z',
      openSuggestions: [],
      organizationDirectory: 'org-a',
      originCwd: null,
      priorCliSessionIds: [],
      resolvedSuggestions: {},
      sideSessionNotes: [],
      sourceBranch: null,
      spawnedFrom: null,
      title: 'Fixture: desktop session',
      titleSource: 'auto',
      turnSummary: null,
      unsupportedReason: null,
      worktreePath: '/home/fixture/work/project/.claude/worktrees/w1',
      wrapUpDescription: null,
      writtenBranches: [],
    });
    if (desktop === null) {
      throw new Error('fixture must parse');
    }
    await run(
      importClaudeDesktopSessions({
        completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
        dbPath,
        machineId: MACHINE,
        observations: [desktop],
      }),
    );
    const beforeRevision = await run(
      queryReviewTargetResolution({ dbPath, harness: 'claude', machineId: MACHINE, sourceSessionId: 'cli-1' }),
    );
    expect(beforeRevision).toEqual({
      desktop: {
        cwd: '/home/fixture/work/project',
        desktopSessionId: 'local_one',
        title: 'Fixture: desktop session',
        worktreePath: '/home/fixture/work/project/.claude/worktrees/w1',
      },
      session: null,
    });

    const servedRow: SerializedRow = {
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
        machineLabel: machine.label,
        rootSourceSessionId: 'cli-1',
        sourcePath: '/home/fixture/work/project',
        sourceSessionId: 'cli-1',
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
      generatedAt: '2026-10-20T09:10:00.000Z',
      machineFreshness: {
        kind: 'available',
        machines: [{ id: MACHINE, label: machine.label, lastSeenAt: '2026-10-20T09:10:00.000Z' }],
        observedAt: '2026-10-20T09:10:00.000Z',
        omittedMachines: 0,
        skippedRows: 0,
      },
      omittedRows: 0,
      timeZone: 'UTC',
    };
    await run(
      publishServedReportRevision({
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: support.generatedAt,
          projectAliases: [],
          projectGroupConfigs: [],
          rows: [servedRow],
          sourceAuthorities: ['local-observed'],
          support,
        }),
        dbPath,
        now: 1000,
        revision: 'revision-attempts',
        ttlMs: 300_000,
      }),
    );
    const resolved = await run(
      queryReviewTargetResolution({ dbPath, harness: 'claude', machineId: MACHINE, sourceSessionId: 'cli-1' }),
    );
    expect(resolved.session).toEqual({
      name: 'Served session',
      projectLabel: 'project',
      sourcePath: '/home/fixture/work/project',
    });
    // Another harness never joins the Desktop registry; an unknown session resolves to nothing.
    expect(
      await run(
        queryReviewTargetResolution({ dbPath, harness: 'codex', machineId: MACHINE, sourceSessionId: 'cli-1' }),
      ),
    ).toEqual({ desktop: null, session: null });
    expect(
      await run(
        queryReviewTargetResolution({
          dbPath,
          desktopSessionId: 'local_one',
          harness: 'codex',
          machineId: MACHINE,
          sourceSessionId: 'other',
        }),
      ),
    ).toMatchObject({ desktop: { desktopSessionId: 'local_one' }, session: null });
  });
});
