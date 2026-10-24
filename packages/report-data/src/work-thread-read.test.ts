import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  parseCheckoutStatusObservation,
  parseClaudeDesktopSessionObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import {
  branchLinkKey,
  sessionLinkKey,
  type WorkThreadCommand,
  type WorkThreadLinkInput,
} from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_VIEW_BOUNDS, type WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import { queryWorkThreadLinks, queryWorkThreadSessionEvidence } from '@ai-usage/usage-store/reader';
import {
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  importJiraIssueObservations,
  importPullRequestObservations,
  initializeUsageStore,
  publishServedReportRevision,
  recordWorkFactRun,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { applyWorkThreadCommand } from '../../usage-store/src/index';
import { queryWorkThreadDetail, queryWorkThreadList } from './work-thread-read';

const roots: string[] = [];
const MACHINE = 'reader-machine';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const at = (hours: number) => canonicalInstantFromDate(new Date(NOW.getTime() + hours * 3_600_000));
const QUERY: WorkThreadListQuery = { cursor: null, limit: 50, project: null, search: null, tab: 'open' };
const run = Effect.runPromise;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-thread-reader-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await run(initializeUsageStore({ dbPath }));
  await run(updateUsageMachineLabel({ dbPath, machine: { id: MACHINE, label: 'Reader fixture' } }));
  return dbPath;
};
const command = async (dbPath: string, input: WorkThreadCommand, hours = -24) => {
  const result = await run(applyWorkThreadCommand({ dbPath, machineId: MACHINE, command: input, now: at(hours) }));
  if (!result.ok) {
    throw new Error(result.failure);
  }
  return result;
};
const create = async (dbPath: string, links: readonly WorkThreadLinkInput[] = [], title = 'A task', hours = -24) =>
  (
    await command(
      dbPath,
      { commandId: randomUUID(), op: 'create', title, links, intent: null, objective: null, projectLabel: 'project' },
      hours,
    )
  ).threadId;
const session = (id: string, overrides: Partial<SerializedRow> = {}): SerializedRow => ({
  activeDate: at(-1),
  calls: 1,
  costActual: null,
  costApprox: 0,
  costKnown: true,
  date: at(-2),
  durationMs: 1,
  endDate: at(-1),
  freshTokens: 0,
  harness: 'Codex',
  lineDelta: null,
  linesAdded: null,
  linesDeleted: null,
  model: 'fixture',
  name: id,
  project: 'project',
  provider: 'fixture',
  sessionLabel: id,
  source: {
    harnessKey: 'codex',
    machineId: MACHINE,
    rootSourceSessionId: id,
    sourceSessionId: id,
    sourcePath: '/fixture/project',
  },
  tokCr: 0,
  tokCw: 0,
  tokIn: 0,
  tokOut: 0,
  tokenTotal: 0,
  tools: 0,
  turns: 1,
  ...overrides,
});
const publish = async (dbPath: string, rows: SerializedRow[]) => {
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
      sessionCount: rows.length,
      tools: 0,
      totalCost: 0,
      turns: 0,
      unpricedCount: 0,
    },
    filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
    generatedAt: at(0),
    machineFreshness: {
      kind: 'available',
      machines: [{ id: MACHINE, label: 'Reader fixture', lastSeenAt: at(0) }],
      observedAt: at(0),
      omittedMachines: 0,
      skippedRows: 0,
    },
    omittedRows: 0,
    timeZone: 'UTC',
  };
  await run(
    publishServedReportRevision({
      dbPath,
      now: NOW.getTime(),
      ttlMs: 300_000,
      revision: 'work-thread-reader-fixture',
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: at(0),
        projectAliases: [],
        projectGroupConfigs: [],
        rows: rows.map((row) => ({
          ...row,
          source: {
            ...row.source,
            harnessKey: row.source?.harnessKey ?? 'codex',
            sourceSessionId: row.source?.sourceSessionId ?? null,
            machineLabel: 'Reader fixture',
          },
        })),
        sourceAuthorities: rows.map(() => 'local-observed'),
        support,
      }),
    }),
  );
};
const sessionLink = (id: string, harness = 'codex') => ({
  kind: 'session' as const,
  key: sessionLinkKey({ machineId: MACHINE, harness, sessionId: id }),
});
const pr = (hours: number, outcome: 'observed' | 'timeout' | 'unauthenticated' = 'observed') => {
  const value = parsePullRequestObservation({
    machineId: MACHINE,
    host: 'github.com',
    repository: 'fixture/repo',
    number: 7,
    observedAt: at(hours),
    outcome,
    state: outcome === 'observed' ? 'OPEN' : null,
    title: outcome === 'observed' ? 'Real linked PR' : null,
  });
  if (value === null) {
    throw new Error('Invalid PR fixture');
  }
  return value;
};

