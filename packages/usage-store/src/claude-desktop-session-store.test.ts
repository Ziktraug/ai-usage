import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import {
  type ClaudeDesktopSessionObservation,
  parseClaudeDesktopSessionObservation,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import {
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopSessions,
  queryClaudeDesktopTurnDeclarations,
  queryLocalMergeBundle,
  queryUsageStoreGeneration,
  type UsageStoreError,
} from './reader';
import {
  exportLocalMergeBundle,
  importClaudeDesktopSessions,
  importLocalRows,
  initializeUsageStore,
  publishServedReportRevision,
  updateUsageMachineLabel,
} from './writer';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-desktop';
const PRIVATE_SENTINEL = 'PRIVATE_DESKTOP_STORE_SENTINEL_117';
const PROMPT_COLUMN_PATTERN = /prompt/u;

const createStore = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), `usage-store-${name}-`));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const observation = (overrides: Partial<ClaudeDesktopSessionObservation> = {}): ClaudeDesktopSessionObservation => {
  const parsed = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account-a',
    archived: false,
    branch: 'fixture/branch',
    cliSessionId: 'cli-1',
    completedTurns: 3,
    createdAt: '2026-10-19T08:00:00.000Z',
    cwd: '/home/fixture/work/project',
    declaredPullRequests: [
      {
        baseRef: 'main',
        branch: 'fixture/branch',
        host: 'github.com',
        number: 7,
        own: true,
        repository: 'fixture/project',
        state: 'OPEN',
        url: 'https://github.com/fixture/project/pull/7',
      },
    ],
    desktopSessionId: 'local_one',
    effort: 'high',
    fileModifiedAt: '2026-10-20T09:00:00.000Z',
    filePath: '.config/Claude/claude-code-sessions/account-a/org-a/local_one.json',
    format: 'claude-desktop-session-v1',
    lastActivityAt: '2026-10-20T09:00:00.000Z',
    lastTurnReport: 'Last turn report.',
    machineId: MACHINE,
    model: 'claude-fixture',
    observedAt: '2026-10-20T09:05:00.000Z',
    openSuggestions: [{ createdAt: null, expiresAt: null, id: 'task_1', title: 'Fixture proposal', tldr: 'tldr' }],
    organizationDirectory: 'org-a',
    originCwd: '/home/fixture/work',
    priorCliSessionIds: [],
    resolvedSuggestions: { task_0: 'dismissed' },
    sideSessionNotes: [
      { at: '2026-10-20T08:30:00.000Z', report: 'Child report.', sessionId: 'local_child', title: 'Child' },
    ],
    sourceBranch: 'main',
    spawnedFrom: null,
    title: `Fixture: desktop session ${PRIVATE_SENTINEL}`,
    titleSource: 'auto',
    turnSummary: {
      detail: 'Waiting on a decision.',
      needsAction: 'Decide whether to open the pull request.',
      status: 'blocked',
      summarizesUuid: 'uuid-1',
    },
    unsupportedReason: null,
    worktreePath: null,
    wrapUpDescription: 'Wrap-up.',
    writtenBranches: ['fixture/branch'],
    ...overrides,
  });
  if (parsed === null) {
    throw new Error('fixture observation must satisfy the contract');
  }
  return parsed;
};

const completeness = { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 } as const;

const importBatch = (dbPath: string, observations: readonly unknown[], overrides: Record<string, unknown> = {}) =>
  Effect.runPromise(
    importClaudeDesktopSessions({
      collectedAt: new Date('2026-10-20T09:05:00.000Z'),
      completeness,
      dbPath,
      machineId: MACHINE,
      observations,
      ...overrides,
    }),
  );

const failureReason = async (effect: Effect.Effect<unknown, UsageStoreError>): Promise<string | undefined> => {
  const result = await Effect.runPromise(Effect.either(effect));
  return result._tag === 'Left' ? result.left.reason : undefined;
};

