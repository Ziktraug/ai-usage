import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  type PullRequestObservation,
  parseCheckoutStatusObservation,
  parseClaudeDesktopSessionObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import {
  branchLinkKey,
  pullRequestLinkKey,
  sessionLinkKey,
  type WorkThreadLinkInput,
  type WorkThreadTaskCommand,
} from '@ai-usage/report-core/work-thread';
import { deriveWorkThreadSituation } from '@ai-usage/report-core/work-thread-situation';
import { WORK_THREAD_VIEW_BOUNDS, type WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import {
  queryServedSessionPullRequestLinks,
  queryWorkThreadLinks,
  queryWorkThreadSessionEvidence,
} from '@ai-usage/usage-store/reader';
import {
  attachDeclaredWorkThreadSessions,
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
const command = async (dbPath: string, input: WorkThreadTaskCommand, hours = -24) => {
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
const claudeDelegating = (id: string, children: readonly string[]): SerializedRow =>
  session(id, {
    harness: 'Claude Code',
    date: at(-6),
    endDate: at(-2),
    activeDate: at(-2),
    durationMs: 60_000,
    name: 'Claude parent',
    sessionLabel: 'Claude parent',
    source: {
      harnessKey: 'claude',
      machineId: MACHINE,
      rootSourceSessionId: id,
      sourceSessionId: id,
      delegatedSessions: children.map((sourceSessionId) => ({ harness: 'codex', sourceSessionId })),
    },
  });
const withBranch = (row: SerializedRow, branch: string | null): SerializedRow => ({
  ...row,
  source: {
    ...row.source,
    harnessKey: row.source?.harnessKey ?? 'codex',
    sourceSessionId: row.source?.sourceSessionId ?? null,
    vcs: {
      branches:
        branch === null
          ? []
          : [
              {
                name: branch,
                provenance: 'harness-recorded',
                firstObservedAt: null,
                lastObservedAt: null,
                webUrl: null,
              },
            ],
      headCommit: null,
      partial: true,
      pullRequests: [],
      repository: null,
    },
  },
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
    headRef: outcome === 'observed' ? 'feature' : null,
    title: outcome === 'observed' ? 'Real linked PR' : null,
  });
  if (value === null) {
    throw new Error('Invalid PR fixture');
  }
  return value;
};

// W2 owns persistence of these optional fields. Enrich the public query result while retaining
// its real SQLite read, so these view regressions also work before that producer change lands.
const withPullRequestDates = async (
  patches: ReadonlyMap<number, Pick<PullRequestObservation, 'createdAt' | 'closedAt'>>,
  use: () => Promise<void>,
): Promise<void> => {
  const reader = await import('@ai-usage/usage-store/reader');
  const original = reader.queryLatestPullRequestObservations;
  const enriched = (observation: PullRequestObservation): PullRequestObservation =>
    observation.outcome === 'observed' ? { ...observation, ...patches.get(observation.number) } : observation;
  const query = spyOn(reader, 'queryLatestPullRequestObservations').mockImplementation((input) =>
    original(input).pipe(
      Effect.map((result) => ({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          latest: enriched(item.latest),
          latestObserved: item.latestObserved === null ? null : enriched(item.latestObserved),
        })),
      })),
    ),
  );
  try {
    await use();
  } finally {
    query.mockRestore();
  }
};

