import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { parsePullRequestObservation } from '@ai-usage/report-core/work-attention';
import {
  pullRequestLinkKey,
  sessionLinkKey,
  type WorkThreadLinkInput,
  type WorkThreadTaskCommand,
} from '@ai-usage/report-core/work-thread';
import type { WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import { queryWorkThreadLinks } from '@ai-usage/usage-store/reader';
import {
  importPullRequestObservations,
  initializeUsageStore,
  publishServedReportRevision,
  reconcileWorkBranches,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { applyWorkThreadCommand, seedWorkThreads } from '../../usage-store/src/index';
import { queryWorkThreadDetail, queryWorkThreadList } from './work-thread-read';

const roots: string[] = [];
const MACHINE = 'branch-machine';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const at = (hours: number) => canonicalInstantFromDate(new Date(NOW.getTime() + hours * 3_600_000));
const QUERY: WorkThreadListQuery = { cursor: null, limit: 50, project: null, search: null, tab: 'open' };
const run = Effect.runPromise;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-branch-'));
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
const publish = async (dbPath: string, rows: SerializedRow[], revision = 'work-branch-fixture') => {
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
      revision,
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
const key = (id: string, harness = 'codex') => sessionLinkKey({ machineId: MACHINE, harness, sessionId: id });
/** A session whose harness recorded `owner/repo` on `host` and the given branch names, in order. */
const onBranch = (
  id: string,
  branches: readonly string[],
  overrides: Partial<SerializedRow> & {
    readonly host?: string;
    readonly launchMode?: 'exec' | 'interactive' | 'unrecorded';
  } = {},
): SerializedRow => {
  const { host = 'github-perso.com', launchMode = 'interactive', ...rest } = overrides;
  const base = session(id, { origin: 'human', ...(rest.sessionLabel ? { name: rest.sessionLabel } : {}), ...rest });
  return {
    ...base,
    source: {
      ...base.source,
      harnessKey: base.source?.harnessKey ?? 'codex',
      sourceSessionId: id,
      ...(launchMode === 'unrecorded' ? {} : { launchMode }),
      vcs: {
        branches: branches.map((name) => ({
          firstObservedAt: base.date,
          lastObservedAt: base.date,
          name,
          provenance: 'harness-recorded' as const,
          webUrl: null,
        })),
        headCommit: null,
        partial: false,
        pullRequests: [],
        repository: { host, ownerPath: 'Fixture/Repo', provenance: 'harness-recorded' as const, webUrl: null },
      },
    },
  };
};
const reconcile = (dbPath: string, extra: { readonly defaultBranch?: string } = {}) =>
  run(
    reconcileWorkBranches({
      dbPath,
      machineId: MACHINE,
      now: at(0),
      hostAliases: { 'github-perso.com': 'github.com' },
      defaultBranchOf: () => extra.defaultBranch ?? null,
    }),
  );
const openTitles = async (dbPath: string) =>
  (await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }))).rows.map((row) => row.thread.title).sort();
const rowOf = async (dbPath: string, title: string) => {
  const row = (await run(queryWorkThreadList({ dbPath, query: QUERY, now: NOW }))).rows.find(
    (candidate) => candidate.thread.title === title,
  );
  if (!row) {
    throw new Error(`Missing task ${title}`);
  }
  return row;
};
const observePr = async (
  dbPath: string,
  number: number,
  headRef: string,
  extra: { readonly crossRepository?: boolean; readonly state?: 'OPEN' | 'MERGED'; readonly baseRef?: string } = {},
) => {
  const value = parsePullRequestObservation({
    machineId: MACHINE,
    host: 'github.com',
    repository: 'Fixture/Repo',
    number,
    observedAt: at(-1),
    outcome: 'observed',
    state: extra.state ?? 'OPEN',
    headRef,
    baseRef: extra.baseRef ?? 'main',
    title: `PR ${number}`,
    crossRepository: extra.crossRepository ?? false,
    discoveryRole: 'author',
  });
  if (value === null) {
    throw new Error('Invalid PR fixture');
  }
  await run(importPullRequestObservations({ dbPath, observations: [value] }));
  return value;
};

