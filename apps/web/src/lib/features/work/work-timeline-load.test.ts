import { describe, expect, test } from 'bun:test';
import type { WorkThreadRow, WorkThreadSourceStatus } from '@ai-usage/report-core/work-thread-view';
import {
  parseWorkThreadsListOutput,
  type WorkThreadsListInput,
  type WorkThreadsListOutput,
} from '@ai-usage/web-contract/work-threads';
import { QueryClient } from '@tanstack/svelte-query';
import { createSyntheticWorkThreadStore } from '../../../server/work-threads-e2e-fixture.server';
import { collectionSwrKey } from '../../query/keys';
import {
  invalidateWorkThreadListQueries,
  workThreadListKey,
  workThreadTimelineQueryOptions,
} from '../../query/options/work-threads';
import { webQueryPolicies } from '../../query/policies';
import type { WorkThreadsClient } from '../../rpc/work-threads-client';
import { readWorkTimeline, TIMELINE_MAX_PAGES } from './work-timeline-load';
import { timelineDomain, timelineLanes, timelineScale } from './work-timeline-model';

const seed = await createSyntheticWorkThreadStore().readList({
  cursor: null,
  limit: 100,
  project: null,
  search: null,
  tab: 'open',
});
const template = seed.rows[0];
if (!template) {
  throw new Error('Expected a synthetic task row');
}
const row = (id: number): WorkThreadRow => ({
  ...template,
  thread: { ...template.thread, threadId: `15000000-0000-4000-8000-${String(id).padStart(12, '0')}` },
});
/** A task whose only open question is whether its linked session was read. */
const linked = (id: number): WorkThreadRow => {
  const base = row(id);
  return {
    ...base,
    afterDone: null,
    combinedThreads: [],
    delegatedSessionCount: 0,
    links: [],
    markers: { jiraIssues: [], local: [], pullRequests: [] },
    marks: [],
    nativeRequestCoverage: 'complete',
    nativeRequests: [],
    runningSessions: 0,
    sessionCount: 1,
    thread: { ...base.thread, followState: 'following', intent: 'analysis', waitingFor: null, waitingOn: null },
  };
};
const ids = (rows: readonly WorkThreadRow[]): readonly string[] => rows.map((item) => item.thread.threadId);
const ok = (source: WorkThreadSourceStatus['source']): WorkThreadSourceStatus => ({
  lastRunAt: seed.generatedAt,
  message: null,
  source,
  state: 'ok',
});

interface PageInput {
  readonly counts?: { readonly done: number; readonly open: number };
  readonly generatedAt?: string;
  readonly nextCursor?: string | null;
  readonly projects?: readonly string[];
  readonly rows?: readonly WorkThreadRow[];
  readonly sources?: readonly WorkThreadSourceStatus[];
}
/** Parsed like a real answer, so a page the contract would refuse cannot pass for one here. */
const page = (input: PageInput = {}): WorkThreadsListOutput =>
  parseWorkThreadsListOutput({
    ok: true,
    data: {
      ...seed,
      counts: input.counts ?? { done: 0, open: 0 },
      generatedAt: input.generatedAt ?? seed.generatedAt,
      nextCursor: input.nextCursor ?? null,
      projects: input.projects ?? [],
      rows: input.rows ?? [],
      sources: input.sources ?? [],
    },
  });
const unavailable: WorkThreadsListOutput = {
  ok: false,
  error: { tag: 'Unavailable', message: 'Tasks are unavailable.' },
};

interface Call {
  readonly input: WorkThreadsListInput;
  readonly signal: AbortSignal | undefined;
}
/** Answers by `tab` and cursor; a page the test did not script is a test error, not an empty page. */
const scripted = (pages: Readonly<Record<string, WorkThreadsListOutput>>) => {
  const calls: Call[] = [];
  const client: Pick<WorkThreadsClient, 'list'> = {
    list: (input, options) => {
      calls.push({ input, signal: options?.signal });
      const answer = pages[`${input.tab}:${input.cursor ?? ''}`];
      return answer
        ? Promise.resolve(answer)
        : Promise.reject(new Error(`Unscripted page ${input.tab}:${input.cursor}`));
    },
  };
  return { calls, client };
};
const unfiltered = { project: null, search: null };

