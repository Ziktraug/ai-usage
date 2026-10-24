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
    await publish(dbPath, [session('old-session', { date: at(-21), activeDate: at(-20), endDate: at(-20) })]);
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
    await publish(dbPath, rows);
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
  });

  test('returns the newest 64 detached links and reports the omitted history', async () => {
    const dbPath = await fixture();
    const threadId = await create(dbPath);
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
      state: 'truncated',
      message: expect.stringContaining('detached'),
    });
  });

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
      expect(row?.markers.local).toHaveLength(1);
      expect(row?.markers.local[0]?.latest).toBeNull();
      expect(row?.afterDone).toBeNull();
      expect(row?.lastActivityAt).toBe(at(-10));
    }
    expect(detail?.episodes[0]?.children).toEqual([]);
    const sibling = await run(queryWorkThreadDetail({ dbPath, threadId: siblingThread, now: NOW }));
    expect(sibling?.row.sessionCount).toBe(2);
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
        observations.push({ ...pr(-1), number, title: `PR ${number}` });
      }
      ids.push(await create(dbPath, links, `Batch task ${index}`, -20 - index));
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
      expect(page.queries.filter((sql) => sql.includes(`FROM ${table}`))).toHaveLength(1);
    }
    expect(page.list.rows).toHaveLength(9);
    expect(page.list.rows.flatMap((row) => row.markers.pullRequests)).toHaveLength(558);
    for (const [index, threadId] of ids.entries()) {
      const row = page.list.rows.find((candidate) => candidate.thread.threadId === threadId);
      expect(row?.sessionCount).toBe(2);
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
    expect(detail?.row.markers.local).toHaveLength(1);
    expect(detail?.row.markers.local.map((marker) => marker.via).sort()).toEqual(['branch-link']);
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
      Effect.either(queryWorkThreadList({ dbPath, query: { ...QUERY, limit: 101 }, now: NOW })),
    );
    expect(invalid._tag).toBe('Left');
  });
});