describe('branch evidence (ADR 0081)', () => {
  test('recent interactive work on a branch becomes one task, read through its SSH alias', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      onBranch('first', ['feat/parser'], { sessionLabel: 'Write the parser', date: at(-30) }),
      onBranch('second', ['feat/parser'], { date: at(-3) }),
      onBranch('untitled', ['feat/untitled'], { titleSource: 'id' }),
    ]);
    expect(await reconcile(dbPath)).toMatchObject({ created: 2, indexed: true, truncated: false });
    const row = await rowOf(dbPath, 'Write the parser');
    expect(row.thread).toMatchObject({ origin: 'session', originKey: 'branch:github.com/fixture/repo@feat/parser' });
    expect(row.thread.projectLabel).toBe('Fixture/Repo');
    expect(row.sessionCount).toBe(2);
    expect(row.links.map((link) => [link.kind, link.provenance])).toEqual([['branch', 'origin']]);
    // Idempotent: a second run on the same revision creates nothing and reindexes nothing.
    expect(await reconcile(dbPath)).toMatchObject({ created: 0, indexed: false });
    // A title made from the session id gives way to the branch name.
    expect(await openTitles(dbPath)).toEqual(['Write the parser', 'feat/untitled']);
  });

  test('shared, default, detached, invalid, delegated, exec-only and old branches create no task', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [
      onBranch('on-main', ['main']),
      onBranch('on-default', ['release-line']),
      onBranch('detached', ['HEAD']),
      onBranch('placeholder', ['.invalid']),
      onBranch('worker', ['ws/fix-cart'], { launchMode: 'exec' }),
      onBranch('older-collector', ['ws/fix-account'], { launchMode: 'unrecorded' }),
      onBranch('helper', ['feat/helper'], { origin: 'subagent' }),
      onBranch('ancient', ['feat/ancient'], { date: at(-24 * 30) }),
      onBranch('stacked-base', ['feat/base']),
      // The head of an observed PR waits for that PR's task, even before GitHub says it is no fork.
      onBranch('pr-head', ['feat/stacked']),
      {
        ...onBranch('ambiguous', ['feat/ambiguous']),
        source: {
          ...onBranch('ambiguous', ['feat/ambiguous']).source,
          vcs: { ...onBranch('ambiguous', ['feat/ambiguous']).source?.vcs, partial: true },
        },
      } as SerializedRow,
    ]);
    await observePr(dbPath, 3, 'feat/stacked', { baseRef: 'feat/base' });
    const result = await reconcile(dbPath, { defaultBranch: 'release-line' });
    expect(result.created).toBe(0);
    expect(result.suppressed).toBe(4);
    expect(await openTitles(dbPath)).toEqual([]);
  });

  test("a followed PR holds its head branch, and that branch's sessions join it until detached", async () => {
    const dbPath = await fixture();
    const pr = await observePr(dbPath, 7, 'feat/payments');
    await observePr(dbPath, 8, 'feat/fork', { crossRepository: true });
    await publish(dbPath, [
      onBranch('work', ['main', 'feat/payments'], { sessionLabel: 'Payments' }),
      onBranch('fork-work', ['feat/fork']),
    ]);
    const threadId = await create(dbPath, [
      { kind: 'pull-request', key: pullRequestLinkKey(pr) },
      { kind: 'pull-request', key: 'github.com/fixture/repo#8' },
    ]);
    const result = await reconcile(dbPath);
    expect(result).toMatchObject({ branchLinks: 1, created: 1 });
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    expect(links.filter((link) => link.kind === 'branch').map((link) => link.key)).toEqual([
      'branch:github.com/fixture/repo@feat/payments',
    ]);
    let detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes.map((episode) => episode.sourceSessionId)).toEqual(['work']);
    // The fork's branch says nothing about this repository: its session made its own task.
    expect(await openTitles(dbPath)).toEqual(['A task', 'fork-work']);
    await command(dbPath, { commandId: randomUUID(), op: 'detach-session', threadId, key: key('work') });
    detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.episodes).toEqual([]);
    expect(detail?.row.sessionCount).toBe(0);
    // Linking it again explicitly lifts the veto.
    await command(dbPath, { commandId: randomUUID(), op: 'link', threadId, kind: 'session', key: key('work') });
    detail = await run(queryWorkThreadDetail({ dbPath, threadId, now: NOW }));
    expect(detail?.row.sessionCount).toBe(1);
  });

  test('a branch naming a followed ticket joins that task instead of making another', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [onBranch('ticket-work', ['fix/SHOP-7/retry'])]);
    const threadId = await create(dbPath, [{ kind: 'jira-issue', key: 'jira:default/SHOP-7' }], 'Ticket');
    expect(await reconcile(dbPath)).toMatchObject({ branchLinks: 1, created: 0 });
    expect(await openTitles(dbPath)).toEqual(['Ticket']);
    expect((await rowOf(dbPath, 'Ticket')).sessionCount).toBe(1);
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    expect(links.map((link) => link.key)).toContain('branch:github.com/fixture/repo@fix/SHOP-7/retry');
  });

  test('a PR opened later on the branch joins its task, ahead of its ticket', async () => {
    const dbPath = await fixture();
    await publish(dbPath, [onBranch('early', ['feat/SHOP-9/later-pr'], { sessionLabel: 'Branch first' })]);
    await reconcile(dbPath);
    const observation = await observePr(dbPath, 12, 'feat/SHOP-9/later-pr');
    await run(
      seedWorkThreads({
        dbPath,
        machineId: MACHINE,
        now: at(0),
        seeds: [
          {
            branchKey: 'branch:github.com/fixture/repo@feat/SHOP-9/later-pr',
            discoveredAt: at(0),
            intent: 'change',
            linkKind: 'pull-request',
            origin: 'pull-request',
            originKey: pullRequestLinkKey(observation),
            projectLabel: 'Fixture/Repo',
            routingJiraKey: 'jira:default/SHOP-9',
            title: 'PR 12',
          },
        ],
      }),
    );
    expect(await openTitles(dbPath)).toEqual(['Branch first']);
    const row = await rowOf(dbPath, 'Branch first');
    expect(row.links.map((link) => link.kind).sort()).toEqual(['branch', 'jira-issue', 'pull-request']);
  });

  test("a session on a Done task's branch stays with it and never reopens it", async () => {
    const dbPath = await fixture();
    await publish(dbPath, [onBranch('before', ['feat/done-work'], { sessionLabel: 'Finished', date: at(-20) })]);
    await reconcile(dbPath);
    const { thread } = await rowOf(dbPath, 'Finished');
    await command(
      dbPath,
      {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId: thread.threadId,
        expectedRevision: thread.followRevision,
        to: 'done',
        reason: null,
        waitingFor: null,
        waitingOn: null,
        acknowledgedRemainders: [],
      },
      -10,
    );
    await publish(
      dbPath,
      [
        onBranch('before', ['feat/done-work'], { sessionLabel: 'Finished', date: at(-20) }),
        onBranch('after', ['feat/done-work'], { date: at(-2) }),
      ],
      'work-branch-fixture-2',
    );
    expect(await reconcile(dbPath)).toMatchObject({ created: 0 });
    expect(await openTitles(dbPath)).toEqual([]);
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId: thread.threadId, now: NOW }));
    expect(detail?.row.thread.followState).toBe('done');
    expect(detail?.row.sessionCount).toBe(2);
    expect(detail?.row.afterDone?.count).toBeGreaterThan(0);
  });
});
