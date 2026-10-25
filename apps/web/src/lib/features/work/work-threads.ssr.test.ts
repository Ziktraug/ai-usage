import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import {
  createSyntheticWorkThreadStore,
  WORK_THREADS_FIXTURE_IDS,
} from '../../../server/work-threads-e2e-fixture.server';
import { threadListQuery } from './work-thread-model';

const SUMMARY_CONTENT = /<summary[^>]*>(.*?)<\/summary>/;

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());

const component = async (name: string): Promise<Component> => {
  const module: unknown = await server.ssrLoadModule(`/apps/web/src/lib/features/work/${name}.svelte`);
  if (!(typeof module === 'object' && module !== null && 'default' in module && typeof module.default === 'function')) {
    throw new Error(`Missing ${name} component`);
  }
  return module.default as Component;
};
const renderer: unknown = await server.ssrLoadModule('svelte/server');
if (
  !(typeof renderer === 'object' && renderer !== null && 'render' in renderer && typeof renderer.render === 'function')
) {
  throw new Error('Svelte server renderer unavailable');
}
const render = renderer.render as (
  component: Component,
  options: { props: Record<string, unknown> },
) => { body: string };
const [List, Detail, Episode, Markers, Sources] = await Promise.all(
  ['work-thread-list', 'work-thread-detail', 'work-thread-episode', 'work-thread-markers', 'work-thread-sources'].map(
    component,
  ),
);
if (!(List && Detail && Episode && Markers && Sources)) {
  throw new Error('Incomplete components');
}
const html = (view: Component, props: Record<string, unknown>) =>
  render(view, { props })
    .body.replaceAll(/<!--[^>]*-->/g, '')
    .replaceAll(/\s+/g, ' ');
const noop = (): void => undefined;
const forbiddenCommand = (): Promise<never> => Promise.reject(new Error('SSR must never mutate tasks'));
const store = createSyntheticWorkThreadStore();
const query = threadListQuery(new URLSearchParams());
const list = await store.readList(query);
const detail = async (id: string) => {
  const data = await store.readDetail(id);
  if (!data) {
    throw new Error(`Missing task ${id}`);
  }
  return data;
};
const payments = await detail(WORK_THREADS_FIXTURE_IDS.payments);
const analysis = await detail(WORK_THREADS_FIXTURE_IDS.analysis);
const baseDetailProps = {
  timeZone: 'Europe/Paris',
  backHref: '/work?project=Example+shop',
  onBack: noop,
  onCommand: forbiddenCommand,
  onPickerOpen: noop,
  onMoreSessions: noop,
};