describe('claude desktop session store', () => {
  test('imports idempotently, classifying repeats, changes and malformed candidates', async () => {
    const dbPath = await createStore('desktop-import');
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    const first = await importBatch(dbPath, [observation(), { desktopSessionId: 'broken' }]);
    expect(first).toEqual({ inserted: 1, skipped: 1, unchanged: 0, updated: 0 });

    // The sweep time moved but neither the file nor its content did: unchanged, no write.
    const repeat = await importBatch(dbPath, [observation({ observedAt: '2026-10-20T09:06:00.000Z' } as never)]);
    expect(repeat).toEqual({ inserted: 0, skipped: 0, unchanged: 1, updated: 0 });

    const rewritten = await importBatch(dbPath, [
      observation({
        fileModifiedAt: '2026-10-20T10:00:00.000Z',
        lastActivityAt: '2026-10-20T10:00:00.000Z',
        turnSummary: { detail: 'Done.', needsAction: null, status: 'completed', summarizesUuid: 'uuid-2' },
      } as never),
    ]);
    expect(rewritten).toEqual({ inserted: 0, skipped: 0, unchanged: 0, updated: 1 });

    const otherMachine = await importBatch(dbPath, [observation({ machineId: 'machine-other' } as never)]);
    expect(otherMachine).toEqual({ inserted: 0, skipped: 1, unchanged: 0, updated: 0 });

    const read = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath, machineId: MACHINE }));
    expect(read.skipped).toBe(0);
    expect(read.truncated).toBe(false);
    expect(read.observations).toHaveLength(1);
    expect(read.observations[0]?.turnSummary?.status).toBe('completed');
    expect(read.observations[0]?.declaredPullRequests[0]?.number).toBe(7);
    expect(read.observations[0]?.sideSessionNotes).toHaveLength(1);
    expect(read.observations[0]?.resolvedSuggestions).toEqual({ task_0: 'dismissed' });

    // The family lives outside the served revision, so a sweep never advances the generation.
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationBefore);

    const state = await Effect.runPromise(queryClaudeDesktopCollectionState({ dbPath, machineId: MACHINE }));
    expect(state.states).toEqual([
      { collectedAt: '2026-10-20T09:05:00.000Z', completeness: { ...completeness }, machineId: MACHINE },
    ]);
  });

  test('pages by recency, filters by machine and activity, and counts rows it cannot re-validate', async () => {
    const dbPath = await createStore('desktop-read');
    const rows = [
      observation({ desktopSessionId: 'local_old', lastActivityAt: '2026-10-01T00:00:00.000Z' } as never),
      observation({ desktopSessionId: 'local_mid', lastActivityAt: '2026-10-10T00:00:00.000Z' } as never),
      observation({ desktopSessionId: 'local_new', lastActivityAt: '2026-10-20T00:00:00.000Z' } as never),
    ];
    await importBatch(dbPath, rows);
    await importBatch(dbPath, [observation({ desktopSessionId: 'local_other', machineId: 'machine-other' } as never)], {
      machineId: 'machine-other',
    });

    const page = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath, limit: 2, machineId: MACHINE }));
    expect(page.observations.map((row) => row.desktopSessionId)).toEqual(['local_new', 'local_mid']);
    expect(page.truncated).toBe(true);

    const since = await Effect.runPromise(
      queryClaudeDesktopSessions({ dbPath, machineId: MACHINE, sinceLastActivityAt: '2026-10-10T00:00:00.000Z' }),
    );
    expect(since.observations.map((row) => row.desktopSessionId)).toEqual(['local_new', 'local_mid']);
    expect(since.truncated).toBe(false);

    const all = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath }));
    expect(all.observations).toHaveLength(4);

    const db = new Database(dbPath, { create: false, readwrite: true });
    db.query(
      "UPDATE claude_desktop_sessions SET status_category = 'waiting' WHERE desktop_session_id = 'local_mid'",
    ).run();
    db.query(
      "UPDATE claude_desktop_sessions SET open_suggestions_json = '{not json' WHERE desktop_session_id = 'local_old'",
    ).run();
    db.close(true);

    const revalidated = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath, machineId: MACHINE }));
    expect(revalidated.observations.map((row) => row.desktopSessionId)).toEqual(['local_new']);
    expect(revalidated.skipped).toBe(2);

    expect(await failureReason(queryClaudeDesktopSessions({ dbPath, limit: 0 }))).toBe('invalid-input');
    expect(await failureReason(queryClaudeDesktopSessions({ dbPath, limit: 501 }))).toBe('invalid-input');
    expect(await failureReason(queryClaudeDesktopSessions({ dbPath, sinceLastActivityAt: 'yesterday' }))).toBe(
      'invalid-input',
    );
    expect(
      await failureReason(
        importClaudeDesktopSessions({
          completeness: { ...completeness, filesSeen: -1 },
          dbPath,
          machineId: MACHINE,
          observations: [],
        }),
      ),
    ).toBe('invalid-input');
  });

  test('never carries a prompt column', async () => {
    const dbPath = await createStore('desktop-columns');
    const db = new Database(dbPath, { readonly: true });
    const columns = db.query('PRAGMA table_info(claude_desktop_sessions)').all() as { name: string }[];
    db.close(true);
    expect(columns.some(({ name }) => PROMPT_COLUMN_PATTERN.test(name))).toBe(false);
    expect(columns.map(({ name }) => name)).toContain('needs_action');
  });

  test('stays outside the served revision, the replication outbox and the merge bundle', async () => {
    const dbPath = await createStore('desktop-isolation');
    const machine = { id: MACHINE, label: 'Desktop Machine' };
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
    await importBatch(dbPath, [observation()]);

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
    await Effect.runPromise(
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
        revision: 'revision-desktop',
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
      expect(text).not.toContain(PRIVATE_SENTINEL);
      expect(text).not.toContain('local_one');
      expect(text).not.toContain('Decide whether to open');
    }
  });
});

