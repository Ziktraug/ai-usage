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
    expect(body).toContain('Episode span:');
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
  });
  test('source read failures are visible even when some tasks are served', () => {
    const body = html(Sources, {
      sources: [{ source: 'github', state: 'unauthenticated', message: 'Authentication unavailable', lastRunAt: null }],
      now: list.generatedAt,
      timeZone: 'UTC',
    });
    expect(body).toContain('GitHub: unauthenticated');
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
    expect(body).toContain('Nothing in GitHub, Jira or any session was changed');
    expect(body).toContain('Reopen');
  });
});