describe('reading the whole task timeline', () => {
  test('follows the cursors of the followed tasks, then of the ended follow-ups, at the largest page size', async () => {
    const { calls, client } = scripted({
      'open:': page({
        counts: { done: 3, open: 4 },
        generatedAt: '2026-11-11T10:00:00.000Z',
        nextCursor: 'open-2',
        projects: ['acme/shop', 'other/tools'],
        rows: [row(1), row(2)],
      }),
      'open:open-2': page({
        counts: { done: 9, open: 9 },
        generatedAt: '2026-11-11T10:00:05.000Z',
        projects: ['later'],
        rows: [row(3), row(4)],
      }),
      'done:': page({ nextCursor: 'done-2', rows: [row(5), row(6)] }),
      'done:done-2': page({ rows: [row(7)] }),
    });
    const result = await readWorkTimeline(client, { project: 'acme/shop', search: 'retry' });
    expect(calls.map((call) => call.input)).toEqual([
      { cursor: null, limit: 100, project: 'acme/shop', search: 'retry', tab: 'open' },
      { cursor: 'open-2', limit: 100, project: 'acme/shop', search: 'retry', tab: 'open' },
      { cursor: null, limit: 100, project: 'acme/shop', search: 'retry', tab: 'done' },
      { cursor: 'done-2', limit: 100, project: 'acme/shop', search: 'retry', tab: 'done' },
    ]);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(ids(result.data.rows)).toEqual(ids([1, 2, 3, 4, 5, 6, 7].map(row)));
    expect(result.data.loaded).toEqual({ done: 3, open: 4 });
    expect(result.data.complete).toBe(true);
    // The first page dates and counts the read; later pages only add rows.
    expect(result.data.counts).toEqual({ done: 3, open: 4 });
    expect<string>(result.data.generatedAt).toBe('2026-11-11T10:00:00.000Z');
    expect(result.data.projects).toEqual(['acme/shop', 'other/tools']);
  });
  test('a task returned twice is kept once, where it first appeared, and counted once', async () => {
    const { client } = scripted({
      'open:': page({ nextCursor: 'open-2', rows: [row(1), row(2)] }),
      // The list moved between two page reads: one row repeats, and one was ended meanwhile.
      'open:open-2': page({ rows: [row(2), row(3)] }),
      'done:': page({ rows: [row(3), row(4), row(4)] }),
    });
    const result = await readWorkTimeline(client, unfiltered);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(ids(result.data.rows)).toEqual(ids([1, 2, 3, 4].map(row)));
    expect(result.data.loaded).toEqual({ done: 1, open: 3 });
  });
  test('both tabs can be empty: that is a complete read of nothing', async () => {
    const { calls, client } = scripted({ 'open:': page(), 'done:': page() });
    const result = await readWorkTimeline(client, unfiltered);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      ok: true,
      data: { complete: true, counts: { done: 0, open: 0 }, loaded: { done: 0, open: 0 }, rows: [], sources: [] },
    });
  });
  test('stops at the page cap of a tab and says the read is not complete', async () => {
    const calls: Call[] = [];
    const client: Pick<WorkThreadsClient, 'list'> = {
      list: (input, options) => {
        calls.push({ input, signal: options?.signal });
        const index = calls.length;
        return Promise.resolve(
          input.tab === 'done'
            ? page({ counts: { done: 5000, open: 1 }, nextCursor: `done-${index}`, rows: [row(index)] })
            : page({ counts: { done: 5000, open: 1 }, rows: [row(index)] }),
        );
      },
    };
    const result = await readWorkTimeline(client, unfiltered);
    expect(calls.map((call): string => call.input.tab)).toEqual([
      'open',
      ...Array.from({ length: TIMELINE_MAX_PAGES }, () => 'done'),
    ]);
    expect(calls.at(-1)?.input.cursor).toBe(`done-${TIMELINE_MAX_PAGES}`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.data.complete).toBe(false);
    expect(result.data.loaded).toEqual({ done: TIMELINE_MAX_PAGES, open: 1 });
    expect(result.data.rows).toHaveLength(TIMELINE_MAX_PAGES + 1);
  });
  test('a capped first tab still reads the second, and exactly the cap is complete', async () => {
    const calls: Call[] = [];
    const client: Pick<WorkThreadsClient, 'list'> = {
      list: (input) => {
        calls.push({ input, signal: undefined });
        const index = calls.length;
        const last = input.tab === 'done' && index === 2 * TIMELINE_MAX_PAGES;
        return Promise.resolve(page({ nextCursor: last ? null : `${input.tab}-${index}`, rows: [row(index)] }));
      },
    };
    const result = await readWorkTimeline(client, unfiltered);
    expect(calls.filter((call) => call.input.tab === 'open')).toHaveLength(TIMELINE_MAX_PAGES);
    expect(calls.filter((call) => call.input.tab === 'done')).toHaveLength(TIMELINE_MAX_PAGES);
    expect(result).toMatchObject({
      ok: true,
      data: { complete: false, loaded: { done: TIMELINE_MAX_PAGES, open: TIMELINE_MAX_PAGES } },
    });
    // Ten full pages whose last one has no cursor are everything there was.
    const exact: Call[] = [];
    const whole = await readWorkTimeline(
      {
        list: (input) => {
          exact.push({ input, signal: undefined });
          const pagesOfTab = exact.filter((call) => call.input.tab === input.tab).length;
          return Promise.resolve(
            page({ nextCursor: pagesOfTab === TIMELINE_MAX_PAGES ? null : `${input.tab}-${pagesOfTab}` }),
          );
        },
      },
      unfiltered,
    );
    expect(exact).toHaveLength(2 * TIMELINE_MAX_PAGES);
    expect(whole).toMatchObject({ ok: true, data: { complete: true } });
  });
  test('one failed page fails the whole read instead of returning the pages before it', async () => {
    const later = scripted({
      'open:': page({ nextCursor: 'open-2', rows: [row(1)] }),
      'open:open-2': unavailable,
      'done:': page({ rows: [row(2)] }),
    });
    expect(await readWorkTimeline(later.client, unfiltered)).toEqual({
      ok: false,
      error: { message: 'Tasks are unavailable.' },
    });
    // Nothing is read after the failure.
    expect(later.calls.map((call) => `${call.input.tab}:${call.input.cursor}`)).toEqual(['open:null', 'open:open-2']);
    const ended = scripted({ 'open:': page({ rows: [row(1)] }), 'done:': unavailable });
    expect(await readWorkTimeline(ended.client, unfiltered)).toEqual({
      ok: false,
      error: { message: 'Tasks are unavailable.' },
    });
    const first = scripted({ 'open:': unavailable });
    expect(await readWorkTimeline(first.client, unfiltered)).toMatchObject({ ok: false });
    expect(first.calls).toHaveLength(1);
  });
  test('a page read that throws rejects the read', async () => {
    const { client } = scripted({ 'open:': page({ nextCursor: 'missing' }) });
    await expect(readWorkTimeline(client, unfiltered)).rejects.toThrow('Unscripted page open:missing');
  });
  test('every page read carries the abort signal', async () => {
    const { calls, client } = scripted({
      'open:': page({ nextCursor: 'open-2' }),
      'open:open-2': page(),
      'done:': page(),
    });
    const controller = new AbortController();
    await readWorkTimeline(client, unfiltered, { signal: controller.signal });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    const unsignalled = scripted({ 'open:': page(), 'done:': page() });
    await readWorkTimeline(unsignalled.client, unfiltered);
    expect(unsignalled.calls.every((call) => call.signal === undefined)).toBe(true);
  });
  test('an aborted read makes no further page read and rejects with the abort', async () => {
    const before = scripted({ 'open:': page(), 'done:': page() });
    const aborted = new AbortController();
    aborted.abort();
    await expect(readWorkTimeline(before.client, unfiltered, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(before.calls).toHaveLength(0);

    const controller = new AbortController();
    const calls: Call[] = [];
    const during: Pick<WorkThreadsClient, 'list'> = {
      list: (input, options) => {
        calls.push({ input, signal: options?.signal });
        // The view went away while the first page was in flight.
        controller.abort();
        return Promise.resolve(page({ nextCursor: 'open-2', rows: [row(1)] }));
      },
    };
    await expect(readWorkTimeline(during, unfiltered, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(1);

    const rejecting: Pick<WorkThreadsClient, 'list'> = {
      list: () => Promise.reject(new DOMException('The read was aborted.', 'AbortError')),
    };
    await expect(readWorkTimeline(rejecting, unfiltered)).rejects.toMatchObject({ name: 'AbortError' });
  });
  test('a source keeps its first status unless a later page reports it unavailable', async () => {
    const failed: WorkThreadSourceStatus = { ...ok('github'), message: 'The GitHub read failed.', state: 'failed' };
    const disabled: WorkThreadSourceStatus = { ...ok('jira'), message: 'Jira is disabled.', state: 'disabled' };
    const truncated: WorkThreadSourceStatus = { ...ok('sessions'), message: 'Partial.', state: 'truncated' };
    const stale: WorkThreadSourceStatus = { ...ok('checkouts'), lastRunAt: null };
    const { client } = scripted({
      'open:': page({ nextCursor: 'open-2', sources: [ok('github'), disabled, ok('checkouts')] }),
      'open:open-2': page({ sources: [failed, ok('jira'), truncated, stale] }),
      'done:': page({
        sources: [
          ok('github'),
          { ...disabled, message: 'Jira sign-in required.', state: 'unauthenticated' },
          ok('sessions'),
        ],
      }),
    });
    const result = await readWorkTimeline(client, unfiltered);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.data.sources).toEqual([
      // Replaced: a later page could not read GitHub, so no task of this read is known up to date.
      failed,
      // Kept: the first unavailable status stands, neither a later 'ok' nor another failure replaces it.
      disabled,
      // Kept: a later 'ok' never replaces an 'ok'.
      ok('checkouts'),
      // Added: a source the first page did not report.
      truncated,
    ]);
  });
  test('each task keeps the source statuses of the page it was read from, so its hint is the list one', async () => {
    const unread: WorkThreadSourceStatus = { ...ok('sessions'), message: 'Collection failed.', state: 'failed' };
    const { client } = scripted({
      'open:': page({ nextCursor: 'open-2', rows: [linked(1)], sources: [ok('sessions'), ok('github')] }),
      // The first task repeats on a page that could not read the sessions: its first read stands.
      'open:open-2': page({ rows: [linked(2), linked(1)], sources: [unread] }),
      'done:': page({ rows: [linked(3)], sources: [ok('sessions')] }),
    });
    const result = await readWorkTimeline(client, unfiltered);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const { data } = result;
    expect([...data.rowSources]).toEqual([
      [linked(1).thread.threadId, [ok('sessions'), ok('github')]],
      [linked(2).thread.threadId, [unread]],
      [linked(3).thread.threadId, [ok('sessions')]],
    ]);
    // What is displayed stays the worst of all pages.
    expect(data.sources).toEqual([unread, ok('github')]);
    const hints = (sourcesOf: (threadId: string) => readonly WorkThreadSourceStatus[]) =>
      timelineLanes({
        grouping: 'attention',
        now: data.generatedAt,
        rows: data.rows,
        scale: timelineScale(timelineDomain(data.generatedAt, 'UTC', []), data.generatedAt, 'UTC'),
        sourcesOf,
      }).map((lane) => [lane.key, ids(lane.tasks.map((task) => task.row))]);
    expect(hints((threadId) => data.rowSources.get(threadId) ?? data.sources)).toEqual([
      ['undecided', ids([linked(2)])],
      ['ready-to-close', ids([linked(1), linked(3)])],
    ]);
    // Qualified by the worst of all pages, the two tasks whose sessions were read would be left to decide.
    expect(hints(() => data.sources)).toEqual([['undecided', ids([linked(1), linked(2), linked(3)])]]);
  });
});

describe('the task timeline query', () => {
  const context = { browser: true, enabled: true };
  const { client } = scripted({ 'open:': page({ rows: [row(1)] }), 'done:': page() });

  test('is keyed by its filter under the task list prefix, on the collected-facts policy', () => {
    const options = workThreadTimelineQueryOptions(client, { project: 'acme/shop', search: 'retry' }, context);
    expect([...options.queryKey]).toEqual([
      ...collectionSwrKey('work-threads', 'list', 'timeline', JSON.stringify(['acme/shop', 'retry'])),
    ]);
    expect(options.queryKey.slice(0, 4)).toEqual([...collectionSwrKey('work-threads', 'list')]);
    expect(options).toMatchObject(webQueryPolicies.collectionFactsSwr);
    expect(options.enabled).toBe(true);
    expect(workThreadTimelineQueryOptions(client, unfiltered, { browser: false, enabled: true }).enabled).toBe(false);
    expect(workThreadTimelineQueryOptions(client, unfiltered, { browser: true, enabled: false }).enabled).toBe(false);
  });
  test('each filter is its own read, distinct from every page of the task list', () => {
    const keys = [
      workThreadTimelineQueryOptions(client, unfiltered, context).queryKey,
      workThreadTimelineQueryOptions(client, { project: 'acme/shop', search: null }, context).queryKey,
      workThreadTimelineQueryOptions(client, { project: null, search: 'acme/shop' }, context).queryKey,
      workThreadListKey({ cursor: null, limit: 100, project: null, search: null, tab: 'open' }),
    ].map((key) => JSON.stringify(key));
    expect(new Set(keys).size).toBe(keys.length);
  });
  test('reads through the timeline loader and is refreshed with the task list', async () => {
    const queryClient = new QueryClient();
    const options = workThreadTimelineQueryOptions(client, unfiltered, context);
    const result = await queryClient.fetchQuery(options);
    expect(result).toMatchObject({ ok: true, data: { complete: true, loaded: { done: 0, open: 1 } } });
    expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
    await invalidateWorkThreadListQueries(queryClient);
    expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  });
});