describe('work-thread reader', () => {
  test.each([
    { title: '', expected: null },
    { title: ' \t\n ', expected: null },
    { title: ' '.repeat(WORK_THREAD_VIEW_BOUNDS.maxEpisodeText + 1), expected: null },
    { title: `${' '.repeat(WORK_THREAD_VIEW_BOUNDS.maxEpisodeText + 1)}Visible title  `, expected: 'Visible title' },
  ] as const)('keeps labels usable when a stored title normalizes to $expected', async ({ title, expected }) => {
    const dbPath = await fixture();
    await publish(dbPath, [
      session('root'),
      session('child', {
        source: {
          ...session('child').source,
          harnessKey: 'codex',
          sourceSessionId: 'child',
          parentSourceSessionId: 'root',
          rootSourceSessionId: 'root',
        },
      }),
    ]);
    const stored = new Database(dbPath);
    try {
      stored
        .query(`UPDATE served_report_rows SET source_row_json = json_set(source_row_json, '$.sessionLabel', ?)
        WHERE json_extract(source_row_json, '$.source.sourceSessionId') = 'root'`)
        .run(title);
    } finally {
      stored.close();
    }
    await run(
      importPullRequestObservations({
        dbPath,
        observations: [{ ...pr(-1), title: expected ?? title.slice(0, 16), createdAt: at(-3) }],
      }),
    );
    const threadId = await create(dbPath, [
      sessionLink('root'),
      { kind: 'pull-request', key: 'github.com/fixture/repo#7' },
    ]);
    await command(dbPath, {
      commandId: randomUUID(),
      op: 'set-follow-state',
      threadId,
      expectedRevision: 1,
      to: 'waiting',
      waitingFor: 'A response',
      waitingOn: null,
      reason: null,
      acknowledgedRemainders: [],
    });
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(detail?.episodes[0]?.title).toBe(expected);
    expect(detail?.episodes[0]?.children[0]?.launchedBy?.title).toBe(expected);
    expect(detail?.factEvents[0]).toMatchObject({ label: 'PR #7', title: expected });
    expect(detail?.row.marks.map((mark) => mark.label)).toEqual([
      'Waiting',
      'PR #7 opened',
      expected ?? 'Session root',
    ]);
    expect(list.rows[0]).toEqual(detail?.row);
    expect(detail?.row.marks.every((mark) => mark.label !== null && mark.label.trim().length > 0)).toBe(true);
  });

  test.each([
    { desktopTitle: '', servedTitle: 'Served title', expected: 'Served title' },
    { desktopTitle: ' \t ', servedTitle: '\n ', expected: null },
  ])(
    'treats a blank Desktop title as absent before the served fallback ($expected)',
    async ({ desktopTitle, servedTitle, expected }) => {
      const dbPath = await fixture();
      const desktop = parseClaudeDesktopSessionObservation({
        accountDirectory: 'account',
        archived: false,
        branch: null,
        cliSessionId: 'root',
        completedTurns: 1,
        createdAt: at(-2),
        cwd: '/fixture/project',
        declaredPullRequests: [],
        desktopSessionId: 'desktop-root',
        effort: null,
        fileModifiedAt: at(-1),
        filePath: 'account/root.json',
        format: 'claude-desktop-session-v1',
        lastActivityAt: at(-1),
        lastTurnReport: null,
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
        turnSummary: null,
        unsupportedReason: null,
        worktreePath: null,
        wrapUpDescription: null,
        writtenBranches: [],
      });
      if (desktop === null) {
        throw new Error('Invalid Desktop title fixture');
      }
      await run(
        importClaudeDesktopSessions({
          dbPath,
          machineId: MACHINE,
          collectedAt: NOW,
          completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
          observations: [desktop],
        }),
      );
      await publish(dbPath, [claudeDelegating('root', ['child']), session('child')]);
      const stored = new Database(dbPath);
      try {
        stored.query('UPDATE claude_desktop_sessions SET title = ? WHERE cli_session_id = ?').run(desktopTitle, 'root');
        stored
          .query(`UPDATE served_report_rows SET source_row_json = json_set(source_row_json, '$.sessionLabel', ?)
        WHERE json_extract(source_row_json, '$.source.sourceSessionId') = 'root'`)
          .run(servedTitle);
      } finally {
        stored.close();
      }
      const threadId = await create(dbPath, [sessionLink('root', 'claude')]);
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(detail?.episodes[0]?.title).toBe(expected);
      expect(detail?.episodes[0]?.children[0]?.launchedBy?.title).toBe(expected);
      expect(detail?.row.marks[0]?.label).toBe(expected ?? 'Session root');
    },
  );

  test('keeps recorded active time independent from a multi-day Desktop span', async () => {
    const dbPath = await fixture();
    const desktop = parseClaudeDesktopSessionObservation({
      accountDirectory: 'account',
      archived: false,
      branch: null,
      cliSessionId: 'long-session',
      completedTurns: 2,
      createdAt: at(-76.25),
      cwd: '/fixture/project',
      declaredPullRequests: [],
      desktopSessionId: 'desktop-long-session',
      effort: null,
      fileModifiedAt: at(-1),
      filePath: 'account/long-session.json',
      format: 'claude-desktop-session-v1',
      lastActivityAt: at(-1),
      lastTurnReport: null,
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
      title: 'Long-lived conversation',
      titleSource: 'auto',
      turnSummary: null,
      unsupportedReason: null,
      worktreePath: null,
      wrapUpDescription: null,
      writtenBranches: [],
    });
    if (desktop === null) {
      throw new Error('Invalid long-lived Desktop fixture');
    }
    await run(
      importClaudeDesktopSessions({
        dbPath,
        machineId: MACHINE,
        collectedAt: NOW,
        completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
        observations: [desktop],
      }),
    );
    await publish(dbPath, [
      session('long-session', {
        durationMs: 93_000,
        source: { ...session('long-session').source, harnessKey: 'claude', sourceSessionId: 'long-session' },
      }),
      session('no-duration', { durationMs: null }),
      session('zero-duration', { durationMs: 0 }),
    ]);
    const legacyStore = new Database(dbPath);
    try {
      legacyStore
        .query(`UPDATE served_report_rows SET source_row_json = json_remove(source_row_json, '$.durationMs')
        WHERE json_extract(source_row_json, '$.source.sourceSessionId') = ?`)
        .run('no-duration');
    } finally {
      legacyStore.close();
    }
    const threadId = await create(dbPath, [
      sessionLink('long-session', 'claude'),
      sessionLink('no-duration'),
      sessionLink('zero-duration'),
    ]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes.find((episode) => episode.sourceSessionId === 'long-session')).toMatchObject({
      activeMs: 93_000,
      spanMs: 75.25 * 3_600_000,
      startedAt: at(-76.25),
      endedAt: at(-1),
    });
    expect(detail?.episodes.find((episode) => episode.sourceSessionId === 'no-duration')).toMatchObject({
      activeMs: null,
      spanMs: 3_600_000,
    });
    expect(detail?.episodes.find((episode) => episode.sourceSessionId === 'zero-duration')?.activeMs).toBe(0);
    expect(detail?.row.firstActivityAt).toBe(at(-76.25));
  });

  test('marks one linked root rather than its twenty delegated children', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      session('root', { name: 'Investigate the parser', sessionLabel: 'Investigate the parser' }),
      ...Array.from({ length: 20 }, (_, index) =>
        session(`delegate-${index}`, {
          source: {
            ...session(`delegate-${index}`).source,
            harnessKey: 'codex',
            sourceSessionId: `delegate-${index}`,
            parentSourceSessionId: 'root',
            rootSourceSessionId: 'root',
          },
        }),
      ),
    ]);
    const threadId = await create(dbPath, [sessionLink('root')]);
    await command(dbPath, { commandId: randomUUID(), op: 'rename', threadId, title: 'Updated task title' }, -1);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(detail?.row.marks).toEqual([
      { at: at(-2), harness: 'codex', kind: 'session', label: 'Investigate the parser' },
    ]);
    expect(list.rows[0]).toEqual(detail?.row);
  });

  test('places PR-only opening and merge facts in the thread and week without inventing dates', async () => {
    const dbPath = await fixture();
    const threadId = await create(dbPath, [{ kind: 'pull-request', key: 'github.com/fixture/repo#7' }], 'PR work', -1);
    await run(
      importPullRequestObservations({
        dbPath,
        observations: [{ ...pr(-2), state: 'MERGED', mergedAt: at(-3) }, pr(0, 'timeout')],
      }),
    );
    await withPullRequestDates(new Map([[7, { createdAt: at(-72), closedAt: at(-3) }]]), async () => {
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      expect(detail?.factEvents).toEqual([
        {
          at: at(-72),
          key: 'github.com/fixture/repo#7',
          kind: 'pull-request-opened',
          label: 'PR #7',
          title: 'Real linked PR',
        },
        {
          at: at(-3),
          key: 'github.com/fixture/repo#7',
          kind: 'pull-request-merged',
          label: 'PR #7',
          title: 'Real linked PR',
        },
      ]);
      expect(detail?.row.marks).toEqual([
        { at: at(-72), harness: null, kind: 'event', label: 'PR #7 opened' },
        { at: at(-3), harness: null, kind: 'event', label: 'PR #7 merged' },
      ]);
      expect(detail?.row.firstActivityAt).toBe(at(-72));
      expect(list.rows[0]).toEqual(detail?.row);
    });
    const legacy = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(legacy?.factEvents.map((event) => event.kind)).toEqual(['pull-request-merged']);
    expect(legacy?.row.firstActivityAt).toBe(at(-1));
  });

  test('dates the work from the earliest linked evidence and ignores detached evidence', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      session('old', { date: at(-500), endDate: at(-400), activeDate: at(-400) }),
      session('linked', { date: at(-100) }),
    ]);
    const threadId = await create(
      dbPath,
      [sessionLink('old'), sessionLink('linked'), { kind: 'pull-request', key: 'github.com/fixture/repo#7' }],
      'Origins',
      -24,
    );
    await run(importPullRequestObservations({ dbPath, observations: [pr(-1)] }));
    const history = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    const oldest = history.find((link) => link.key === sessionLink('old').key);
    if (!oldest) {
      throw new Error('Missing oldest session link');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: oldest.linkId });
    await withPullRequestDates(new Map([[7, { createdAt: at(-300) }]]), async () => {
      const dated = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(dated?.row.firstActivityAt).toBe(at(-300));
      expect(dated?.factEvents[0]?.at).toBe(at(-300));
      expect(dated?.row.marks.every((mark) => mark.at !== at(-300))).toBe(true);
      const linkedPr = history.find((link) => link.kind === 'pull-request');
      if (!linkedPr) {
        throw new Error('Missing pull request link');
      }
      await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: linkedPr.linkId });
      const detached = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      expect(detached?.row.firstActivityAt).toBe(at(-100));
      expect(detached?.factEvents).toEqual([]);
      expect(list.rows[0]).toEqual(detached?.row);
    });
  });

  test('emits a closed fact only when not merged and deduplicates legacy qualified PR aliases', async () => {
    const dbPath = await fixture();
    const threadId = await create(dbPath, [{ kind: 'pull-request', key: 'github.com/fixture/repo#7' }]);
    await run(importPullRequestObservations({ dbPath, observations: [{ ...pr(-1), state: 'CLOSED' }] }));
    const database = new Database(dbPath);
    try {
      database
        .query(
          'INSERT INTO work_thread_links (link_id, thread_id, kind, link_key, provenance, created_at, detached_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), threadId, 'pull-request', 'GitHub.COM/Fixture/Repo#7', 'declared', at(-2), null);
    } finally {
      database.close();
    }
    await withPullRequestDates(new Map([[7, { createdAt: at(-12), closedAt: at(-3) }]]), async () => {
      const closed = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(closed?.factEvents.map((event) => [event.kind, event.at])).toEqual([
        ['pull-request-opened', at(-12)],
        ['pull-request-closed', at(-3)],
      ]);
      await run(
        importPullRequestObservations({ dbPath, observations: [{ ...pr(0), state: 'MERGED', mergedAt: null }] }),
      );
      const mergedWithoutDate = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(mergedWithoutDate?.factEvents.map((event) => event.kind)).toEqual(['pull-request-opened']);
    });
  });

  test('keeps newest week marks and both kinds when follow-state changes crowd the lane', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [session('root', { date: at(-100) })]);
    const threadId = await create(dbPath, [sessionLink('root')], 'Many changes', -150);
    for (let index = 0; index < 70; index++) {
      await command(
        dbPath,
        {
          commandId: randomUUID(),
          op: 'set-follow-state',
          threadId,
          expectedRevision: index + 1,
          to: index % 2 === 0 ? 'waiting' : 'following',
          waitingFor: index % 2 === 0 ? 'An answer' : null,
          waitingOn: null,
          reason: null,
          acknowledgedRemainders: [],
        },
        -70 + index,
      );
    }
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(detail?.row.marks).toHaveLength(WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow);
    expect(detail?.row.marks.filter((mark) => mark.kind === 'session')).toEqual([
      { at: at(-100), harness: 'codex', kind: 'session', label: 'root' },
    ]);
    expect(detail?.row.marks.filter((mark) => mark.kind === 'event').map((mark) => mark.at)).toEqual(
      Array.from({ length: 63 }, (_, index) => at(-63 + index)),
    );
    expect(detail?.row.marks.at(-1)?.label).toBe('Following');
    expect(list.rows[0]).toEqual(detail?.row);
  });

  test('preserves the newest event when session starts fill the week mark bound', async () => {
    const dbPath = await fixture();
    const rows = Array.from({ length: 64 }, (_, index) => session(`root-${index}`, { date: at(-64 + index) }));
    await publish(dbPath, rows);
    const threadId = await create(
      dbPath,
      rows.map((row) => sessionLink(row.source?.sourceSessionId ?? '')),
      'Many sessions',
      -150,
    );
    await command(
      dbPath,
      {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId,
        expectedRevision: 1,
        to: 'waiting',
        waitingFor: 'Feedback',
        waitingOn: null,
        reason: null,
        acknowledgedRemainders: [],
      },
      -90,
    );
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(detail?.row.marks).toHaveLength(WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow);
    expect(detail?.row.marks.filter((mark) => mark.kind === 'event')).toEqual([
      { at: at(-90), harness: null, kind: 'event', label: 'Waiting' },
    ]);
    expect(detail?.row.marks.filter((mark) => mark.kind === 'session').map((mark) => mark.at)).toEqual(
      Array.from({ length: 63 }, (_, index) => at(-63 + index)),
    );
    expect(list.rows[0]).toEqual(detail?.row);
  });

  test.each([false, true])(
    'unfolds attested Codex sessions with independent time and no duplicate roots (direct link: %s)',
    async (direct) => {
      const dbPath = await fixture();
      await publish(dbPath, [
        claudeDelegating('claude-parent', ['codex-one', 'codex-two']),
        session('codex-one', {
          origin: 'human',
          durationMs: 12_000,
          date: at(-5),
          endDate: at(-4),
          activeDate: at(-4),
        }),
        session('codex-two', { durationMs: null, date: at(-4), endDate: at(-2), activeDate: at(-2) }),
      ]);
      const threadId = await create(dbPath, [
        sessionLink('claude-parent', 'claude'),
        ...(direct ? [sessionLink('codex-one')] : []),
      ]);
      const separate = await create(dbPath, [sessionLink('codex-one')], 'Independent follow-up');
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      expect(detail?.episodes).toHaveLength(1);
      expect(detail?.episodes[0]).toMatchObject({
        sourceSessionId: 'claude-parent',
        harness: 'claude',
        activeMs: 60_000,
        spanMs: 14_400_000,
      });
      const children = detail?.episodes[0]?.children ?? [];
      expect(children).toHaveLength(2);
      expect(children.find((child) => child.sourceSessionId === 'codex-one')).toMatchObject({
        harness: 'codex',
        origin: 'delegated',
        launchedBy: { harness: 'claude', title: 'Claude parent' },
        activeMs: 12_000,
        spanMs: 3_600_000,
      });
      expect(children.find((child) => child.sourceSessionId === 'codex-two')).toMatchObject({
        harness: 'codex',
        origin: 'delegated',
        launchedBy: { harness: 'claude', title: 'Claude parent' },
        activeMs: null,
        spanMs: 7_200_000,
      });
      expect(detail?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 2 });
      expect(detail?.row.marks).toEqual([{ at: at(-6), harness: 'claude', kind: 'session', label: 'Claude parent' }]);
      expect(detail?.sources.find((source) => source.source === 'sessions')?.state).toBe('ok');
      expect(list.rows.find((row) => row.thread.threadId === threadId)).toEqual(detail?.row);
      const independent = await run(queryWorkThreadDetail({ dbPath, threadId: separate, now: NOW }));
      expect(independent?.episodes).toHaveLength(1);
      expect(independent?.episodes[0]).toMatchObject({
        sourceSessionId: 'codex-one',
        origin: 'human',
        launchedBy: null,
        activeMs: 12_000,
      });
      expect(independent?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 0 });
    },
  );

  test.each([false, true])(
    'reports unserved attested Codex identities as unavailable without an invented child (other machine: %s)',
    async (otherMachine) => {
      const dbPath = await fixture();
      const remote = session('unavailable', {
        source: {
          harnessKey: 'codex',
          machineId: 'other-machine',
          sourceSessionId: 'unavailable',
          rootSourceSessionId: 'unavailable',
        },
      });
      await publish(dbPath, [claudeDelegating('claude-parent', ['unavailable']), ...(otherMachine ? [remote] : [])]);
      const threadId = await create(dbPath, [sessionLink('claude-parent', 'claude')]);
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(detail?.episodes).toHaveLength(1);
      expect(detail?.episodes[0]?.children).toEqual([]);
      expect(detail?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 0 });
      expect(detail?.sources.find((source) => source.source === 'sessions')?.state).toBe('truncated');
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      expect(list.rows[0]).toEqual(detail?.row);
      expect(list.sources.find((source) => source.source === 'sessions')?.state).toBe('truncated');
    },
  );

  test('keeps native Codex parentage within an attested Claude delegation', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      claudeDelegating('claude-parent', ['codex-parent', 'codex-child']),
      session('codex-parent'),
      session('codex-child', {
        source: {
          harnessKey: 'codex',
          machineId: MACHINE,
          sourceSessionId: 'codex-child',
          parentSourceSessionId: 'codex-parent',
          rootSourceSessionId: 'codex-parent',
        },
      }),
    ]);
    const threadId = await create(dbPath, [sessionLink('claude-parent', 'claude'), sessionLink('codex-child')]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes).toHaveLength(1);
    expect(detail?.episodes[0]?.children).toHaveLength(1);
    expect(detail?.episodes[0]?.children[0]).toMatchObject({
      sourceSessionId: 'codex-parent',
      launchedBy: { harness: 'claude', title: 'Claude parent' },
      children: [
        {
          sourceSessionId: 'codex-child',
          origin: 'delegated',
          launchedBy: { harness: 'codex', title: 'codex-parent' },
        },
      ],
    });
    expect(detail?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 2 });
    expect(detail?.row.marks).toHaveLength(1);
    expect(detail?.sources.find((source) => source.source === 'sessions')?.state).toBe('ok');
  });

  test.each(['missing-parent', 'self-cycle', 'cycle'])(
    'does not replace unresolved native Codex lineage with a Claude launch (%s)',
    async (variant) => {
      const dbPath = await fixture();
      const child = session('codex-child', {
        source: {
          harnessKey: 'codex',
          machineId: MACHINE,
          sourceSessionId: 'codex-child',
          rootSourceSessionId: 'codex-child',
          parentSourceSessionId: {
            'missing-parent': 'unserved-parent',
            'self-cycle': 'codex-child',
            cycle: 'codex-other',
          }[variant],
        },
      });
      const other = session('codex-other', {
        source: {
          harnessKey: 'codex',
          machineId: MACHINE,
          sourceSessionId: 'codex-other',
          rootSourceSessionId: 'codex-other',
          parentSourceSessionId: 'codex-child',
        },
      });
      await publish(dbPath, [
        claudeDelegating('claude-parent', variant === 'cycle' ? ['codex-child', 'codex-other'] : ['codex-child']),
        child,
        ...(variant === 'cycle' ? [other] : []),
      ]);
      const threadId = await create(dbPath, [sessionLink('claude-parent', 'claude'), sessionLink('codex-child')]);
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(detail?.episodes.map((episode) => episode.sourceSessionId)).toEqual(['claude-parent']);
      expect(detail?.episodes[0]?.children).toEqual([]);
      expect(detail?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 0 });
      expect(detail?.row.marks).toEqual([{ at: at(-6), harness: 'claude', kind: 'session', label: 'Claude parent' }]);
      expect(detail?.sources.find((source) => source.source === 'sessions')?.state).toBe('truncated');
    },
  );

  test('honors thread-local detachment of attested Codex children and their Claude parent', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [claudeDelegating('claude-parent', ['codex-one']), session('codex-one')]);
    const threadId = await create(dbPath, [sessionLink('claude-parent', 'claude'), sessionLink('codex-one')]);
    const other = await create(dbPath, [sessionLink('claude-parent', 'claude')]);
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    const child = links.find((link) => link.key === sessionLink('codex-one').key);
    const parent = links.find((link) => link.key === sessionLink('claude-parent', 'claude').key);
    if (!(child && parent)) {
      throw new Error('Missing delegation fixture links');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: child.linkId });
    const detached = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detached?.episodes[0]?.children).toEqual([]);
    expect(detached?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 0 });
    const sibling = await run(queryWorkThreadDetail({ dbPath, threadId: other, now: NOW }));
    expect(sibling?.episodes[0]?.children.map((episode) => episode.sourceSessionId)).toEqual(['codex-one']);
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: parent.linkId });
    const empty = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(empty?.episodes).toEqual([]);
    expect(empty?.row).toMatchObject({ sessionCount: 0, delegatedSessionCount: 0 });
    expect(empty?.row.marks).toEqual([]);
  });

  test('counts linked episodes separately from distinct delegated children at every rendered depth', async () => {
    const dbPath = await fixture();
    const descendants = Array.from({ length: 20 }, (_, i) =>
      session(`child-${i}`, {
        source: {
          ...session(`child-${i}`).source,
          harnessKey: 'codex',
          sourceSessionId: `child-${i}`,
          parentSourceSessionId: 'root',
          rootSourceSessionId: 'root',
        },
      }),
    );
    const grandchild = session('grandchild', {
      source: {
        ...session('grandchild').source,
        harnessKey: 'codex',
        sourceSessionId: 'grandchild',
        parentSourceSessionId: 'child-0',
        rootSourceSessionId: 'root',
      },
    });
    await publish(dbPath, [session('root'), ...descendants, grandchild]);
    const one = await create(dbPath, [sessionLink('root')]);
    const two = await create(dbPath, [sessionLink('root'), sessionLink('child-0')]);
    for (const [threadId, linked, delegated] of [
      [one, 1, 20],
      [two, 2, 20],
    ] as const) {
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      for (const row of [detail?.row, list.rows.find((candidate) => candidate.thread.threadId === threadId)]) {
        expect(row).toMatchObject({ sessionCount: linked, delegatedSessionCount: delegated });
      }
      if (threadId === two) {
        expect(
          detail?.episodes[0]?.children.find((child) => child.sourceSessionId === 'child-0')?.children,
        ).toMatchObject([{ sourceSessionId: 'grandchild' }]);
      }
    }
  });

  test.each([
    { head: 'feat/x', checkout: 'main', recorded: 'main', expected: 0 },
    { head: 'refs/heads/feat/x', checkout: 'feat/x', recorded: 'main', expected: 1 },
    { head: 'feat/x', checkout: 'refs/heads/feat/x', recorded: null, expected: 1 },
    { head: 'feat/x', checkout: 'Feat/x', recorded: 'Feat/x', expected: 0 },
    { head: null, checkout: 'feat/x', recorded: 'feat/x', expected: 0 },
    { head: 'feat/x', checkout: null, recorded: 'feat/x', expected: 0 },
  ])(
    'keeps PR session checkouts only on the observed head branch: $head / $checkout',
    async ({ head, checkout, recorded, expected }) => {
      const dbPath = await fixture();
      await publish(dbPath, [withBranch(session('declaring'), recorded)]);
      const threadId = await create(dbPath, [
        sessionLink('declaring'),
        { kind: 'pull-request', key: 'github.com/fixture/repo#7' },
      ]);
      await run(
        importPullRequestObservations({ dbPath, observations: [{ ...pr(-3), headRef: head }, pr(-1, 'timeout')] }),
      );
      const observation = parseCheckoutStatusObservation({
        machineId: MACHINE,
        checkoutPath: '/fixture/project',
        outcome: 'observed',
        observedAt: at(-2),
        branch: checkout,
        untrackedCount: 2,
      });
      if (!observation) {
        throw new Error('Invalid branch checkout');
      }
      await run(importCheckoutStatusObservations({ dbPath, observations: [observation] }));
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      expect(detail?.episodes).toHaveLength(1);
      for (const row of [detail?.row, list.rows[0]]) {
        expect(row?.markers.local).toHaveLength(expected);
      }
      if (expected === 1) {
        await run(
          importCheckoutStatusObservations({
            dbPath,
            observations: [{ ...observation, observedAt: at(0), outcome: 'timeout', branch: null }],
          }),
        );
        expect((await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.row.markers.local).toMatchObject([
          { latest: { outcome: 'timeout' }, latestSuccessful: observation, via: 'session-checkout' },
        ]);
      }
    },
  );

  test.each([
    { outcome: 'timeout', stale: false },
    { outcome: 'invalid', stale: false },
    { outcome: 'timeout', stale: true },
    { outcome: 'invalid', stale: true },
  ] as const)('retains failed session checkout evidence ($outcome, stale: $stale)', async ({ outcome, stale }) => {
    const dbPath = await fixture();
    await publish(dbPath, [withBranch(session('local-session'), 'refs/heads/feat/x')]);
    await run(importPullRequestObservations({ dbPath, observations: [{ ...pr(-3), headRef: 'feat/x' }] }));
    const threadIds = [
      await create(dbPath, [sessionLink('local-session')]),
      await create(dbPath, [sessionLink('local-session'), { kind: 'pull-request', key: 'github.com/fixture/repo#7' }]),
    ];
    const successful = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/project',
      observedAt: at(stale ? -200 : -2),
      outcome: 'observed',
      branch: 'feat/x',
      dirty: false,
      ahead: 0,
    });
    const failed = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/project',
      observedAt: at(-1),
      outcome,
    });
    if (successful === null || failed === null) {
      throw new Error('Invalid failed session checkout fixture');
    }
    await run(importCheckoutStatusObservations({ dbPath, observations: [successful, failed] }));
    for (const threadId of threadIds) {
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
      expect(detail?.row.markers.local).toEqual([
        {
          key: sessionLink('local-session').key,
          latest: failed,
          latestSuccessful: successful,
          via: 'session-checkout',
        },
      ]);
      expect(list.rows.find((row) => row.thread.threadId === threadId)?.markers.local).toEqual(
        detail?.row.markers.local,
      );
      if (detail === null) {
        throw new Error('Missing checkout task');
      }
      const situation = deriveWorkThreadSituation(detail.row, at(0));
      expect(situation.remainders).toContainEqual({
        key: sessionLink('local-session').key,
        source: 'local',
        kind: 'source-unavailable',
        observedAt: failed.observedAt,
        outcome,
      });
      expect(situation.remainders.some((remainder) => remainder.kind === 'source-stale')).toBe(stale);
      expect(situation.hint).not.toBe('ready-to-close');
    }
    for (const newer of [
      { ...successful, observedAt: at(-0.5), branch: 'main' },
      { ...failed, observedAt: at(0) },
    ]) {
      await run(importCheckoutStatusObservations({ dbPath, observations: [newer] }));
      for (const threadId of threadIds) {
        expect((await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.row.markers.local).toEqual([]);
      }
    }
  });

  test('analysis checkouts require a matching recorded branch and retain the matching session identity', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      withBranch(session('wrong'), 'main'),
      withBranch(session('right'), 'refs/heads/feat/x'),
      withBranch(session('unknown'), null),
    ]);
    const mismatch = await create(dbPath, [sessionLink('wrong'), sessionLink('unknown')]);
    const match = await create(dbPath, [sessionLink('wrong'), sessionLink('right')]);
    const observation = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/project',
      outcome: 'observed',
      observedAt: at(-1),
      branch: 'feat/x',
    });
    if (!observation) {
      throw new Error('Invalid analysis checkout');
    }
    await run(importCheckoutStatusObservations({ dbPath, observations: [observation] }));
    for (const threadId of [mismatch, match]) {
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(detail?.episodes).toHaveLength(2);
      expect(detail?.row.markers.local).toHaveLength(threadId === match ? 1 : 0);
      if (threadId === match) {
        expect(detail?.row.markers.local[0]?.key).toBe(sessionLink('right').key);
      }
    }
  });
  test('empty data does not turn unrun sources into success, and a missing store fails', async () => {
    const dbPath = await fixture();
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(list.rows).toEqual([]);
    expect(list.sources.map((source) => source.state)).toEqual(['never-run', 'never-run', 'never-run', 'never-run']);
    expect(list.machineId).toBe(MACHINE);
    expect(await run(queryWorkThreadDetail({ dbPath, threadId: randomUUID(), now: NOW }))).toBeNull();
    const missing = await run(
      Effect.result(
        queryWorkThreadList({ dbPath: path.join(path.dirname(dbPath), 'missing'), query: QUERY, now: NOW }),
      ),
    );
    expect(missing._tag).toBe('Failure');
    if (missing._tag === 'Failure') {
      expect(missing.failure.reason).toBe('store-missing');
    }
    await publish(dbPath, [session('unlinked')]);
    const published = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(published.rows).toEqual([]);
    expect(published.sources.find((source) => source.source === 'sessions')).toMatchObject({
      state: 'ok',
      lastRunAt: at(0),
    });
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
    await run(
      importPullRequestObservations({ dbPath, observations: [{ ...pr(-8), updatedAt: at(-8) }, pr(-2, 'timeout')] }),
    );
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row.markers.pullRequests[0]).toMatchObject({
      latest: { outcome: 'timeout' },
      latestSuccessful: { outcome: 'observed' },
      mergeable: null,
      mergeStateStatus: null,
      role: null,
    });
    expect(detail?.row.afterDone).toEqual({ count: 1, latestAt: at(-8) });
    expect(detail?.row.thread.followState).toBe('done');
    expect(detail?.row.lastActivityAt).toBe(at(-8));
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

  test('polls and failures do not become activity after Done, but source changes do', async () => {
    const dbPath = await fixture();
    const threadId = await create(dbPath, [
      { kind: 'pull-request', key: 'github.com/fixture/repo#7' },
      { kind: 'jira-issue', key: 'jira:default/ACT-1' },
      sessionLink('old-session'),
    ]);
    await publish(dbPath, [session('old-session', { activeDate: at(-20), endDate: at(-20), date: at(-21) })]);
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
      -10,
    );
    const checkout = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/project',
      outcome: 'observed',
      observedAt: at(-8),
      branch: 'feature',
      modifiedCount: 1,
      stagedCount: 0,
      untrackedCount: 0,
      ahead: 0,
      behind: 0,
      lastCommitAt: at(-20),
    });
    const jira = parseJiraIssueObservation({
      machineId: MACHINE,
      key: 'ACT-1',
      outcome: 'observed',
      observedAt: at(-8),
      updatedAt: at(-20),
    });
    if (checkout === null || jira === null) {
      throw new Error('Invalid activity fixture');
    }
    await run(
      importCheckoutStatusObservations({ dbPath, observations: [checkout, { ...checkout, observedAt: at(-7) }] }),
    );
    await run(importJiraIssueObservations({ dbPath, observations: [jira, { ...jira, observedAt: at(-6) }] }));
    await run(
      importPullRequestObservations({ dbPath, observations: [{ ...pr(-8), updatedAt: at(-20) }, pr(-1, 'timeout')] }),
    );
    const unchanged = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(unchanged?.row.afterDone).toBeNull();
    expect(unchanged?.row.lastActivityAt).toBe(at(-10));
    await run(
      importCheckoutStatusObservations({
        dbPath,
        observations: [
          { ...checkout, observedAt: at(-5), modifiedCount: 2 },
          { ...checkout, observedAt: at(-2), modifiedCount: 2 },
        ],
      }),
    );
    await run(
      importJiraIssueObservations({ dbPath, observations: [{ ...jira, observedAt: at(-1), updatedAt: at(-4) }] }),
    );
    await run(
      importPullRequestObservations({
        dbPath,
        observations: [{ ...pr(0), state: 'MERGED', mergedAt: at(-3), updatedAt: at(-20) }],
      }),
    );
    for (const row of [
      (await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.row,
      (await run(queryWorkThreadList({ dbPath, query: { ...QUERY, tab: 'done' }, now: NOW }))).rows[0],
    ]) {
      expect(row?.afterDone).toEqual({ count: 3, latestAt: at(-3) });
      expect(row?.lastActivityAt).toBe(at(-3));
    }
  });

  test('backfilled checkout changes before Done remove the previously newer activity', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      withBranch(session('old-session', { date: at(-21), activeDate: at(-20), endDate: at(-20) }), 'feature'),
    ]);
    const threadId = await create(dbPath, [sessionLink('old-session')]);
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
      -0.5,
    );
    const observation = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/project',
      observedAt: at(-2),
      outcome: 'observed',
      branch: 'feature',
      modifiedCount: 0,
      lastCommitAt: at(-20),
    });
    if (observation === null) {
      throw new Error('Invalid checkout fixture');
    }
    await run(
      importCheckoutStatusObservations({
        dbPath,
        observations: [observation, { ...observation, observedAt: at(0), modifiedCount: 1 }],
      }),
    );
    expect((await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.row.afterDone).toEqual({
      count: 1,
      latestAt: at(0),
    });
    await run(
      importCheckoutStatusObservations({
        dbPath,
        observations: [{ ...observation, observedAt: at(-1), modifiedCount: 1 }],
      }),
    );
    for (const row of [
      (await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.row,
      (await run(queryWorkThreadList({ dbPath, query: { ...QUERY, tab: 'done' }, now: NOW }))).rows[0],
    ]) {
      expect(row?.afterDone).toBeNull();
      expect(row?.lastActivityAt).toBe(at(-0.5));
    }
  });

  test('deduplicates checkout paths before the 64-marker bound and exposes omissions', async () => {
    const dbPath = await fixture();
    const parents = Array.from({ length: 4 }, (_, i) => `parent-${i}`);
    const rows = parents.flatMap((parent, i) => [
      session(parent),
      ...Array.from({ length: 20 }, (_, child) =>
        session(`${parent}-${child}`, {
          source: {
            ...session(`${parent}-${child}`).source,
            harnessKey: 'codex',
            sourceSessionId: `${parent}-${child}`,
            rootSourceSessionId: parent,
            parentSourceSessionId: parent,
            sourcePath: `/fixture/${i}-${child}`,
          },
        }),
      ),
    ]);
    await publish(
      dbPath,
      rows.map((row) => withBranch(row, 'feature')),
    );
    await run(
      importCheckoutStatusObservations({
        dbPath,
        observations: [...new Set(rows.map((row) => row.source?.sourcePath))].map((checkoutPath) => ({
          machineId: MACHINE,
          checkoutPath,
          observedAt: at(-1),
          outcome: 'observed',
          branch: 'feature',
        })),
      }),
    );
    const threadId = await create(
      dbPath,
      parents.map((parent) => sessionLink(parent)),
    );
    for (const result of [
      await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })),
      await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW })),
    ]) {
      const row = result && ('row' in result ? result.row : result.rows[0]);
      expect(row?.markers.local).toHaveLength(64);
      expect(result?.sources.find((source) => source.source === 'checkouts')?.state).toBe('truncated');
    }
    await run(
      recordWorkFactRun({
        dbPath,
        machineId: MACHINE,
        sourceId: 'checkouts.status',
        disabled: false,
        failed: 1,
        observed: 63,
        message: 'One git read timed out; additional checkout markers were omitted.',
        ranAt: NOW,
      }),
    );
    for (const result of [
      await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })),
      await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW })),
    ]) {
      expect(result?.sources.find((source) => source.source === 'checkouts')).toMatchObject({
        state: 'failed',
        message: 'One git read timed out; additional checkout markers were omitted.',
      });
    }
  });

  test.each(['missing', 'not-a-repository', 'timeout', 'denied', 'invalid'] as const)(
    'keeps the %s checkout fact separate from the source run outcome',
    async (outcome) => {
      const dbPath = await fixture();
      await publish(dbPath, [session('local-session')]);
      const threadId = await create(dbPath, [sessionLink('local-session')]);
      const observation = parseCheckoutStatusObservation({
        machineId: MACHINE,
        checkoutPath: '/fixture/project',
        observedAt: at(-1),
        outcome,
      });
      if (observation === null) {
        throw new Error('Invalid checkout outcome fixture');
      }
      await run(importCheckoutStatusObservations({ dbPath, observations: [observation] }));
      const failed = outcome === 'missing' || outcome === 'not-a-repository' ? 0 : 1;
      const message = failed === 0 ? '1 known path no longer exists or is not a repository.' : 'One git read failed.';
      await run(
        recordWorkFactRun({
          dbPath,
          machineId: MACHINE,
          sourceId: 'checkouts.status',
          disabled: false,
          failed,
          observed: 0,
          message,
          ranAt: NOW,
        }),
      );
      for (const result of [
        await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })),
        await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW })),
      ]) {
        const row = result && ('row' in result ? result.row : result.rows[0]);
        expect(row?.markers.local).toEqual([]);
        expect(result?.sources.find((source) => source.source === 'checkouts')).toMatchObject({
          state: failed === 0 ? 'ok' : 'failed',
          message,
        });
      }
    },
  );

  test.each(['never-run', 'ok', 'unauthenticated', 'failed', 'disabled'] as const)(
    'returns the newest 64 detached links without hiding the %s source state',
    async (state) => {
      const dbPath = await fixture();
      const threadId = await create(dbPath);
      if (state !== 'never-run') {
        await run(
          recordWorkFactRun({
            dbPath,
            machineId: MACHINE,
            sourceId: 'github.pull-requests',
            disabled: state === 'disabled',
            failed: state === 'failed' || state === 'unauthenticated' ? 1 : 0,
            observed: state === 'ok' ? 1 : 0,
            ranAt: NOW,
            message: 'Fixture collection result.',
            outcomeCode: state === 'unauthenticated' ? 'unauthenticated' : null,
          }),
        );
      }
      const db = new Database(dbPath);
      try {
        for (let i = 0; i < 70; i++) {
          db.query(
            'INSERT INTO work_thread_links (link_id, thread_id, kind, link_key, provenance, created_at, detached_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(randomUUID(), threadId, 'pull-request', `github.com/fixture/repo#${i + 1}`, 'user', at(-100), at(-i));
        }
      } finally {
        db.close();
      }
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(detail?.detachedLinks).toHaveLength(64);
      expect(detail?.detachedLinks[0]?.key).toBe('github.com/fixture/repo#1');
      expect(detail?.detachedLinks.at(-1)?.key).toBe('github.com/fixture/repo#64');
      expect(detail?.sources.find((source) => source.source === 'github')).toMatchObject({
        state: state === 'ok' ? 'truncated' : state,
        message:
          state === 'never-run'
            ? 'Older detached links are omitted from this history.'
            : 'Fixture collection result. Older detached links are omitted from this history.',
      });
    },
  );

  test('unauthenticated discovery has a typed source state with no linked observations', async () => {
    const dbPath = await fixture();
    await run(
      recordWorkFactRun({
        dbPath,
        machineId: MACHINE,
        sourceId: 'github.pull-requests',
        disabled: false,
        failed: 1,
        observed: 0,
        ranAt: NOW,
        message: 'Fixture reason without credential words',
        outcomeCode: 'unauthenticated',
      }),
    );
    expect(
      (await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }))).sources.find(
        (source) => source.source === 'github',
      )?.state,
    ).toBe('unauthenticated');
    const threadId = await create(dbPath);
    expect(
      (await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.sources.find(
        (source) => source.source === 'github',
      )?.state,
    ).toBe('unauthenticated');
  });

  test('detaching a declared child removes its episodes, counts, marks, checkouts and activity only from that thread', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      session('parent', { date: at(-300), activeDate: at(-299), endDate: at(-299) }),
      withBranch(
        session('detached-child', {
          source: {
            ...session('detached-child').source,
            harnessKey: 'codex',
            sourceSessionId: 'detached-child',
            parentSourceSessionId: 'parent',
            rootSourceSessionId: 'parent',
            sourcePath: '/fixture/detached',
          },
        }),
        'feature',
      ),
    ]);
    const threadId = await create(dbPath, [sessionLink('parent'), sessionLink('detached-child')]);
    const siblingThread = await create(dbPath, [sessionLink('parent')]);
    const childLink = (await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }))).find(
      (link) => link.key === sessionLink('detached-child').key,
    );
    if (childLink === undefined) {
      throw new Error('Missing child link');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: childLink.linkId }, -12);
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
      -10,
    );
    const checkout = parseCheckoutStatusObservation({
      machineId: MACHINE,
      checkoutPath: '/fixture/detached',
      observedAt: at(-1),
      outcome: 'observed',
      branch: 'feature',
      lastCommitAt: at(-2),
    });
    if (checkout === null) {
      throw new Error('Invalid detached checkout fixture');
    }
    await run(importCheckoutStatusObservations({ dbPath, observations: [checkout] }));
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    const list = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, tab: 'done' }, now: NOW }));
    for (const row of [detail?.row, list.rows[0]]) {
      expect(row?.sessionCount).toBe(1);
      expect(row?.marks.filter((mark) => mark.kind === 'session')).toEqual([]);
      expect(row?.markers.local).toEqual([]);
      expect(row?.afterDone).toBeNull();
      expect(row?.lastActivityAt).toBe(at(-10));
    }
    expect(detail?.episodes[0]?.children).toEqual([]);
    const sibling = await run(queryWorkThreadDetail({ dbPath, threadId: siblingThread, now: NOW }));
    expect(sibling?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
    expect(sibling?.episodes[0]?.children).toHaveLength(1);
    expect(sibling?.row.markers.local.some((marker) => marker.latest?.checkoutPath === '/fixture/detached')).toBe(true);
  });

  test('maps W2 markers from the latest success across repository casing and isolates machine identities', async () => {
    const dbPath = await fixture();
    const mergeability = [
      ['MERGEABLE', 'mergeable'],
      ['CONFLICTING', 'conflicting'],
      ['UNKNOWN', 'unknown'],
      [null, null],
    ] as const;
    const expected = new Map<string, { mergeable: string | null; number: number }>();
    const observations: PullRequestObservation[] = [];
    for (const [index, [mergeable, marker]] of mergeability.entries()) {
      const number = index + 7;
      const threadId = await create(dbPath, [{ kind: 'pull-request', key: `github.com/fixture/repo#${number}` }]);
      expected.set(threadId, { mergeable: marker, number });
      observations.push(
        {
          ...pr(-4),
          repository: 'Fixture/RePo',
          number,
          mergeable,
          mergeStateStatus: 'CLEAN',
          discoveryRole: 'author',
        },
        {
          ...pr(-2, 'timeout'),
          repository: 'FIXTURE/repo',
          number,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
          discoveryRole: 'review-requested',
        },
        {
          ...pr(-1),
          machineId: 'another-machine',
          number,
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'WRONG',
          discoveryRole: 'review-requested',
        },
      );
    }
    const failedOnly = await create(dbPath, [{ kind: 'pull-request', key: 'github.com/fixture/repo#11' }]);
    observations.push({
      ...pr(-1, 'timeout'),
      number: 11,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      discoveryRole: 'author',
    });
    await run(importPullRequestObservations({ dbPath, observations }));
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(list.rows).toHaveLength(5);
    for (const [threadId, item] of expected) {
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      for (const row of [list.rows.find((candidate) => candidate.thread.threadId === threadId), detail?.row]) {
        expect(row?.markers.pullRequests).toHaveLength(1);
        expect(row?.markers.pullRequests[0]).toMatchObject({
          key: `github.com/fixture/repo#${item.number}`,
          latest: { outcome: 'timeout', observedAt: at(-2), machineId: MACHINE },
          latestSuccessful: { outcome: 'observed', observedAt: at(-4), machineId: MACHINE, repository: 'Fixture/RePo' },
          mergeable: item.mergeable,
          mergeStateStatus: 'CLEAN',
          role: 'author',
        });
      }
    }
    expect(list.rows.find((row) => row.thread.threadId === failedOnly)?.markers.pullRequests[0]).toMatchObject({
      latest: { outcome: 'timeout' },
      latestSuccessful: null,
      mergeable: null,
      mergeStateStatus: null,
      role: null,
    });
  });

  test('detached history does not consume the active evidence link bound', async () => {
    const dbPath = await fixture();
    const threadId = await create(
      dbPath,
      Array.from({ length: 64 }, (_, index) => ({
        kind: 'pull-request',
        key: `github.com/fixture/repo#${index + 1}`,
      })),
    );
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    const first = links[0];
    if (!first) {
      throw new Error('Missing fixture link');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: first.linkId });
    await command(dbPath, {
      commandId: randomUUID(),
      op: 'link',
      threadId,
      kind: 'pull-request',
      key: 'github.com/fixture/repo#65',
    });
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(detail?.detachedLinks.map((link) => link.linkId)).toEqual([first.linkId]);
    expect(detail?.row.links).toHaveLength(64);
    expect(list.rows[0]?.links).toHaveLength(64);
    expect(list.rows[0]?.markers.pullRequests).toHaveLength(64);
  });

  test('batches a page above 500 fact identities without mixing threads, sessions, events or machines', async () => {
    const dbPath = await fixture();
    const observations: PullRequestObservation[] = [];
    const ids: string[] = [];
    const rows: SerializedRow[] = [];
    for (let index = 0; index < 9; index++) {
      const rootId = `root-${index}`;
      const childId = `child-${index}`;
      const root = session(rootId, {
        date: at(-3),
        source: {
          ...session(rootId).source,
          harnessKey: 'codex',
          sourceSessionId: rootId,
          sourcePath: `/fixture/${index}`,
        },
      });
      const child = session(childId, {
        source: {
          ...session(childId).source,
          harnessKey: 'codex',
          sourceSessionId: childId,
          sourcePath: `/fixture/${index}`,
          parentSourceSessionId: rootId,
          rootSourceSessionId: rootId,
        },
      });
      rows.push(
        root,
        child,
        session(rootId, {
          source: { ...root.source, harnessKey: 'codex', sourceSessionId: rootId, machineId: 'another-machine' },
        }),
      );
      const links: WorkThreadLinkInput[] = [
        sessionLink(rootId),
        { kind: 'jira-issue', key: `jira:default/TASK-${index + 1}` },
      ];
      for (let offset = 0; offset < 62; offset++) {
        const number = index * 62 + offset + 1;
        links.push({ kind: 'pull-request', key: `github.com/fixture/repo#${number}` });
        observations.push({ ...pr(-1), number, title: `PR ${number}`, headRef: `branch-${index}` });
      }
      const batchThread = await create(dbPath, links, `Batch task ${index}`, -20 - index);
      ids.push(batchThread);
      await command(
        dbPath,
        {
          commandId: randomUUID(),
          op: 'set-follow-state',
          threadId: batchThread,
          expectedRevision: 1,
          to: 'waiting',
          waitingFor: 'A response',
          waitingOn: null,
          reason: null,
          acknowledgedRemainders: [],
        },
        -20 - index,
      );
      const jira = parseJiraIssueObservation({
        machineId: MACHINE,
        key: `TASK-${index + 1}`,
        observedAt: at(-1),
        outcome: 'observed',
        status: 'Open',
        summary: `Issue ${index}`,
      });
      const checkout = parseCheckoutStatusObservation({
        machineId: MACHINE,
        checkoutPath: `/fixture/${index}`,
        observedAt: at(-1),
        outcome: 'observed',
        branch: `branch-${index}`,
        dirty: true,
      });
      if (jira === null || checkout === null) {
        throw new Error('Invalid batch fixture');
      }
      await run(
        importJiraIssueObservations({
          dbPath,
          observations: [jira, { ...jira, machineId: 'another-machine', summary: 'Wrong machine' }],
        }),
      );
      await run(
        importCheckoutStatusObservations({
          dbPath,
          observations: [checkout, { ...checkout, machineId: 'another-machine', branch: 'wrong-machine' }],
        }),
      );
    }
    for (let offset = 0; offset < observations.length; offset += 500) {
      await run(importPullRequestObservations({ dbPath, observations: observations.slice(offset, offset + 500) }));
    }
    await run(
      importPullRequestObservations({
        dbPath,
        observations: [{ ...pr(0), number: 1, machineId: 'another-machine', title: 'Wrong machine' }],
      }),
    );
    await publish(dbPath, rows);
    const readQueries = async (limit: number) => {
      const queries = spyOn(Database.prototype, 'query');
      try {
        const list = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, limit }, now: NOW }));
        return { list, queries: queries.mock.calls.map(([sql]) => sql) };
      } finally {
        queries.mockRestore();
      }
    };
    const single = await readQueries(1);
    const page = await readQueries(9);
    expect(page.queries.length).toBe(single.queries.length);
    for (const table of [
      'pull_request_observations',
      'jira_issue_observations',
      'checkout_status_observations',
      'work_thread_events',
    ]) {
      expect(page.queries.filter((sql) => sql.includes(`FROM ${table}`))).toHaveLength(
        table === 'checkout_status_observations' ? 1 : 2,
      );
    }
    expect(page.list.rows).toHaveLength(9);
    expect(page.list.rows.flatMap((row) => row.markers.pullRequests)).toHaveLength(558);
    for (const [index, threadId] of ids.entries()) {
      const row = page.list.rows.find((candidate) => candidate.thread.threadId === threadId);
      expect(row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
      expect(row?.markers.pullRequests).toHaveLength(62);
      expect(
        row?.markers.pullRequests.every(
          (marker) =>
            marker.latestSuccessful?.machineId === MACHINE &&
            marker.latestSuccessful.number > index * 62 &&
            marker.latestSuccessful.number <= (index + 1) * 62,
        ),
      ).toBe(true);
      expect(row?.markers.jiraIssues[0]?.latestSuccessful?.summary).toBe(`Issue ${index}`);
      expect(row?.markers.local).toHaveLength(1);
      expect(
        row?.markers.local.every(
          (marker) =>
            marker.latestSuccessful?.machineId === MACHINE && marker.latestSuccessful.branch === `branch-${index}`,
        ),
      ).toBe(true);
      expect(row?.marks.filter((mark) => mark.kind === 'event').map((mark) => mark.at)).toEqual([at(-20 - index)]);
    }
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
      spanMs: 3_600_000,
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
    expect(detail?.row.marks.filter((mark) => mark.kind === 'session')).toHaveLength(0);
    expect(detail?.row.firstActivityAt).toBe(at(-300));
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
      firstPrompt: quotedId,
      spanMs: null,
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
    expect(activity?.episodes[0]?.spanMs).toBeNull();
    const doneList = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, tab: 'done' }, now: NOW }));
    expect(doneList.rows[0]?.lastActivityAt).toBe(at(-2));
  });

  test('recent activity, partial timing and missing ends do not establish running sessions', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      session('recent-root', { activeDate: at(0), endDate: at(0), partial: true }),
      session('open-child', {
        activeDate: at(0),
        date: at(0),
        endDate: null,
        partial: true,
        source: {
          harnessKey: 'codex',
          machineId: MACHINE,
          parentSourceSessionId: 'recent-root',
          rootSourceSessionId: 'recent-root',
          sourceSessionId: 'open-child',
        },
      }),
    ]);
    const threadId = await create(dbPath, [sessionLink('recent-root')]);
    const unrelatedThread = await create(dbPath, [], 'No sessions');
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
    expect(detail?.row.runningSessions).toBe(0);
    expect(detail?.episodes[0]?.children[0]?.sourceSessionId).toBe('open-child');
    expect(detail?.sources.find((source) => source.source === 'sessions')).toMatchObject({
      state: 'ok',
      message: expect.stringContaining('Running state is unknown for the linked sessions.'),
    });
    const list = await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }));
    expect(list.rows.find((row) => row.thread.threadId === threadId)?.runningSessions).toBe(0);
    expect(list.rows.find((row) => row.thread.threadId === unrelatedThread)?.sessionCount).toBe(0);
    expect(list.sources.find((source) => source.source === 'sessions')?.message).toContain('Running state is unknown');
    const empty = await run(queryWorkThreadDetail({ dbPath, threadId: unrelatedThread, now: NOW }));
    expect(empty?.sources.find((source) => source.source === 'sessions')?.message).toBeNull();
  });

  test('served PR declarations render exact session episodes and never link a shared checkout', async () => {
    const dbPath = await fixture();
    const declared = session('served-declaration', {
      name: 'Served PR implementation',
      sessionLabel: 'Served PR implementation',
      source: {
        ...session('served-declaration').source,
        harnessKey: 'codex',
        sourceSessionId: 'served-declaration',
        vcs: {
          branches: [],
          headCommit: null,
          partial: false,
          pullRequests: [7, 8].map((number) => ({
            number: null,
            observedAt: null,
            repository: null,
            url: `https://github.com/fixture/repo/pull/${number}`,
          })),
          repository: null,
        },
      },
    });
    await publish(dbPath, [declared, session('same-checkout-without-declaration')]);
    const threadIds = await Promise.all(
      [7, 8].map((number) => create(dbPath, [{ kind: 'pull-request', key: `github.com/fixture/repo#${number}` }])),
    );
    const { declarations } = await run(queryServedSessionPullRequestLinks({ dbPath, now: NOW.getTime() }));
    expect(declarations).toHaveLength(2);
    for (let cycle = 0; cycle < 2; cycle++) {
      await run(attachDeclaredWorkThreadSessions({ dbPath, machineId: MACHINE, now: at(0), declarations }));
    }
    for (const threadId of threadIds) {
      const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
      expect(detail?.row.sessionCount).toBe(1);
      expect(detail?.row.links.filter((link) => link.kind === 'session')).toMatchObject([
        { key: sessionLink('served-declaration').key, provenance: 'declared' },
      ]);
      expect(detail?.episodes).toMatchObject([
        {
          sourceSessionId: 'served-declaration',
          harness: 'codex',
          title: 'Served PR implementation',
          startedAt: at(-2),
          endedAt: at(-1),
        },
      ]);
    }
  });

  test('a declared Desktop session renders its CLI identity, dated metadata and children', async () => {
    const dbPath = await fixture();
    const desktop = parseClaudeDesktopSessionObservation({
      accountDirectory: 'account',
      archived: false,
      branch: null,
      cliSessionId: 'cli-id',
      completedTurns: 1,
      createdAt: at(-4),
      cwd: '/fixture/desktop',
      declaredPullRequests: [{ host: 'github.com', repository: 'fixture/repo', number: 7, state: 'OPEN' }],
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
    if (desktop === null || desktop.turnSummary === null) {
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
            turnSummary: { ...desktop.turnSummary, status: 'blocked' },
            spawnedFrom: { sessionId: 'desktop-id', sideSession: true, taskId: null, title: 'Child' },
          },
          {
            ...desktop,
            cliSessionId: 'grand-cli',
            desktopSessionId: 'grand-desktop',
            title: 'Grandchild',
            turnSummary: { ...desktop.turnSummary, status: 'completed' },
            spawnedFrom: { sessionId: 'child-desktop', sideSession: true, taskId: null, title: 'Grandchild' },
          },
        ],
      }),
    );
    const threadId = await create(dbPath, [{ kind: 'pull-request', key: 'github.com/fixture/repo#7' }]);
    const declarations = desktop.declaredPullRequests.map((pullRequest) => ({
      pullRequestKey: pullRequestLinkKey(pullRequest),
      sessionKey: sessionLink(desktop.cliSessionId, 'claude').key,
    }));
    await run(attachDeclaredWorkThreadSessions({ dbPath, machineId: MACHINE, now: at(0), declarations }));
    const desktopOnly = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(desktopOnly?.episodes[0]).toMatchObject({
      title: 'Desktop title',
      sourceSessionId: 'cli-id',
      harness: 'claude',
      startedAt: at(-4),
      endedAt: at(-1),
    });
    expect(desktopOnly?.sources.find((source) => source.source === 'sessions')).toMatchObject({
      state: 'ok',
      lastRunAt: at(0),
    });
    const nativeEvidence = await run(
      queryWorkThreadSessionEvidence({ dbPath, machineId: MACHINE, links: desktopOnly?.row.links ?? [] }),
    );
    expect(nativeEvidence).toMatchObject({ revision: null, generatedAt: null });
    expect(nativeEvidence.sessions[0]?.member).toMatchObject({ rowId: null, projectLabel: null });
    await publish(dbPath, [
      session('cli-id', {
        source: { harnessKey: 'claude', machineId: MACHINE, sourceSessionId: 'cli-id', rootSourceSessionId: 'cli-id' },
      }),
      ...['child-cli', 'grand-cli'].map((id) =>
        session(id, {
          source: { harnessKey: 'claude', machineId: MACHINE, sourceSessionId: id, rootSourceSessionId: id },
        }),
      ),
      session('unrelated', {
        source: {
          harnessKey: 'codex',
          machineId: MACHINE,
          sourceSessionId: 'unrelated',
          sourcePath: '/fixture/desktop',
        },
      }),
    ]);
    for (let cycle = 0; cycle < 2; cycle++) {
      await run(attachDeclaredWorkThreadSessions({ dbPath, machineId: MACHINE, now: at(0), declarations }));
    }
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row.links.filter((link) => link.kind === 'session')).toMatchObject([
      { key: sessionLink('cli-id', 'claude').key, provenance: 'declared' },
    ]);
    expect(detail?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
    expect(detail?.episodes).toHaveLength(1);
    expect(detail?.row.runningSessions).toBe(0);
    expect(detail?.sources.find((source) => source.source === 'sessions')).toMatchObject({
      state: 'ok',
      message: expect.stringContaining('Running state is unknown for the linked sessions.'),
    });
    expect(detail?.episodes[0]).toMatchObject({
      title: 'Desktop title',
      harness: 'claude',
      sourceSessionId: 'cli-id',
      startedAt: at(-4),
      endedAt: at(-1),
      question: 'Review this',
      result: 'Ready for review.',
      spanMs: 10_800_000,
      resume: { command: "claude --resume 'cli-id'", cwd: '/fixture/desktop' },
    });
    for (const links of [
      [sessionLink('cli-id', 'claude'), sessionLink('child-cli', 'claude')],
      [sessionLink('child-cli', 'claude'), sessionLink('cli-id', 'claude')],
    ]) {
      const overlapping = await create(dbPath, links);
      const grouped = await run(queryWorkThreadDetail({ dbPath, threadId: overlapping, now: NOW }));
      expect(grouped?.row.runningSessions).toBe(0);
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
    for (const variant of ['unrelated-served', 'served-child', 'ambiguous-desktop', 'ambiguous-served'] as const) {
      const nativeDb = await fixture();
      await run(
        importClaudeDesktopSessions({
          dbPath: nativeDb,
          machineId: MACHINE,
          collectedAt: NOW,
          completeness: { filesParsed: 2, filesSeen: 2, rejected: 0, truncated: false, unsupported: 0 },
          observations:
            variant === 'ambiguous-desktop'
              ? [desktop, { ...desktop, desktopSessionId: 'duplicate-desktop', filePath: 'account/duplicate.json' }]
              : [desktop],
        }),
      );
      if (variant !== 'ambiguous-desktop') {
        let rows = [session('unrelated')];
        if (variant === 'served-child') {
          rows = [
            session('child-only', {
              source: {
                harnessKey: 'claude',
                machineId: MACHINE,
                sourceSessionId: 'child-only',
                rootSourceSessionId: 'cli-id',
                parentSourceSessionId: 'cli-id',
              },
            }),
          ];
        } else if (variant === 'ambiguous-served') {
          rows = ['first', 'second'].map((name) =>
            session(name, {
              source: {
                harnessKey: 'claude',
                machineId: MACHINE,
                sourceSessionId: 'cli-id',
                rootSourceSessionId: 'cli-id',
              },
            }),
          );
        }
        await publish(nativeDb, rows);
      }
      const nativeThread = await create(nativeDb, [sessionLink('cli-id', 'claude')]);
      const result = await run(queryWorkThreadDetail({ dbPath: nativeDb, threadId: nativeThread, now: NOW }));
      const uniqueNativeRoot = variant === 'unrelated-served' || variant === 'served-child';
      expect(result?.episodes).toHaveLength(uniqueNativeRoot ? 1 : 0);
      expect(result?.sources.find((source) => source.source === 'sessions')?.state).toBe(
        uniqueNativeRoot ? 'ok' : 'truncated',
      );
      if (variant === 'served-child') {
        expect(result?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
        expect(result?.episodes[0]?.children).toMatchObject([{ sourceSessionId: 'child-only' }]);
      }
    }
    for (const [nativeBranch, checkoutBranch, expected] of [
      ['native-branch', 'native-branch', 1],
      ['native-branch', 'served-branch', 0],
      [null, 'served-branch', 0],
    ] as const) {
      const branchDb = await fixture();
      await publish(branchDb, [
        withBranch(
          session('cli-id', {
            source: {
              harnessKey: 'claude',
              machineId: MACHINE,
              sourceSessionId: 'cli-id',
              rootSourceSessionId: 'cli-id',
            },
          }),
          'served-branch',
        ),
      ]);
      await run(
        importClaudeDesktopSessions({
          dbPath: branchDb,
          machineId: MACHINE,
          collectedAt: NOW,
          completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
          observations: [{ ...desktop, branch: nativeBranch }],
        }),
      );
      await run(
        importCheckoutStatusObservations({
          dbPath: branchDb,
          observations: [
            {
              machineId: MACHINE,
              checkoutPath: desktop.cwd,
              observedAt: at(0),
              outcome: 'observed',
              branch: checkoutBranch,
            },
          ],
        }),
      );
      const branchThread = await create(branchDb, [sessionLink('cli-id', 'claude')]);
      const result = await run(queryWorkThreadDetail({ dbPath: branchDb, threadId: branchThread, now: NOW }));
      expect(result?.episodes).toHaveLength(1);
      expect(result?.row.markers.local).toHaveLength(expected);
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
    expect(detail?.row.markers.local).toHaveLength(1);
    expect(detail?.row.markers.local.map((marker) => marker.via).sort()).toEqual(['branch-link']);
    expect(detail?.row.markers.local[0]?.latestSuccessful?.dirty).toBe(true);
    await command(dbPath, {
      commandId: randomUUID(),
      op: 'link',
      threadId,
      kind: 'pull-request',
      key: 'github.com/fixture/repo#7',
    });
    await run(importPullRequestObservations({ dbPath, observations: [{ ...pr(-1), headRef: 'another-branch' }] }));
    expect(
      (await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW })))?.row.markers.local.map((marker) => marker.via),
    ).toEqual(['branch-link']);
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
    expect(ended?.row.afterDone).toEqual({ count: 1, latestAt: at(-1) });
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

  test('bounds children, excludes incidental changes from marks, and reports missing linked evidence', async () => {
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
    expect(detail?.row.marks).toEqual([{ at: at(-2), harness: 'codex', kind: 'session', label: 'parent' }]);
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

  test('measures complete search pages over 20000 served sessions and 500 threads', async () => {
    const dbPath = await fixture();
    await publish(
      dbPath,
      Array.from({ length: 20_000 }, (_, index) =>
        session(`search-${index}`, {
          name: index < 500 ? `Search target ${index}` : `Unrelated ${index}`,
          sessionLabel: index < 500 ? `Search target ${index}` : `Unrelated ${index}`,
        }),
      ),
    );
    const db = new Database(dbPath);
    try {
      const insert = db.query(
        `INSERT INTO work_threads (thread_id,machine_id,title,objective,project_label,intent,origin,origin_key,follow_state,follow_revision,waiting_for,waiting_on_json,done_at,done_reason,note,created_at,updated_at,last_activity_at) VALUES (?,?,'Fixture thread',NULL,'load',NULL,'user',NULL,'following',1,NULL,NULL,NULL,NULL,NULL,?,?,?)`,
      );
      const link = db.query(`INSERT INTO work_thread_links VALUES (?,?,?,?,'user',?,NULL)`);
      db.transaction(() => {
        for (let index = 0; index < 500; index++) {
          const id = randomUUID();
          insert.run(id, MACHINE, at(-2), at(-2), at(-2));
          link.run(randomUUID(), id, 'session', sessionLink(`search-${index}`).key, at(-2));
          for (let key = 0; key < 4; key++) {
            link.run(randomUUID(), id, 'pull-request', `github.com/fixture/repo#${index * 4 + key + 1}`, at(-2));
          }
        }
      })();
    } finally {
      db.close();
    }
    const samples: number[] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      const started = performance.now();
      const list = await run(
        queryWorkThreadList({ dbPath, query: { ...QUERY, search: 'Search target', limit: 100 }, now: NOW }),
      );
      samples.push(performance.now() - started);
      expect(list.rows).toHaveLength(100);
      expect(list.rows.every((row) => row.sessionCount === 1 && row.links.length === 5)).toBe(true);
      expect(list.nextCursor).not.toBeNull();
    }
    console.info(
      `Complete thread search page: 20000 served sessions x 500 threads x 5 links, samples=[${samples.map((sample) => sample.toFixed(1)).join(', ')}] ms; median=${[...samples].sort((a, b) => a - b)[2]?.toFixed(1)} ms`,
    );
  }, 30_000);

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
    const samples: number[] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now();
      const list = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, limit: 100 }, now: NOW }));
      samples.push(performance.now() - start);
      expect(list.rows).toHaveLength(100);
      expect(list.rows.every((row) => row.links.length === 5)).toBe(true);
      expect(list.nextCursor).not.toBeNull();
      expect(list.counts).toEqual({ open: 501, done: 0 });
    }
    const median = [...samples].sort((left, right) => left - right)[2];
    console.info(
      `Work thread list 500 threads x 5 links, 100-row page: samples=[${samples.map((sample) => sample.toFixed(1)).join(', ')}] ms; median=${median?.toFixed(1)} ms`,
    );
    const selected = await run(queryWorkThreadList({ dbPath, query: { ...QUERY, search: 'old wait' }, now: NOW }));
    expect(selected.rows.map((row) => row.thread.threadId)).toEqual([old]);
    const invalid = await run(
      Effect.result(queryWorkThreadList({ dbPath, query: { ...QUERY, limit: 101 }, now: NOW })),
    );
    expect(invalid._tag).toBe('Failure');
  });
});