describe('work thread SSR presentation', () => {
  test('availability is collapsed below the filters and keeps diagnostics out of its summary', () => {
    const sources = [
      { source: 'github', state: 'failed', message: 'Private diagnostic detail', lastRunAt: list.generatedAt },
      {
        source: 'sessions',
        state: 'truncated',
        message: 'Partial linked-session evidence',
        lastRunAt: list.generatedAt,
      },
    ];
    const body = html(List, {
      dataset: { ...list, sources },
      rows: list.rows,
      query,
      timeZone: 'UTC',
      href: () => '/work',
      onOpen: noop,
      onFilter: noop,
      onMore: noop,
    });
    expect(body).toContain('aria-label="Source availability"');
    expect(body.indexOf('Source availability')).toBeGreaterThan(body.indexOf('work-task-search'));
    const summary = body.match(SUMMARY_CONTENT)?.[1];
    expect(summary).toContain('GitHub');
    expect(summary).not.toContain('truncated');
    expect(summary).not.toContain('Private diagnostic detail');
    expect(body).not.toContain('<details open');
    expect(body).toContain('Private diagnostic detail');
    const healthy = [{ source: 'github', state: 'ok', lastRunAt: list.generatedAt, message: null }];
    expect(html(Sources, { sources: healthy, now: list.generatedAt, timeZone: 'UTC' })).toBe('');
    const partial = html(Sources, { sources: [sources[1]], now: list.generatedAt, timeZone: 'UTC' });
    expect(partial.match(SUMMARY_CONTENT)?.[1]?.trim()).toBe('<span>Source details</span>');
  });
  test('week cells retain session and event chips with a fully named task link', () => {
    const title =
      'Improve the synthetic report with a sufficiently long task title that needs to wrap while remaining completely accessible';
    const marks = [
      { at: list.generatedAt, harness: 'claude', kind: 'session', label: 'Compare approaches' },
      { at: list.generatedAt, harness: 'codex', kind: 'session', label: 'Review the approach' },
      { at: list.generatedAt, harness: null, kind: 'event', label: 'PR #67 opened' },
    ];
    const body = html(List, {
      dataset: list,
      rows: [{ ...payments.row, thread: { ...payments.row.thread, title }, marks }],
      query,
      timeZone: 'UTC',
      href: () => '/work',
      onOpen: noop,
      onFilter: noop,
      onMore: noop,
    });
    expect(body).toContain(`aria-label="${title}"`);
    expect(body).toContain(`title="${title}"`);
    expect(body).toContain('2 sessions, 1 work events. Show activity.');
    expect(body).toContain('wt-day-button');
    expect(body).toContain('wt-event-mark');
    expect(body).toContain('>2</span>');
  });
  test('discovered PR history uses source dates and hides automatic linking noise', async () => {
    const merged = await detail(WORK_THREADS_FIXTURE_IDS.mergedPr);
    const body = html(Detail, { ...baseDetailProps, timeZone: 'UTC', data: merged });
    expect(body).toContain('Since Oct 20');
    expect(body).toContain('PR #1502 opened');
    expect(body).toContain('PR #1502 merged');
    expect(body.indexOf('PR #1502 opened')).toBeLessThan(body.indexOf('PR #1502 merged'));
    expect(body).toContain('wt-fact-event');
    expect(body).not.toContain('Task created');
    expect(body).not.toContain('Source linked');
  });
  test('GitHub explicitly distinguishes no review decision from an unavailable observation', () => {
    const marker = payments.row.markers.pullRequests[0];
    if (!marker?.latest) {
      throw new Error('Expected PR marker');
    }
    const markers = {
      ...payments.row.markers,
      pullRequests: [{ ...marker, latest: { ...marker.latest, reviewDecision: null, unresolvedReviewThreads: 2 } }],
    };
    const body = html(Markers, { markers, timeZone: 'UTC', now: payments.generatedAt });
    expect(body).toContain('No review decision');
    expect(body).toContain('2 review threads open');
    expect(body).not.toContain('Review unknown');
  });
  test('episode rows use recorded duration and disclose the longer first-to-last span separately', () => {
    const episode = payments.episodes[0];
    if (!episode) {
      throw new Error('Expected episode');
    }
    const props = {
      episode: { ...episode, activeMs: 840_000, spanMs: 259_200_000 },
      taskTitle: 'Task',
      timeZone: 'UTC',
      showDelegations: false,
      onCopy: noop,
      onDetach: noop,
      linkedKeys: [],
      initiallyOpen: true,
    };
    const body = html(Episode, props);
    expect(body).toContain('14 min recorded for this episode');
    expect(body).toContain('over 3 days');
    expect(body).toContain('first to last activity');
    expect(html(Episode, { ...props, episode: { ...episode, activeMs: null, spanMs: 259_200_000 } })).toContain(
      'Duration not recorded',
    );
  });
  test('renders one linked row per task, proper tabs and a zero-session PR', () => {
    const body = html(List, {
      dataset: list,
      rows: list.rows,
      query,
      timeZone: 'Europe/Paris',
      href: (id: string) => `/work?task=${id}`,
      onOpen: noop,
      onFilter: noop,
      onMore: noop,
    });
    expect(body.split('data-work-thread=').length - 1).toBe(list.rows.length);
    expect(body).toContain('role="tablist"');
    expect(body).toContain('aria-selected="true"');
    expect(body).toContain('0 sessions');
    expect(body).toContain('Placed by day');
    expect(body).not.toContain('All observed session roots');
  });
  test('analysis is a task with an end action and without artifact requirements', () => {
    const body = html(Detail, { ...baseDetailProps, data: analysis });
    expect(body).toContain('Analysis only · no branch, PR or ticket needed');
    expect(body).toContain('End follow-up');
    expect(body).toContain('The thread of this task');
    expect(body).toContain('Resume note, if needed');
    expect(body).not.toContain('Human review decision');
  });
  test('list and task footer keep delegated counts separate and omit a zero delegated count', () => {
    const row = { ...payments.row, sessionCount: 1, delegatedSessionCount: 20 };
    const listBody = html(List, {
      dataset: list,
      rows: [row],
      query,
      timeZone: 'UTC',
      href: () => '/work',
      onOpen: noop,
      onFilter: noop,
      onMore: noop,
    });
    expect(listBody).toContain('1 session · 20 delegated');
    expect(listBody.split('data-work-thread=').length - 1).toBe(1);
    expect(html(Detail, { ...baseDetailProps, data: { ...payments, row } })).toContain(
      '1 linked session · 20 delegated · one task',
    );
    expect(
      html(Detail, { ...baseDetailProps, data: { ...payments, row: { ...row, delegatedSessionCount: 0 } } }),
    ).toContain('1 linked session · one task');
  });
  test('truncated sessions stay visible while failing PR checks remain the task and list headline', () => {
    const marker = payments.row.markers.pullRequests[0];
    if (!marker?.latest) {
      throw new Error('Expected a PR observation');
    }
    const row = {
      ...payments.row,
      markers: {
        ...payments.row.markers,
        pullRequests: [{ ...marker, latest: { ...marker.latest, checksRollup: 'failure', reviewDecision: null } }],
      },
    };
    const sources = [
      {
        source: 'sessions',
        state: 'truncated',
        lastRunAt: payments.generatedAt,
        message: 'Session read limit reached',
      },
    ];
    expect(html(Detail, { ...baseDetailProps, data: { ...payments, row, sources } })).toContain(
      '<h2>Checks failing</h2>',
    );
    expect(
      html(List, {
        dataset: { ...list, sources },
        rows: [row],
        query,
        timeZone: 'UTC',
        href: () => '/work',
        onOpen: noop,
        onFilter: noop,
        onMore: noop,
      }),
    ).toContain('Checks failing');
    const banner = html(Sources, { sources, now: payments.generatedAt, timeZone: 'UTC' });
    expect(banner).toContain('Sessions: evidence incomplete');
    expect(banner).toContain('does not establish that nothing is left');
  });
  test('source events show escaped readable labels and reserve raw keys for title attributes', () => {
    const episode = payments.episodes[0];
    const event = payments.events[0];
    if (!(episode && event)) {
      throw new Error('Expected episode and event');
    }
    const nested = {
      ...episode,
      linkKey: 'session:fixture-machine/codex/nested-label',
      harness: 'codex',
      title: '<Check> retry & result',
      children: [],
    };
    const keys = [
      nested.linkKey,
      'session:fixture-machine/claude/missing',
      'github.example/team/repo#68',
      'jira:example/XLB-2085',
      'branch:github.example/team/repo@fix/payment/retry',
    ];
    const data = {
      ...payments,
      episodes: [{ ...episode, children: [{ ...episode, children: [nested] }] }],
      events: keys.map((linkKey, index) => ({
        ...event,
        eventId: `${event.eventId}-${index}`,
        kind: 'link-detached',
        linkKey,
        reason: null,
      })),
    };
    const body = html(Detail, { ...baseDetailProps, data });
    const visible = body.replaceAll(/<[^>]*>/g, '');
    expect(visible).toContain('&lt;Check> retry &amp; result · Codex');
    expect(body).not.toContain('<Check>');
    expect(visible).toContain('a session (no longer readable)');
    expect(visible).toContain('PR #68 · team/repo');
    expect(visible).toContain('XLB-2085');
    expect(visible).toContain('fix/payment/retry');
    for (const key of keys) {
      expect(body).toContain(`title="${key}"`);
      expect(visible).not.toContain(key);
    }
  });
  test('episode context labels span, verified resume copy, and unknown origin honestly', () => {
    const episode = payments.episodes[0];
    if (!episode) {
      throw new Error('Missing episode');
    }
    const body = html(Episode, {
      episode: {
        ...episode,
        origin: null,
        resume: { kind: 'cli-resume', command: 'codex resume observed-session', cwd: '/synthetic' },
      },
      taskTitle: 'Task',
      timeZone: 'UTC',
      showDelegations: false,
      onCopy: noop,
      onDetach: noop,
      linkedKeys: [episode.linkKey],
      initiallyOpen: true,
    });
    expect(body).toContain('Origin not declared');
    expect(body).toContain('Recorded for this episode:');
    expect(body).toContain('nothing is executed here');
    expect(body).toContain('Initial request');
    expect(body).toContain('Detach session');
  });
  test('unsupported resume gives the source reason instead of a guessed command', () => {
    const episode = payments.episodes[0];
    if (!episode) {
      throw new Error('Missing episode');
    }
    const body = html(Episode, {
      episode: { ...episode, resume: { kind: 'none', reason: 'Harness resume is not verified' } },
      taskTitle: 'Task',
      timeZone: 'UTC',
      showDelegations: false,
      onCopy: noop,
      onDetach: noop,
      linkedKeys: [],
      initiallyOpen: true,
    });
    expect(body).toContain('Harness resume is not verified');
    expect(body).not.toContain('>Resume this session</button>');
    expect(body).toContain('Copy context');
  });
  test('delegations remain collapsed until explicitly requested', () => {
    const episode = payments.episodes.find((item) => item.children.length > 0);
    if (!episode) {
      throw new Error('Missing delegated fixture');
    }
    const props = { episode, taskTitle: 'Task', timeZone: 'UTC', onCopy: noop, onDetach: noop, linkedKeys: [] };
    const collapsed = html(Episode, { ...props, showDelegations: false });
    const expanded = html(Episode, { ...props, showDelegations: true });
    expect(collapsed.split('data-session-key=').length - 1).toBe(1);
    expect(expanded.split('data-session-key=').length - 1).toBeGreaterThan(1);
    expect(collapsed).toContain('delegated session');
    expect(collapsed).toContain('+ 1 delegated session');
    expect(expanded).toContain('− 1 delegated session');
  });
  test('source read failures are visible even when some tasks are served', () => {
    const body = html(Sources, {
      sources: [{ source: 'github', state: 'unauthenticated', message: 'Authentication unavailable', lastRunAt: null }],
      now: list.generatedAt,
      timeZone: 'UTC',
    });
    expect(body).toContain('GitHub: sign-in required');
    expect(body).toContain('does not establish that nothing is left');
  });
  test('marker decisions describe GitHub evidence without asserting human approval', () => {
    const body = html(Markers, { markers: payments.row.markers, timeZone: 'UTC', now: payments.generatedAt });
    expect(body).toContain('GitHub review decision');
    expect(body).toContain('An agent review is not a human approval');
    expect(body).not.toContain('Human review decision');
  });
  test('an ended follow-up states precisely what the command changed', async () => {
    const ended = await detail(WORK_THREADS_FIXTURE_IDS.done);
    const body = html(Detail, { ...baseDetailProps, data: ended });
    expect(body).toContain('You ended this follow-up on');
    expect(body).toContain('No GitHub, Jira or session state was changed by ending it');
    expect(body).toContain('Reopen');
  });
  test('a waiting task offers Resume following while retaining End follow-up', async () => {
    const waiting = await detail(WORK_THREADS_FIXTURE_IDS.badges);
    const body = html(Detail, { ...baseDetailProps, data: waiting });
    expect(body).toContain('Resume following');
    expect(body).toContain('End follow-up');
  });
});
