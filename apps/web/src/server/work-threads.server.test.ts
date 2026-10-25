import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  parseWorkThread,
  parseWorkThreadEvent,
  parseWorkThreadLink,
  type WorkThreadCommand,
} from '@ai-usage/report-core/work-thread';
import type { WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import {
  parseWorkThreadsCommandOutput,
  parseWorkThreadsDetailOutput,
  parseWorkThreadsListOutput,
} from '@ai-usage/web-contract/work-threads';
import { threadSituationCopy } from '../lib/features/work/work-thread-model';
import {
  bindLiveWorkThreadPorts,
  executeWorkThreadCommandForServer,
  executeWorkThreadCommandFromRequestForServer,
  readWorkThreadDetailForServer,
  readWorkThreadListForServer,
  type WorkThreadServerPorts,
  WorkThreadServiceUnavailableError,
} from './work-threads.server';
import {
  createSyntheticWorkThreadStore,
  getSyntheticWorkThreadPorts,
  projectSyntheticWorkThreadEpisodes,
  WORK_THREADS_FIXTURE_IDS,
  WORK_THREADS_SYNTHETIC_NOW,
} from './work-threads-e2e-fixture.server';

const query: WorkThreadListQuery = { cursor: null, limit: 50, project: null, search: null, tab: 'open' };
const close = (
  threadId: string = WORK_THREADS_FIXTURE_IDS.analysis,
  expectedRevision = 1,
): Extract<WorkThreadCommand, { readonly op: 'set-follow-state' }> => ({
  acknowledgedRemainders: [],
  commandId: crypto.randomUUID(),
  expectedRevision,
  op: 'set-follow-state',
  reason: null,
  threadId,
  to: 'done',
  waitingFor: null,
  waitingOn: null,
});
const create = (): Extract<WorkThreadCommand, { readonly op: 'create' }> => ({
  commandId: crypto.randomUUID(),
  intent: 'analysis',
  links: [],
  objective: 'Understand the behavior',
  op: 'create',
  projectLabel: 'Example shop',
  title: 'An isolated task',
});
const trustedRequest = (): Request =>
  new Request('http://127.0.0.1:5173/rpc/workThreads/command', {
    headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
    method: 'POST',
  });

describe('injected work thread service', () => {
  test('reads and commands use only injected ports and preserve typed command results', async () => {
    const ports = createSyntheticWorkThreadStore();
    const list = await readWorkThreadListForServer(query, { mode: 'live', ports });
    expect(list.ok).toBe(true);
    const detail = await readWorkThreadDetailForServer({ threadId: WORK_THREADS_FIXTURE_IDS.analysis }, { ports });
    expect(detail.ok && detail.data.row.thread.title).toBe('Understand a declined payment');
    expect(await executeWorkThreadCommandFromRequestForServer(trustedRequest(), close(), { ports })).toMatchObject({
      applied: true,
      followRevision: 2,
      ok: true,
    });
  });

  test('live reads of a missing store and commands without an engine are visibly unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-threads-live-'));
    try {
      const ports = bindLiveWorkThreadPorts(join(directory, 'absent.sqlite'), () =>
        Promise.reject(new Error('no rendezvous')),
      );
      expect(await readWorkThreadListForServer(query, { mode: 'live', ports })).toEqual({
        error: { message: 'Tasks could not be read from the usage store.', tag: 'Unavailable' },
        ok: false,
      });
      await expect(executeWorkThreadCommandForServer(close(), { mode: 'live', ports })).rejects.toThrow(
        new WorkThreadServiceUnavailableError('The usage engine is not running; the task was not changed.'),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('distinguishes not found from sanitized read failure', async () => {
    const ports = createSyntheticWorkThreadStore({ seed: false });
    expect(
      await readWorkThreadDetailForServer({ threadId: WORK_THREADS_FIXTURE_IDS.analysis }, { ports }),
    ).toMatchObject({ error: { tag: 'NotFound' }, ok: false });
    const failing: WorkThreadServerPorts = {
      ...ports,
      readList: () => Promise.reject(new Error('private/path/token')),
    };
    expect(await readWorkThreadListForServer(query, { ports: failing })).toEqual({
      error: { message: 'Tasks could not be read. Try again.', tag: 'Unavailable' },
      ok: false,
    });
  });

  test('rejects cross-origin commands before mutation and preserves aborts', async () => {
    const ports = createSyntheticWorkThreadStore();
    let rejected: unknown;
    try {
      await executeWorkThreadCommandFromRequestForServer(
        new Request('http://127.0.0.1/rpc/workThreads/command', {
          headers: { host: '127.0.0.1', origin: 'https://outside.example' },
          method: 'POST',
        }),
        close(),
        { ports },
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Response);
    expect(rejected instanceof Response && rejected.status).toBe(403);
    expect((await ports.readDetail(WORK_THREADS_FIXTURE_IDS.analysis))?.row.thread.followRevision).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(readWorkThreadListForServer(query, { ports, signal: controller.signal })).rejects.toThrow();
    await expect(executeWorkThreadCommandForServer(close(), { ports, signal: controller.signal })).rejects.toThrow();
  });

  test('demo and e2e share a process store per mode without crossing modes', () => {
    expect(getSyntheticWorkThreadPorts('demo')).toBe(getSyntheticWorkThreadPorts('demo'));
    expect(getSyntheticWorkThreadPorts('demo')).not.toBe(getSyntheticWorkThreadPorts('e2e'));
  });
});

describe('synthetic task dataset', () => {
  test('has explicit synthetic provenance and frozen-contract-valid rows, links and events', async () => {
    const ports = createSyntheticWorkThreadStore();
    const list = await ports.readList(query);
    expect(list.counts).toEqual({ done: 1, open: 11 });
    expect(list.generatedAt).toBe(WORK_THREADS_SYNTHETIC_NOW);
    expect(list.sources.every((source) => source.message?.startsWith('Synthetic demo'))).toBe(true);
    expect(list.rows.find((row) => row.thread.threadId === WORK_THREADS_FIXTURE_IDS.review)?.sessionCount).toBe(0);
    for (const row of list.rows) {
      expect(parseWorkThread(row.thread)).toEqual(row.thread);
      for (const link of row.links) {
        expect(parseWorkThreadLink(link)).toEqual(link);
      }
      const detail = await ports.readDetail(row.thread.threadId);
      for (const event of detail?.events ?? []) {
        expect(parseWorkThreadEvent(event)).toEqual(event);
      }
    }
    const payment = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
    expect(payment?.row.sessionCount).toBe(4);
    expect(payment?.row.delegatedSessionCount).toBe(1);
    expect(payment?.episodes).toHaveLength(4);
    expect(payment?.episodes.flatMap((episode) => episode.children)).toHaveLength(1);
    expect(payment?.episodes.every((episode) => episode.resume.kind === 'none')).toBe(true);
  });

  test('separates short recorded activity from a multi-day span and leaves unrecorded activity unknown', async () => {
    const ports = createSyntheticWorkThreadStore();
    const payment = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
    const episode = payment?.episodes.find((item) => item.sourceSessionId === 'payment-approaches');
    expect(episode).toMatchObject({
      activeMs: 14 * 60_000,
      spanMs: (76 * 60 + 13) * 60_000,
      startedAt: parseCanonicalInstant('2026-10-19T09:20:00.000Z'),
      endedAt: parseCanonicalInstant('2026-10-22T13:33:00.000Z'),
    });
    const unknown = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.unknownDuration);
    expect(unknown?.episodes[0]).toMatchObject({ activeMs: null, spanMs: 38 * 60_000 });
    expect(unknown?.row.thread.origin).toBe('session');
    expect(unknown?.row.marks.some((mark) => mark.label === 'Task created')).toBe(true);
    expect(unknown?.row.marks.some((mark) => mark.label === 'Source linked')).toBe(false);
    expect(payment?.row.markers.pullRequests[0]?.latest?.unresolvedReviewThreads).toBe(2);
    expect(payment?.row.marks.filter((mark) => mark.kind === 'session')).toHaveLength(4);
    expect(payment?.row.marks.some((mark) => mark.label === 'Check the retry invariant')).toBe(false);
    expect(payment?.row.marks.every((mark) => mark.label !== null && mark.label.length > 0)).toBe(true);
  });

  test('a PR-only task dates its work from source facts and labels opened and merged marks', async () => {
    const ports = createSyntheticWorkThreadStore();
    const detail = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.mergedPr);
    expect(detail?.row).toMatchObject({
      firstActivityAt: parseCanonicalInstant('2026-10-20T10:15:00.000Z'),
      sessionCount: 0,
      delegatedSessionCount: 0,
      thread: { origin: 'pull-request', createdAt: WORK_THREADS_SYNTHETIC_NOW },
    });
    expect(detail?.factEvents).toEqual([
      {
        at: parseCanonicalInstant('2026-10-20T10:15:00.000Z'),
        key: 'github.example/synthetic/example-shop#1502',
        kind: 'pull-request-opened',
        label: 'PR #1502',
        title: 'Verify the receipt export',
      },
      {
        at: parseCanonicalInstant('2026-10-23T14:49:00.000Z'),
        key: 'github.example/synthetic/example-shop#1502',
        kind: 'pull-request-merged',
        label: 'PR #1502',
        title: 'Verify the receipt export',
      },
    ]);
    expect(detail?.row.marks.map((mark) => mark.label)).toEqual(['PR #1502 opened', 'PR #1502 merged']);
    expect(detail?.events.map((event) => event.kind)).toEqual(['created', 'link-added']);
    expect(detail?.row.links[0]?.provenance).toBe('origin');
    expect(detail?.row.marks.every((mark) => mark.at !== WORK_THREADS_SYNTHETIC_NOW)).toBe(true);
    expect(parseWorkThreadsDetailOutput({ ok: true, data: detail }).ok).toBe(true);
  });

  test('source fact events follow active PR links without duplicating or becoming stored operator events', async () => {
    const ports = createSyntheticWorkThreadStore();
    const key = 'github.example/synthetic/example-shop#1502';
    const created = await ports.executeCommand({ ...create(), links: [{ key, kind: 'pull-request' }] });
    if (!created.ok) {
      throw new Error('Could not create the linked synthetic task.');
    }
    const before = await ports.readDetail(created.threadId);
    const association = before?.row.links.find((link) => link.key === key);
    if (!association) {
      throw new Error('The linked pull request is missing.');
    }
    expect(before?.factEvents).toHaveLength(2);
    expect(before?.row.firstActivityAt).toBe(parseCanonicalInstant('2026-10-20T10:15:00.000Z'));
    expect(before?.events.map((event) => event.kind)).toEqual(['created', 'link-added']);
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'detach-link',
      threadId: created.threadId,
      linkId: association.linkId,
    });
    const detached = await ports.readDetail(created.threadId);
    expect(detached?.factEvents).toEqual([]);
    expect(detached?.row.firstActivityAt).toBe(WORK_THREADS_SYNTHETIC_NOW);
    expect(detached?.row.marks.some((mark) => mark.label?.startsWith('PR #1502'))).toBe(false);
    const reattach = {
      commandId: crypto.randomUUID(),
      op: 'link' as const,
      threadId: created.threadId,
      key,
      kind: 'pull-request' as const,
    };
    await ports.executeCommand(reattach);
    await ports.executeCommand(reattach);
    const restored = await ports.readDetail(created.threadId);
    expect(restored?.factEvents).toEqual(before?.factEvents);
    expect(restored?.row.marks.filter((mark) => mark.label?.startsWith('PR #1502'))).toHaveLength(2);
    expect(restored?.events.map((event) => event.kind)).toEqual([
      'created',
      'link-added',
      'link-detached',
      'link-added',
    ]);
    expect(parseWorkThreadsDetailOutput({ ok: true, data: restored }).ok).toBe(true);
  });

  test('density scenarios include a long title, automatic session links, a draft and an honest disabled source', async () => {
    const ports = createSyntheticWorkThreadStore();
    const data = await ports.readList(query);
    expect(data.counts.open + data.counts.done).toBeGreaterThanOrEqual(12);
    const long = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.longTitle);
    expect(long?.row.thread.title.length).toBeGreaterThan(120);
    expect(long?.row.links.filter((link) => link.kind === 'session').map((link) => link.provenance)).toEqual([
      'declared',
      'declared',
    ]);
    expect(long?.events.filter((event) => event.kind === 'link-added')).toHaveLength(3);
    expect((await ports.readDetail(WORK_THREADS_FIXTURE_IDS.draft))?.row.markers.pullRequests[0]?.latest?.draft).toBe(
      true,
    );
    expect(data.sources.find((source) => source.source === 'jira')).toMatchObject({
      state: 'disabled',
      lastRunAt: parseCanonicalInstant('2026-10-23T09:00:00.000Z'),
    });
    expect(data.sources.find((source) => source.source === 'sessions')?.state).toBe('ok');
    expect(parseWorkThreadsListOutput({ ok: true, data }).ok).toBe(true);
  });

  test('relinking an automatic source shows the new operator mark without reviving its automatic predecessor', async () => {
    let clock = new Date(WORK_THREADS_SYNTHETIC_NOW);
    const ports = createSyntheticWorkThreadStore({ now: () => clock });
    const threadId = WORK_THREADS_FIXTURE_IDS.longTitle;
    const before = await ports.readDetail(threadId);
    const automaticLink = before?.row.links.find((link) => link.kind === 'session');
    if (!automaticLink) {
      throw new Error('Missing the automatically linked session.');
    }
    expect(before?.row.marks.filter((mark) => mark.label === 'Source linked')).toEqual([]);
    clock = new Date('2026-10-25T12:00:00.000Z');
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'detach-link',
      threadId,
      linkId: automaticLink.linkId,
    });
    clock = new Date('2026-10-25T13:00:00.000Z');
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'link',
      threadId,
      key: automaticLink.key,
      kind: 'session',
    });
    const after = await ports.readDetail(threadId);
    expect(after?.row.marks.filter((mark) => mark.label === 'Source linked')).toEqual([
      { at: parseCanonicalInstant('2026-10-25T13:00:00.000Z'), harness: null, kind: 'event', label: 'Source linked' },
    ]);
    expect(
      after?.events.filter((event) => event.kind === 'link-added' && event.linkKey === automaticLink.key),
    ).toHaveLength(2);
    expect(after?.row.marks.some((mark) => mark.label === 'Source detached')).toBe(true);
  });

  test('counts recursive delegation once even when descendants also have explicit links', async () => {
    const ports = createSyntheticWorkThreadStore();
    const payment = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
    const parent = payment?.episodes.find((episode) => episode.children.length > 0);
    const child = parent?.children[0];
    const parentLink = payment?.row.links.find((link) => link.key === parent?.linkKey);
    if (!(parent && child && parentLink)) {
      throw new Error('Missing the declared fixture delegation.');
    }
    const grandchild = {
      ...child,
      children: [],
      linkKey: 'session:fixture-machine/codex/nested-review',
      sourceSessionId: 'nested-review',
    };
    const nestedChild = { ...child, children: [grandchild] };
    const nestedParent = { ...parent, children: [nestedChild, nestedChild] };
    const linked = [nestedParent, nestedChild, grandchild].map((episode) => ({
      ...parentLink,
      key: episode.linkKey,
      linkId: crypto.randomUUID(),
    }));
    const projected = projectSyntheticWorkThreadEpisodes([nestedParent, nestedChild, grandchild], linked);
    expect(projected).toMatchObject({ sessionCount: 1, delegatedSessionCount: 2 });
    expect(projected.episodes).toHaveLength(1);
    expect(projected.episodes[0]?.children).toHaveLength(1);
    expect(projected.episodes[0]?.children[0]?.children.map((episode) => episode.linkKey)).toEqual([
      grandchild.linkKey,
    ]);
    expect(projectSyntheticWorkThreadEpisodes([nestedParent], [parentLink])).toMatchObject({
      sessionCount: 1,
      delegatedSessionCount: 2,
    });
  });

  test('a linked parent retains its declared child until explicitly detached; reattachment restores delegation', async () => {
    const ports = createSyntheticWorkThreadStore();
    const payment = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
    const parent = payment?.episodes.find((episode) => episode.children.length > 0);
    const child = parent?.children[0];
    if (!(parent && child)) {
      throw new Error('Missing the declared fixture delegation.');
    }
    const created = await ports.executeCommand({ ...create(), links: [{ kind: 'session', key: parent.linkKey }] });
    if (!created.ok) {
      throw new Error('Could not link the parent session.');
    }
    const threadId = created.threadId;
    expect((await ports.readDetail(threadId))?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
    const linkChild = {
      commandId: crypto.randomUUID(),
      op: 'link' as const,
      threadId,
      kind: 'session' as const,
      key: child.linkKey,
    };
    await ports.executeCommand(linkChild);
    const linked = await ports.readDetail(threadId);
    expect(linked?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
    expect(linked?.sources.find((source) => source.source === 'sessions')?.state).toBe('ok');
    const association = linked?.row.links.find((link) => link.key === child.linkKey);
    if (!association) {
      throw new Error('The explicit child link is missing.');
    }
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'detach-link',
      threadId,
      linkId: association.linkId,
    });
    const detached = await ports.readDetail(threadId);
    expect(detached?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 0 });
    expect(detached?.episodes[0]?.children).toEqual([]);
    await ports.executeCommand({ ...linkChild, commandId: crypto.randomUUID() });
    const restored = await ports.readDetail(threadId);
    expect(restored?.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
    expect(restored?.episodes[0]?.children.map((episode) => episode.linkKey)).toEqual([child.linkKey]);
    expect(parseWorkThreadsDetailOutput({ ok: true, data: restored }).ok).toBe(true);
    expect(parseWorkThreadsListOutput({ ok: true, data: await ports.readList(query) }).ok).toBe(true);
  });

  test.each(['ok', 'failed', 'unavailable'] as const)(
    'delegation never conceals a missing explicit session (source=%s)',
    async (state) => {
      const sources = [
        {
          source: 'sessions' as const,
          state,
          lastRunAt: WORK_THREADS_SYNTHETIC_NOW,
          message: 'Synthetic source status',
        },
      ];
      const ports = createSyntheticWorkThreadStore({ sources });
      const payment = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
      const parent = payment?.episodes.find((episode) => episode.children.length > 0);
      if (!parent) {
        throw new Error('Missing the declared fixture delegation.');
      }
      const input = {
        ...create(),
        title: 'Analysis with incomplete session evidence',
        links: [parent.linkKey, 'session:fixture-machine/codex/missing-review-check'].map((key) => ({
          kind: 'session' as const,
          key,
        })),
      };
      const created = await ports.executeCommand(input);
      if (!created.ok) {
        throw new Error('Could not create the analysis.');
      }
      const detail = await ports.readDetail(created.threadId);
      if (!detail) {
        throw new Error('Missing the created analysis.');
      }
      expect(detail.row).toMatchObject({ sessionCount: 1, delegatedSessionCount: 1 });
      const expectedState = state === 'ok' ? 'truncated' : state;
      expect(detail.sources[0]?.state).toBe(expectedState);
      const situation = threadSituationCopy(detail.row, detail.generatedAt, detail.sources);
      expect(situation.hint).toBe('undecided');
      expect(situation.remainders).toContainEqual(
        expect.objectContaining({ source: 'sessions', kind: 'source-unavailable', outcome: expectedState }),
      );
      const list = await ports.readList({ ...query, search: input.title });
      expect(list.sources).toEqual(detail.sources);
      expect(list.rows).toHaveLength(1);
      expect((await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments))?.sources).toEqual(sources);
    },
  );

  test('searches PR numbers and linked session titles; filters, pagination and cursor scope agree', async () => {
    const ports = createSyntheticWorkThreadStore();
    expect((await ports.readList({ ...query, search: '1487' })).rows.map((row) => row.thread.threadId)).toEqual([
      WORK_THREADS_FIXTURE_IDS.payments,
    ]);
    expect(
      (await ports.readList({ ...query, search: 'retry approaches' })).rows.map((row) => row.thread.threadId),
    ).toEqual([WORK_THREADS_FIXTURE_IDS.payments]);
    expect((await ports.readList({ ...query, project: 'ai-usage' })).rows).toHaveLength(1);
    const first = await ports.readList({ ...query, limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await ports.readList({ ...query, cursor: first.nextCursor, limit: 2 });
    expect(new Set([...first.rows, ...second.rows].map((row) => row.thread.threadId)).size).toBe(4);
    await expect(ports.readList({ ...query, cursor: first.nextCursor, project: 'ai-usage' })).rejects.toThrow('cursor');
    expect((await ports.readList({ ...query, search: 'missing query' })).rows).toEqual([]);
  });

  test('preserves a source failure independently of an empty result', async () => {
    const ports = createSyntheticWorkThreadStore({
      seed: false,
      sources: [{ lastRunAt: null, message: 'Authentication required', source: 'github', state: 'unauthenticated' }],
    });
    expect(await ports.readList(query)).toMatchObject({ rows: [], sources: [{ state: 'unauthenticated' }] });
  });

  test('unknown linked sources stay unknown and newer activity never reopens Done', async () => {
    let clock = new Date(WORK_THREADS_SYNTHETIC_NOW);
    const ports = createSyntheticWorkThreadStore({ now: () => clock });
    const threadId = WORK_THREADS_FIXTURE_IDS.analysis;
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      key: 'session:fixture-machine/codex/not-served',
      kind: 'session',
      op: 'link',
      threadId,
    });
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      key: 'github.example/synthetic/shop#404',
      kind: 'pull-request',
      op: 'link',
      threadId,
    });
    const unknown = await ports.readDetail(threadId);
    expect(unknown?.row.sessionCount).toBe(1);
    expect(unknown?.row.links.filter((link) => link.kind === 'session')).toHaveLength(2);
    expect(unknown?.row.markers.pullRequests[0]).toMatchObject({ latest: null, latestSuccessful: null });
    await ports.executeCommand(close(threadId));
    clock = new Date('2026-10-25T11:00:00.000Z');
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      note: 'A later observation to consider',
      op: 'set-note',
      threadId,
    });
    const later = await ports.readDetail(threadId);
    expect(later?.row.thread.followState).toBe('done');
    expect(later?.row.afterDone).toEqual({ count: 1, latestAt: parseCanonicalInstant('2026-10-25T11:00:00.000Z') });
  });

  test('returns snapshots that cannot mutate process state', async () => {
    const ports = createSyntheticWorkThreadStore();
    const first = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.analysis);
    if (!first) {
      throw new Error('Missing fixture');
    }
    Object.assign(first.row.thread, { title: 'Changed outside the command port' });
    expect((await ports.readDetail(WORK_THREADS_FIXTURE_IDS.analysis))?.row.thread.title).toBe(
      'Understand a declined payment',
    );
  });
});