test('a PR branch supplies an exact Jira reference and its observed URL without guessing a site', async () => {
  const dbPath = await fixture();
  const threadId = await create(dbPath, [{ kind: 'pull-request', key: 'github.com/fixture/repo#7' }]);
  await run(importPullRequestObservations({ dbPath, observations: [{ ...pr(-2), headRef: 'fix/SHOP-42/url-limit' }] }));
  const issue = parseJiraIssueObservation({
    machineId: MACHINE,
    key: 'SHOP-42',
    observedAt: at(-1),
    outcome: 'observed',
    status: 'In progress',
    url: 'https://jira.example.test/browse/SHOP-42',
    comments: [],
  });
  if (!issue) {
    throw new Error('Invalid Jira fixture');
  }
  await run(importJiraIssueObservations({ dbPath, observations: [issue] }));
  const result = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
  expect(result?.row.markers.jiraIssues[0]?.latestSuccessful).toMatchObject({
    key: 'SHOP-42',
    status: 'In progress',
    url: issue.url,
  });
  expect(result?.row.links.filter((link) => link.kind === 'session')).toHaveLength(0);
});

test('a deleted dedicated worktree stays visible even without a previous successful disk read', async () => {
  const dbPath = await fixture();
  const desktop = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account',
    archived: false,
    branch: 'feat/x',
    cliSessionId: 'cli-id',
    completedTurns: 1,
    createdAt: at(-4),
    cwd: '/fixture/desktop',
    declaredPullRequests: [{ host: 'github.com', repository: 'fixture/repo', number: 7, state: 'OPEN' }],
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
    worktreePath: '/fixture/deleted-worktree',
    wrapUpDescription: null,
    writtenBranches: [],
  });

  if (!desktop) {
    throw new Error('Invalid Desktop fixture');
  }
  await run(
    importClaudeDesktopSessions({
      dbPath,
      machineId: MACHINE,
      collectedAt: NOW,
      completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
      observations: [desktop],
    }),
  );
  const threadId = await create(dbPath, [
    { kind: 'session', key: sessionLinkKey({ machineId: MACHINE, harness: 'claude', sessionId: 'cli-id' }) },
    { kind: 'pull-request', key: 'github.com/fixture/repo#7' },
  ]);
  await run(importPullRequestObservations({ dbPath, observations: [{ ...pr(-2), headRef: 'feat/x' }] }));
  const missing = parseCheckoutStatusObservation({
    machineId: MACHINE,
    checkoutPath: '/fixture/deleted-worktree',
    observedAt: at(-1),
    outcome: 'missing',
  });
  if (!missing) {
    throw new Error('Invalid missing checkout');
  }
  await run(importCheckoutStatusObservations({ dbPath, observations: [missing] }));
  const result = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
  expect(result?.row.markers.local).toMatchObject([{ latest: { outcome: 'missing' }, latestSuccessful: null }]);
});