describe('claude desktop turn declaration history (ADR 0056)', () => {
  const declarations = (dbPath: string) =>
    Effect.runPromise(queryClaudeDesktopTurnDeclarations({ dbPath, desktopSessionIds: ['local_one'] }));
  const turn = (summarizesUuid: string, needsAction: string | null, status: 'blocked' | 'completed' = 'blocked') => ({
    detail: `Declared ${status}.`,
    needsAction,
    status,
    summarizesUuid,
  });
  const sweep = (
    activityAt: string,
    frameAt: string | null,
    summary: ReturnType<typeof turn>,
  ): ClaudeDesktopSessionObservation =>
    observation({
      fileModifiedAt: activityAt,
      lastActivityAt: activityAt,
      latestUserFrameAt: frameAt,
      turnSummary: summary,
    } as Partial<ClaudeDesktopSessionObservation>);

  test('Q1, a message, then Q2: Q1 is kept as replied and superseded, Q2 is the current declaration', async () => {
    const dbPath = await createStore('desktop-history');
    await importBatch(dbPath, [sweep('2026-10-20T06:00:00.000Z', '2026-10-20T05:50:00.000Z', turn('uuid-q1', 'Q1?'))]);
    await importBatch(dbPath, [sweep('2026-10-20T06:30:00.000Z', '2026-10-20T06:20:00.000Z', turn('uuid-q1', 'Q1?'))]);
    await importBatch(dbPath, [sweep('2026-10-20T08:00:00.000Z', '2026-10-20T06:20:00.000Z', turn('uuid-q2', 'Q2?'))]);

    const read = await declarations(dbPath);
    expect(read.skipped).toBe(0);
    expect(
      read.declarations.map((row) => [
        row.declarationKey,
        row.needsAction,
        row.declaredAt,
        row.repliedAt,
        row.supersededAt,
      ]),
    ).toEqual([
      ['uuid-q1', 'Q1?', '2026-10-20T06:00:00.000Z', '2026-10-20T06:20:00.000Z', '2026-10-20T08:00:00.000Z'],
      ['uuid-q2', 'Q2?', '2026-10-20T08:00:00.000Z', null, null],
    ]);
    // The message time round-trips on the session row as well.
    const sessions = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath }));
    expect(String(sessions.observations[0]?.latestUserFrameAt)).toBe('2026-10-20T06:20:00.000Z');
  });

  test('an unchanged file writes nothing, and a current declaration missing from the history is recorded', async () => {
    const dbPath = await createStore('desktop-history-seed');
    const first = sweep('2026-10-20T06:00:00.000Z', null, turn('uuid-q1', 'Q1?'));
    await importBatch(dbPath, [first]);
    const writable = new Database(dbPath);
    writable.exec('DELETE FROM claude_desktop_turn_declarations');
    writable.close(true);
    // A store from before the history: the session row is unchanged, the history starts from this sweep.
    expect(await importBatch(dbPath, [first])).toEqual({ inserted: 0, skipped: 0, unchanged: 1, updated: 0 });
    expect((await declarations(dbPath)).declarations.map((row) => row.declarationKey)).toEqual(['uuid-q1']);
    expect(await importBatch(dbPath, [first])).toEqual({ inserted: 0, skipped: 0, unchanged: 1, updated: 0 });
    expect((await declarations(dbPath)).declarations).toHaveLength(1);
  });

  test('keeps the newest declarations per session and counts a refused row instead of showing it', async () => {
    const dbPath = await createStore('desktop-history-bound');
    for (let index = 0; index < 11; index++) {
      const at = new Date(Date.UTC(2026, 9, 20, index)).toISOString();
      await importBatch(dbPath, [sweep(at, null, turn(`uuid-${index}`, `Question ${index}?`))]);
    }
    const read = await declarations(dbPath);
    expect(read.declarations).toHaveLength(WORK_ATTENTION_BOUNDS.maxDeclarationsPerSession);
    expect(read.declarations.at(-1)).toMatchObject({ declarationKey: 'uuid-10', supersededAt: null });
    const writable = new Database(dbPath);
    writable.exec(
      "UPDATE claude_desktop_turn_declarations SET status_category = 'waiting' WHERE declaration_key = 'uuid-5'",
    );
    writable.close(true);
    const refused = await declarations(dbPath);
    expect(refused.skipped).toBe(1);
    expect(refused.declarations.map((row) => row.declarationKey)).not.toContain('uuid-5');
    expect(await failureReason(queryClaudeDesktopTurnDeclarations({ dbPath, desktopSessionIds: [''] }))).toBe(
      'invalid-input',
    );
    expect(
      (await Effect.runPromise(queryClaudeDesktopTurnDeclarations({ dbPath, desktopSessionIds: [] }))).declarations,
    ).toEqual([]);
  });

  test('reads pending sessions beyond a recency page, and sessions by id, never widening an empty filter', async () => {
    const dbPath = await createStore('desktop-pending');
    await importBatch(dbPath, [
      observation({ desktopSessionId: 'local_recent', lastActivityAt: '2026-10-20T09:00:00.000Z' } as never),
      observation({
        desktopSessionId: 'local_old_blocked',
        lastActivityAt: '2026-09-01T09:00:00.000Z',
      } as never),
      observation({
        desktopSessionId: 'local_old_done',
        lastActivityAt: '2026-09-02T09:00:00.000Z',
        turnSummary: turn('uuid-done', null, 'completed'),
      } as never),
    ]);
    const older = await Effect.runPromise(
      queryClaudeDesktopSessions({ dbPath, olderThanLastActivityAt: '2026-10-20T09:00:00.000Z', pendingOnly: true }),
    );
    expect(older.observations.map((row) => row.desktopSessionId)).toEqual(['local_old_blocked']);
    const byId = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath, desktopSessionIds: ['local_old_done'] }));
    expect(byId.observations.map((row) => row.desktopSessionId)).toEqual(['local_old_done']);
    const none = await Effect.runPromise(queryClaudeDesktopSessions({ dbPath, desktopSessionIds: [] }));
    expect(none).toEqual({ observations: [], skipped: 0, truncated: false });
    expect(await failureReason(queryClaudeDesktopSessions({ dbPath, olderThanLastActivityAt: 'yesterday' }))).toBe(
      'invalid-input',
    );
  });
});