describe('synthetic work thread commands', () => {
  test.each([false, true])('caps total tasks including seeds and preserves command retries (seed=%s)', async (seed) => {
    const ports = createSyntheticWorkThreadStore({ seed });
    const initial = (await ports.readList(query)).counts;
    const firstCommand = create();
    const accepted = await ports.executeCommand(firstCommand);
    if (!accepted.ok) {
      throw new Error('The first synthetic task should fit below the limit.');
    }
    for (let count = initial.open + initial.done + 1; count < 200; count += 1) {
      expect(await ports.executeCommand(create())).toMatchObject({ applied: true, ok: true });
    }
    const atCapacity = (await ports.readList(query)).counts;
    expect(atCapacity.open + atCapacity.done).toBe(200);

    const overflow = { ...create(), title: 'A task beyond capacity' };
    const refused = await ports.executeCommand(overflow);
    expect(parseWorkThreadsCommandOutput(refused)).toEqual({
      currentRevision: null,
      failure: 'invalid-transition',
      message: 'Synthetic demo has reached its limit of 200 tasks. Restart the demo to create more.',
      ok: false,
    });
    expect(await ports.executeCommand(firstCommand)).toEqual({ ...accepted, applied: false });
    expect(await ports.executeCommand(overflow)).toEqual(refused);
    expect((await ports.readList(query)).counts).toEqual(atCapacity);
    expect((await ports.readDetail(accepted.threadId))?.events).toHaveLength(1);

    // Existing follow-up commands still work at capacity; Done tasks remain part of the limit.
    expect(await ports.executeCommand(close(accepted.threadId))).toMatchObject({ followRevision: 2, ok: true });
    expect(await ports.executeCommand(create())).toEqual(refused);
    expect(await ports.executeCommand(overflow)).toEqual(refused);
    expect(await ports.executeCommand(firstCommand)).toEqual({ ...accepted, applied: false });
    expect((await ports.readList(query)).counts).toEqual({ done: atCapacity.done + 1, open: atCapacity.open - 1 });
    expect((await ports.readDetail(accepted.threadId))?.events).toHaveLength(2);
    expect((await ports.readList({ ...query, search: overflow.title })).rows).toEqual([]);

    // Refused retries with fresh command ids cannot grow the process: the oldest receipts give way
    // and the store still answers with the same counts.
    for (let retry = 0; retry < 2100; retry += 1) {
      await ports.executeCommand(create());
    }
    expect((await ports.readList(query)).counts).toEqual({ done: atCapacity.done + 1, open: atCapacity.open - 1 });
    // An evicted receipt is re-evaluated: the capacity refuses it, so it still creates no duplicate.
    expect(await ports.executeCommand(firstCommand)).toMatchObject({ ok: false });
    expect((await ports.readList(query)).counts).toEqual({ done: atCapacity.done + 1, open: atCapacity.open - 1 });

    const independent = createSyntheticWorkThreadStore({ seed });
    expect(await independent.executeCommand(create())).toMatchObject({ applied: true, ok: true });
    expect((await independent.readList(query)).counts).toEqual({ done: initial.done, open: initial.open + 1 });
  });

  test('create is idempotent and stores its links and creation history', async () => {
    const ports = createSyntheticWorkThreadStore({ seed: false });
    const input = { ...create(), links: [{ key: 'github.example/synthetic/shop#2', kind: 'pull-request' as const }] };
    const created = await ports.executeCommand(input);
    expect(created).toMatchObject({ applied: true, followRevision: 1, ok: true });
    if (!created.ok) {
      throw new Error('Create failed');
    }
    expect(await ports.executeCommand(input)).toEqual({ ...created, applied: false });
    expect((await ports.readList(query)).rows).toHaveLength(1);
    const detail = await ports.readDetail(created.threadId);
    expect(detail?.events.map((event) => event.kind)).toEqual(['created', 'link-added']);
    expect(detail?.row.links).toHaveLength(1);
  });

  test('a known source keeps the same observations when explicitly linked to another task', async () => {
    const ports = createSyntheticWorkThreadStore();
    const created = await ports.executeCommand({
      ...create(),
      links: [{ key: 'github.example/synthetic/example-shop#1487', kind: 'pull-request' }],
    });
    if (!created.ok) {
      throw new Error('Create failed');
    }
    expect((await ports.readDetail(created.threadId))?.row.markers.pullRequests[0]).toEqual(
      (await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments))?.row.markers.pullRequests[0],
    );
  });

  test('close records acknowledged remainders and never mutates source markers or session episodes; reopen reverses follow state', async () => {
    const ports = createSyntheticWorkThreadStore();
    const before = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
    const command = {
      ...close(WORK_THREADS_FIXTURE_IDS.payments),
      acknowledgedRemainders: ['PR #1487 is still open'],
      reason: 'Another person will finish this',
    };
    const closed = await ports.executeCommand(command);
    expect(closed).toMatchObject({ applied: true, followRevision: 2, ok: true });
    const after = await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
    expect(after?.row.thread).toMatchObject({
      doneAt: WORK_THREADS_SYNTHETIC_NOW,
      doneReason: command.reason,
      followState: 'done',
    });
    expect(after?.events.at(-1)).toMatchObject({
      acknowledgedRemainders: command.acknowledgedRemainders,
      fromState: 'following',
      kind: 'follow-state',
      toState: 'done',
    });
    expect(after?.row.markers).toEqual(before?.row.markers);
    expect(after?.episodes).toEqual(before?.episodes);
    expect((await ports.readList({ ...query, tab: 'done' })).rows.map((row) => row.thread.threadId)).toContain(
      WORK_THREADS_FIXTURE_IDS.payments,
    );
    expect(
      await ports.executeCommand({ ...command, commandId: crypto.randomUUID(), expectedRevision: 2, to: 'following' }),
    ).toMatchObject({ followRevision: 3, ok: true });
    expect((await ports.readDetail(WORK_THREADS_FIXTURE_IDS.payments))?.row.thread).toMatchObject({
      doneAt: null,
      doneReason: null,
      followState: 'following',
    });
  });

  test('replayed command ids never apply twice, even after another transition', async () => {
    const ports = createSyntheticWorkThreadStore();
    const command = close();
    const first = await ports.executeCommand(command);
    if (!first.ok) {
      throw new Error('Close failed');
    }
    await ports.executeCommand({ ...close(), expectedRevision: 2, to: 'following' });
    expect(await ports.executeCommand(command)).toEqual({ ...first, applied: false });
    expect((await ports.readDetail(command.threadId))?.row.thread.followRevision).toBe(3);
  });

  test('two tabs cannot overwrite a newer follow-state revision and failure replay stays failed', async () => {
    const ports = createSyntheticWorkThreadStore();
    await ports.executeCommand(close());
    const stale = { ...close(), to: 'waiting' as const, waitingFor: 'A product answer' };
    const conflict = await ports.executeCommand(stale);
    expect(conflict).toMatchObject({ currentRevision: 2, failure: 'revision-conflict', ok: false });
    expect(await ports.executeCommand(stale)).toEqual(conflict);
    expect((await ports.readDetail(stale.threadId))?.row.thread.followState).toBe('done');
  });

  test('waits require a linked source and Done must reopen before restoring a prior wait', async () => {
    const ports = createSyntheticWorkThreadStore();
    const input = {
      ...close(WORK_THREADS_FIXTURE_IDS.payments),
      to: 'waiting' as const,
      waitingFor: 'Human review',
      waitingOn: {
        kind: 'pull-request-review' as const,
        linkKey: 'github.example/synthetic/example-shop#1487',
        since: WORK_THREADS_SYNTHETIC_NOW,
      },
    };
    expect(
      await ports.executeCommand({
        ...input,
        commandId: crypto.randomUUID(),
        waitingOn: { ...input.waitingOn, linkKey: 'github.example/synthetic/example-shop#42' },
      }),
    ).toMatchObject({ failure: 'invalid-link', ok: false });
    expect(await ports.executeCommand(input)).toMatchObject({ followRevision: 2, ok: true });
    expect((await ports.readDetail(input.threadId))?.row.thread).toMatchObject({
      waitingFor: 'Human review',
      waitingOn: input.waitingOn,
    });
    await ports.executeCommand({ ...close(input.threadId), expectedRevision: 2 });
    const done = await ports.readDetail(input.threadId);
    const invalidRestore = { ...input, commandId: crypto.randomUUID(), expectedRevision: 3 };
    const refused = await ports.executeCommand(invalidRestore);
    expect(refused).toMatchObject({ currentRevision: 3, failure: 'invalid-transition', ok: false });
    expect(await ports.readDetail(input.threadId)).toEqual(done);
    expect(
      await ports.executeCommand({ ...close(input.threadId), expectedRevision: 3, to: 'following' }),
    ).toMatchObject({ followRevision: 4, ok: true });
    expect(await ports.executeCommand(invalidRestore)).toEqual(refused);
    expect(await ports.executeCommand({ ...input, commandId: crypto.randomUUID(), expectedRevision: 4 })).toMatchObject(
      { followRevision: 5, ok: true },
    );
    expect((await ports.readDetail(input.threadId))?.row.thread).toMatchObject({
      followState: 'waiting',
      waitingFor: input.waitingFor,
      waitingOn: input.waitingOn,
    });
  });

  test('links the existing served synthetic session, detaches it and preserves the association history', async () => {
    const ports = createSyntheticWorkThreadStore();
    const input: WorkThreadCommand = {
      commandId: crypto.randomUUID(),
      key: 'session:fixture-machine/codex/campaign-root',
      kind: 'session',
      op: 'link',
      threadId: WORK_THREADS_FIXTURE_IDS.sessions,
    };
    expect(await ports.executeCommand(input)).toMatchObject({ applied: true, followRevision: 1, ok: true });
    const linked = await ports.readDetail(input.threadId);
    expect(parseWorkThreadsDetailOutput({ data: linked, ok: true }).ok).toBe(true);
    expect(parseWorkThreadsListOutput({ data: await ports.readList(query), ok: true }).ok).toBe(true);
    expect(linked?.row.sessionCount).toBe(2);
    expect(linked?.episodes.map((episode) => episode.title)).toContain('Build report UI');
    expect(await ports.executeCommand({ ...input, commandId: crypto.randomUUID() })).toMatchObject({
      applied: false,
      ok: true,
    });
    const link = linked?.row.links.find((item) => item.key === input.key);
    if (!link) {
      throw new Error('Link missing');
    }
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      linkId: link.linkId,
      op: 'detach-link',
      threadId: input.threadId,
    });
    const detached = await ports.readDetail(input.threadId);
    expect(parseWorkThreadsDetailOutput({ data: detached, ok: true }).ok).toBe(true);
    expect(parseWorkThreadsListOutput({ data: await ports.readList(query), ok: true }).ok).toBe(true);
    expect(detached?.row.sessionCount).toBe(1);
    expect(detached?.episodes.map((episode) => episode.title)).not.toContain('Build report UI');
    expect(detached?.detachedLinks).toEqual([{ ...link, detachedAt: WORK_THREADS_SYNTHETIC_NOW }]);
    await ports.executeCommand({ ...input, commandId: crypto.randomUUID() });
    const reattached = await ports.readDetail(input.threadId);
    expect(parseWorkThreadsDetailOutput({ data: reattached, ok: true }).ok).toBe(true);
    expect(parseWorkThreadsListOutput({ data: await ports.readList(query), ok: true }).ok).toBe(true);
    expect(reattached?.row.sessionCount).toBe(2);
    expect(reattached?.detachedLinks).toHaveLength(1);
    expect(reattached?.row.links.find((item) => item.key === input.key)?.linkId).not.toBe(link.linkId);
  });

  test('note and rename are visible, idempotent, clearable, and do not change followRevision', async () => {
    const ports = createSyntheticWorkThreadStore();
    const threadId = WORK_THREADS_FIXTURE_IDS.analysis;
    const note: WorkThreadCommand = {
      commandId: crypto.randomUUID(),
      note: 'Review the customer explanation',
      op: 'set-note',
      threadId,
    };
    expect(await ports.executeCommand(note)).toMatchObject({ applied: true, followRevision: 1, ok: true });
    expect(await ports.executeCommand(note)).toMatchObject({ applied: false, ok: true });
    await ports.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'rename',
      threadId,
      title: 'Explain the bank response',
    });
    expect((await ports.readDetail(threadId))?.row.thread).toMatchObject({
      note: note.note,
      title: 'Explain the bank response',
    });
    await ports.executeCommand({ ...note, commandId: crypto.randomUUID(), note: null });
    expect((await ports.readDetail(threadId))?.row.thread.note).toBeNull();
  });

  test('repeated corrections retain association events while detached projections stay within the wire bound', async () => {
    const ports = createSyntheticWorkThreadStore();
    const threadId = WORK_THREADS_FIXTURE_IDS.sessions;
    const key = 'session:fixture-machine/codex/campaign-root';
    for (let index = 0; index < 65; index += 1) {
      await ports.executeCommand({ commandId: crypto.randomUUID(), key, kind: 'session', op: 'link', threadId });
      const linked = await ports.readDetail(threadId);
      const link = linked?.row.links.find((candidate) => candidate.key === key);
      if (!link) {
        throw new Error('Link missing');
      }
      await ports.executeCommand({ commandId: crypto.randomUUID(), linkId: link.linkId, op: 'detach-link', threadId });
    }
    const data = await ports.readDetail(threadId);
    expect(data?.detachedLinks).toHaveLength(64);
    expect(data?.events.filter((event) => event.kind === 'link-detached')).toHaveLength(65);
    expect(parseWorkThreadsDetailOutput({ data, ok: true }).ok).toBe(true);
    expect(parseWorkThreadsListOutput({ data: await ports.readList(query), ok: true }).ok).toBe(true);
  });

  test('not-found, invalid-link, same-state transitions and invalid commands remain visible', async () => {
    const ports = createSyntheticWorkThreadStore();
    expect(await ports.executeCommand({ ...close(), threadId: crypto.randomUUID() })).toMatchObject({
      failure: 'not-found',
      ok: false,
    });
    expect(await ports.executeCommand({ ...close(), to: 'following' })).toMatchObject({
      failure: 'invalid-transition',
      ok: false,
    });
    expect(
      await ports.executeCommand({
        commandId: crypto.randomUUID(),
        linkId: crypto.randomUUID(),
        op: 'detach-link',
        threadId: WORK_THREADS_FIXTURE_IDS.analysis,
      }),
    ).toMatchObject({ failure: 'invalid-link', ok: false });
    await expect(executeWorkThreadCommandForServer({ ...close(), commandId: 'invalid' }, { ports })).rejects.toThrow(
      'invalid',
    );
  });
});