describe('work-thread reader', () => {
  test('empty data does not turn unrun sources into success, and a missing store fails', async () => {
    const dbPath = await fixture();
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(list.rows).toEqual([]);
    expect(list.sources.map((source) => source.state)).toEqual(['never-run', 'never-run', 'never-run', 'never-run']);
    expect(list.machineId).toBe(MACHINE);
    expect(await run(queryWorkThreadDetail({ dbPath, threadId: randomUUID(), now: NOW }))).toBeNull();
    const missing = await run(
      Effect.either(
        queryWorkThreadList({ dbPath: path.join(path.dirname(dbPath), 'missing'), query: QUERY, now: NOW }),
      ),
    );
    expect(missing._tag).toBe('Left');
    if (missing._tag === 'Left') {
      expect(missing.left.reason).toBe('store-missing');
    }
  });

  test('reads latest attempt alongside latest success, keeps ended follow-up, and ignores detached links', async () => {
    const dbPath = await fixture();
    const threadId = await create(dbPath, [{ kind: 'pull-request', key: 'github.com/fixture/repo#7' }]);
    await command(
      dbPath,
      {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId,
        expectedRevision: 1,
        to: 'done',
        reason: 'Enough',
        waitingFor: null,
        waitingOn: null,
        acknowledgedRemainders: [],
      },
      -10,
    );
    await run(importPullRequestObservations({ dbPath, observations: [pr(-8), pr(-2, 'timeout')] }));
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row.markers.pullRequests[0]).toMatchObject({
      latest: { outcome: 'timeout' },
      latestSuccessful: { outcome: 'observed' },
      mergeable: null,
      mergeStateStatus: null,
      role: null,
    });
    expect(detail?.row.afterDone).toEqual({ count: 2, latestAt: at(-2) });
    expect(detail?.row.thread.followState).toBe('done');
    expect(detail?.row.lastActivityAt).toBe(at(-2));
    const link = (await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] })))[0];
    if (!link) {
      throw new Error('No link');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: link.linkId }, -1);
    const detached = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detached?.row.markers.pullRequests).toEqual([]);
    expect(detached?.detachedLinks).toHaveLength(1);
    expect(detached?.row.afterDone).toBeNull();
  });

  test('resolves an old linked session beyond 200 newer campaigns and folds declared children', async () => {
    const dbPath = await fixture();
    const parent = session('old', { date: at(-300), endDate: at(-299), activeDate: at(-299), origin: 'human' });
    const child = session('child', {
      origin: 'subagent',
      source: {
        ...session('child').source,
        harnessKey: 'codex',
        sourceSessionId: 'child',
        parentSourceSessionId: 'old',
        rootSourceSessionId: 'old',
      },
    });
    await publish(dbPath, [parent, child, ...Array.from({ length: 210 }, (_, index) => session(`recent-${index}`))]);
    const threadId = await create(dbPath, [sessionLink('old'), sessionLink('child')]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes).toHaveLength(1);
    expect(detail?.episodes[0]).toMatchObject({
      sourceSessionId: 'old',
      durationBasis: 'span',
      durationMs: 3_600_000,
      origin: 'human',
      running: null,
      firstPrompt: null,
    });
    expect(detail?.episodes[0]?.children).toHaveLength(1);
    expect(detail?.episodes[0]?.children[0]).toMatchObject({
      sourceSessionId: 'child',
      origin: 'delegated',
      launchedBy: { harness: 'codex', title: 'old' },
    });
    expect(detail?.row.sessionCount).toBe(2);
    expect(detail?.row.marks.filter((mark) => mark.kind === 'session')).toHaveLength(1);
    expect(detail?.sources.find((source) => source.source === 'sessions')?.state).toBe('ok');
  });

  test('duration and origin remain unknown when unrecorded, CLI commands quote IDs, unverified harness cannot resume', async () => {
    const dbPath = await fixture();
    const quotedId = "a'$(touch-nope)";
    await publish(dbPath, [
      session(quotedId, { endDate: null, activeDate: at(-2), titleSource: 'first-prompt' }),
      session('other', {
        source: { harnessKey: 'opencode', machineId: MACHINE, sourceSessionId: 'other', rootSourceSessionId: 'other' },
      }),
    ]);
    const threadId = await create(dbPath, [sessionLink(quotedId), sessionLink('other', 'opencode')]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes.find((episode) => episode.sourceSessionId === quotedId)).toMatchObject({
      durationBasis: 'unknown',
      firstPrompt: quotedId,
      durationMs: null,
      endedAt: null,
      origin: null,
      resume: { kind: 'cli-resume', command: "codex resume 'a'\\''$(touch-nope)'", cwd: '/fixture/project' },
    });
    expect(detail?.episodes.find((episode) => episode.sourceSessionId === 'other')?.resume.kind).toBe('none');
    const ended = await create(dbPath, [sessionLink(quotedId)]);
    await command(
      dbPath,
      {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId: ended,
        expectedRevision: 1,
        to: 'done',
        reason: null,
        waitingFor: null,
        waitingOn: null,
        acknowledgedRemainders: [],
      },
      -3,
    );
    const activity = await run(queryWorkThreadDetail({ dbPath, threadId: ended, now: NOW }));
    expect(activity?.row.afterDone).toEqual({ count: 1, latestAt: at(-2) });
    expect(activity?.row.lastActivityAt).toBe(at(-2));
    expect(activity?.episodes[0]?.durationBasis).toBe('unknown');
    const doneList = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, tab: 'done' }, now: NOW }));
    expect(doneList.rows[0]?.lastActivityAt).toBe(at(-2));
  });

  test('Desktop metadata supplies dated question and report without reading transcripts', async () => {
    const dbPath = await fixture();
    const desktop = parseClaudeDesktopSessionObservation({
      accountDirectory: 'account',
      archived: false,
      branch: null,
      cliSessionId: 'cli-id',
      completedTurns: 1,
      createdAt: at(-4),
      cwd: '/fixture/desktop',
      declaredPullRequests: [],
      desktopSessionId: 'desktop-id',
      effort: null,
      fileModifiedAt: at(-1),
      filePath: 'account/session.json',
      format: 'claude-desktop-session-v1',
      lastActivityAt: at(-1),
      lastTurnReport: 'Ready for review.',
      machineId: MACHINE,
      model: null,
      observedAt: at(0),
      openSuggestions: [],
      organizationDirectory: 'org',
      originCwd: null,
      priorCliSessionIds: [],
      resolvedSuggestions: {},
      sideSessionNotes: [],
      sourceBranch: null,
      spawnedFrom: null,
      title: 'Desktop title',
      titleSource: 'auto',
      turnSummary: {
        detail: 'Waiting for decision',
        needsAction: 'Review this',
        status: 'review_ready',
        summarizesUuid: null,
      },
      unsupportedReason: null,
      worktreePath: null,
      wrapUpDescription: null,
      writtenBranches: [],
    });
    if (desktop === null) {
      throw new Error('Invalid Desktop fixture');
    }
    await run(
      importClaudeDesktopSessions({
        dbPath,
        machineId: MACHINE,
        collectedAt: NOW,
        completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
        observations: [
          desktop,
          {
            ...desktop,
            cliSessionId: 'child-cli',
            desktopSessionId: 'child-desktop',
            title: 'Child',
            spawnedFrom: { sessionId: 'desktop-id', sideSession: true, taskId: null, title: 'Child' },
          },
          {
            ...desktop,
            cliSessionId: 'grand-cli',
            desktopSessionId: 'grand-desktop',
            title: 'Grandchild',
            spawnedFrom: { sessionId: 'child-desktop', sideSession: true, taskId: null, title: 'Grandchild' },
          },
        ],
      }),
    );
    await publish(dbPath, [
      session('cli-id', {
        source: { harnessKey: 'claude', machineId: MACHINE, sourceSessionId: 'cli-id', rootSourceSessionId: 'cli-id' },
      }),
      ...['child-cli', 'grand-cli'].map((id) =>
        session(id, {
          source: { harnessKey: 'claude', machineId: MACHINE, sourceSessionId: id, rootSourceSessionId: id },
        }),
      ),
    ]);
    const threadId = await create(dbPath, [sessionLink('cli-id', 'claude')]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes[0]).toMatchObject({
      title: 'Desktop title',
      question: 'Review this',
      result: 'Ready for review.',
      durationMs: 10_800_000,
      resume: { command: "claude --resume 'cli-id'", cwd: '/fixture/desktop' },
    });
    for (const links of [
      [sessionLink('cli-id', 'claude'), sessionLink('child-cli', 'claude')],
      [sessionLink('child-cli', 'claude'), sessionLink('cli-id', 'claude')],
    ]) {
      const overlapping = await create(dbPath, links);
      const grouped = await run(queryWorkThreadDetail({ dbPath, threadId: overlapping, now: NOW }));
      expect(grouped?.episodes).toHaveLength(1);
      expect(grouped?.episodes[0]?.children[0]?.sourceSessionId).toBe('child-cli');
      expect(grouped?.episodes[0]?.children[0]?.children[0]?.sourceSessionId).toBe('grand-cli');
    }
    const conflicting = await create(dbPath, [sessionLink('cli-id', 'claude'), sessionLink('child-cli', 'claude')]);
    const db = new Database(dbPath);
    try {
      db.query(
        "UPDATE served_report_rows SET source_row_json = json_set(source_row_json, '$.source.parentSourceSessionId', 'different-served-parent') WHERE json_extract(source_row_json, '$.source.sourceSessionId') = 'child-cli'",
      ).run();
    } finally {
      db.close();
    }
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [conflicting] }));
    for (const ordered of [links, [...links].reverse()]) {
      const evidence = await run(queryWorkThreadSessionEvidence({ dbPath, machineId: MACHINE, links: ordered }));
      expect(
        evidence.sessions.find((entry) => entry.member.sourceSessionId === 'child-cli')?.member.parentSourceSessionId,
      ).toBe('different-served-parent');
    }
  });

  test('matches branch markers by repository authority and local session checkouts exactly', async () => {
    const dbPath = await fixture();
    const branch = {
      kind: 'branch' as const,
      key: branchLinkKey({ host: 'github.com', repository: 'fixture/repo', ref: 'feature' }),
    };
    await publish(dbPath, [
      session('branch-session', {
        source: {
          ...session('branch-session').source,
          harnessKey: 'codex',
          sourceSessionId: 'branch-session',
          vcs: {
            branches: [
              {
                name: 'feature',
                provenance: 'harness-recorded',
                firstObservedAt: null,
                lastObservedAt: null,
                webUrl: null,
              },
            ],
            headCommit: null,
            partial: true,
            pullRequests: [],
            repository: {
              host: 'github.com',
              ownerPath: 'fixture/repo',
              provenance: 'harness-recorded',
              webUrl: 'https://github.com/fixture/repo',
            },
          },
        },
      }),
    ]);
    const observation = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/project',
      observedAt: at(-1),
      outcome: 'observed',
      branch: 'feature',
      dirty: true,
    });
    if (observation === null) {
      throw new Error('Invalid checkout fixture');
    }
    await run(importCheckoutStatusObservations({ dbPath, observations: [observation] }));
    const threadId = await create(dbPath, [
      branch,
      sessionLink('branch-session'),
      { kind: 'branch', key: branchLinkKey({ host: 'github.com', repository: 'other/repo', ref: 'feature' }) },
    ]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row.markers.local).toHaveLength(2);
    expect(detail?.row.markers.local.map((marker) => marker.via).sort()).toEqual(['branch-link', 'session-checkout']);
    expect(detail?.row.markers.local[0]?.latestSuccessful?.dirty).toBe(true);
    await command(
      dbPath,
      {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId,
        expectedRevision: 1,
        to: 'done',
        reason: null,
        waitingFor: null,
        waitingOn: null,
        acknowledgedRemainders: [],
      },
      -5,
    );
    const ended = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    // The same checkout reached through branch and session remains one observed fact.
    expect(ended?.row.afterDone).toEqual({ count: 2, latestAt: at(-1) });
  });

  test('Jira sites cannot borrow another authority and source failures remain visible', async () => {
    const dbPath = await fixture();
    const observation = parseJiraIssueObservation({
      machineId: MACHINE,
      key: 'ABC-1',
      observedAt: at(-1),
      outcome: 'observed',
      status: 'Open',
      statusCategory: 'todo',
    });
    if (observation === null) {
      throw new Error('Invalid Jira fixture');
    }
    await run(importJiraIssueObservations({ dbPath, observations: [observation] }));
    await run(importPullRequestObservations({ dbPath, observations: [pr(-1, 'unauthenticated')] }));
    for (const [sourceId, disabled, failed] of [
      ['checkouts.status', true, 0],
      ['github.pull-requests', false, 1],
      ['jira.issues', false, 0],
    ] as const) {
      await run(
        recordWorkFactRun({
          dbPath,
          machineId: MACHINE,
          sourceId,
          disabled,
          failed,
          observed: 0,
          message: 'Fixture run',
          ranAt: NOW,
        }),
      );
    }
    const threadId = await create(dbPath, [
      { kind: 'jira-issue', key: 'jira:default/ABC-1' },
      { kind: 'jira-issue', key: 'jira:another/ABC-1' },
      { kind: 'pull-request', key: 'github.com/fixture/repo#7' },
    ]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row.markers.jiraIssues.find((marker) => marker.key === 'jira:default/ABC-1')?.latest?.status).toBe(
      'Open',
    );
    expect(detail?.row.markers.jiraIssues.find((marker) => marker.key === 'jira:another/ABC-1')?.latest).toBeNull();
    expect(detail?.sources.map((source) => source.state)).toEqual([
      'disabled',
      'unauthenticated',
      'truncated',
      'never-run',
    ]);
  });

  test('bounds children and marks and reports missing linked evidence', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      session('parent'),
      ...Array.from({ length: 25 }, (_, index) =>
        session(`child-${index}`, {
          origin: 'subagent',
          source: {
            harnessKey: 'codex',
            machineId: MACHINE,
            rootSourceSessionId: 'parent',
            parentSourceSessionId: 'parent',
            sourceSessionId: `child-${index}`,
          },
        }),
      ),
    ]);
    const threadId = await create(dbPath, [sessionLink('parent'), sessionLink('missing')], 'Task', -300);
    for (let index = 0; index < 70; index++) {
      await command(dbPath, { commandId: randomUUID(), op: 'rename', threadId, title: `Task ${index}` }, -2);
    }
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes[0]?.children).toHaveLength(WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren);
    expect(detail?.row.marks).toHaveLength(WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow);
    expect(detail?.sources.find((source) => source.source === 'sessions')?.state).toBe('truncated');
    const explicit = await create(dbPath, [
      sessionLink('parent'),
      ...Array.from({ length: 25 }, (_, index) => sessionLink(`child-${index}`)),
    ]);
    const bounded = await run(queryWorkThreadDetail({ dbPath, threadId: explicit, now: NOW }));
    expect(bounded?.episodes).toHaveLength(1);
    expect(bounded?.episodes[0]?.children).toHaveLength(WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren);
    expect(bounded?.sources.find((source) => source.source === 'sessions')?.state).toBe('truncated');
  });

  test('scopes old waiting threads before pagination and measures a 500-thread × 5-link list read', async () => {
    const dbPath = await fixture();
    const old = await create(dbPath, [], 'Find the old wait', -300);
    await command(
      dbPath,
      {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId: old,
        expectedRevision: 1,
        to: 'waiting',
        reason: null,
        waitingFor: 'reply',
        waitingOn: null,
        acknowledgedRemainders: [],
      },
      -299,
    );
    const db = new Database(dbPath);
    try {
      const insert = db.query(
        `INSERT INTO work_threads (thread_id,machine_id,title,objective,project_label,intent,origin,origin_key,follow_state,follow_revision,waiting_for,waiting_on_json,done_at,done_reason,note,created_at,updated_at,last_activity_at) VALUES (?,?,'Fixture task',NULL,'load',NULL,'user',NULL,'following',1,NULL,NULL,NULL,NULL,NULL,?,?,?)`,
      );
      const link = db.query(`INSERT INTO work_thread_links VALUES (?,?,'pull-request',?,'user',?,NULL)`);
      db.transaction(() => {
        for (let index = 0; index < 500; index++) {
          const id = randomUUID();
          insert.run(id, MACHINE, at(-2), at(-2), at(-2));
          for (let key = 0; key < 5; key++) {
            link.run(randomUUID(), id, `github.com/fixture/repo#${index * 5 + key + 1}`, at(-2));
          }
        }
      })();
    } finally {
      db.close();
    }
    const start = performance.now();
    const list = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, limit: 100 }, now: NOW }));
    const elapsed = performance.now() - start;
    console.info(`Work thread list 500 threads x 5 links, 100-row page: ${elapsed.toFixed(1)} ms`);
    expect(list.rows).toHaveLength(100);
    expect(list.rows.every((row) => row.links.length === 5)).toBe(true);
    expect(list.nextCursor).not.toBeNull();
    expect(list.counts).toEqual({ open: 501, done: 0 });
    const selected = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, search: 'old wait' }, now: NOW }));
    expect(selected.rows.map((row) => row.thread.threadId)).toEqual([old]);
    const invalid = await run(
      Effect.either(queryWorkThreadList({ dbPath, query: { ...QUERY, limit: 101 }, now: NOW })),
    );
    expect(invalid._tag).toBe('Left');
  });
});
