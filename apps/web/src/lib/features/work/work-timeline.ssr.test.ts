import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadMark,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { createSyntheticWorkThreadStore } from '../../../server/work-threads-e2e-fixture.server';
import { threadDayKey, threadListQuery } from './work-thread-model';
import {
  resolveTimelineWindow,
  TIMELINE_CAPPED_COPY,
  TIMELINE_HEAT_LEGEND,
  type TimelineLane,
  type TimelineSessionBar,
  type TimelineViewState,
  type TimelineWindow,
  timelineDomain,
  timelineLanes,
  timelineScale,
  timelineViewState,
} from './work-timeline-model';

const HEAT_CELL_PATTERN = /class="wtl-cell[ "]/g;
const DAY_CONTROL_PATTERN = /aria-label="[^"]*: \d+ sessions? started\. Zoom to this day\."/g;
const PARTIAL_TAG_PATTERN = /class="wtl-partial"/g;
const TAB_STOP_PATTERN = /tabindex="0"/g;
const SLIDER_PATTERN = /role="slider"/g;
const QUIET_ROW_PATTERN = /class="wtl-row wtl-task wtl-quiet"/g;
const TASK_ROW_PATTERN = /class="wtl-row wtl-task[ "]/g;

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
const [Board, Track] = await Promise.all(['work-timeline-board', 'work-timeline-track'].map(component));
if (!(Board && Track)) {
  throw new Error('Incomplete components');
}
const html = (view: Component, props: Record<string, unknown>) =>
  render(view, { props })
    .body.replaceAll(/<!--[^>]*-->/g, '')
    .replaceAll(/\s+/g, ' ');
const escaped = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const noop = (): void => undefined;
const settled = (): Promise<void> => Promise.resolve();

const store = createSyntheticWorkThreadStore();
const list = await store.readList(threadListQuery(new URLSearchParams()));
const now = list.generatedAt;
const today = threadDayKey(now, 'UTC');

const frame = (options: {
  readonly rows?: readonly WorkThreadRow[];
  readonly search?: string;
  readonly window?: TimelineWindow;
}) => {
  const rows = options.rows ?? list.rows;
  const view: TimelineViewState = timelineViewState(new URLSearchParams(options.search ?? ''));
  const domain = timelineDomain(
    now,
    'UTC',
    rows.map((row) => row.firstActivityAt),
  );
  const windowIndexes = resolveTimelineWindow(domain, options.window ?? view.window);
  const scale = timelineScale(domain.slice(windowIndexes.fromIndex, windowIndexes.toIndex + 1), now, 'UTC');
  const lanes = timelineLanes({ grouping: view.grouping, now, rows, scale, sourcesOf: () => list.sources });
  return { domain, lanes, scale, view, windowIndexes };
};
const sessionStart: WorkThreadMark = {
  at: now,
  fact: null,
  harness: 'claude',
  kind: 'session',
  label: 'A session',
  source: null,
};
const template = list.rows[0];
if (!template) {
  throw new Error('The fixture needs a task');
}
/** A task of one project with only the given marks: what its row shows follows from them alone. */
const plainTask = (id: number, marks: readonly WorkThreadMark[]): WorkThreadRow => ({
  ...template,
  markers: { ...template.markers, pullRequests: [] },
  marks,
  thread: {
    ...template.thread,
    projectLabel: 'Example shop',
    threadId: `16000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    title: `Plain task ${id}`,
  },
});
const sessionSpan = {
  description: 'Codex · Respond to the review · 09:20–09:44',
  end: 0.41,
  endsAfter: false,
  harness: 'codex',
  key: 'session:parent',
  point: false,
  start: 0.39,
  startsBefore: false,
  title: 'Respond to the review',
};
const boardProps = (value: ReturnType<typeof frame>, overrides: Record<string, unknown> = {}) => ({
  detail: null,
  domain: value.domain,
  href: (id: string) => `/work?view=timeline&task=${id}`,
  lanes: value.lanes,
  loadedCopy: '13 of 13 followed tasks loaded · 0 of 0 ended follow-ups',
  now,
  onFilter: settled,
  onOpen: noop,
  onView: settled,
  overview: value.domain.map((_, index) => (index % 7 === 0 ? 2 : 0)),
  projects: list.projects,
  query: { project: null, search: null },
  scale: value.scale,
  sessionBars: new Map(),
  sources: list.sources,
  view: value.view,
  windowIndexes: value.windowIndexes,
  ...overrides,
});
const laneOf = (lanes: readonly TimelineLane[], key: string): TimelineLane => {
  const lane = lanes.find((candidate) => candidate.key === key);
  if (!lane) {
    throw new Error(`Missing lane ${key}`);
  }
  return lane;
};

describe('work timeline SSR presentation', () => {
  test('lanes render collapsed, each with its label, its status and a named track', () => {
    const value = frame({});
    const body = html(Board, boardProps(value));
    expect(value.lanes.length).toBeGreaterThan(1);
    expect(body.match(/aria-expanded="false"/g)?.length).toBe(value.lanes.length);
    expect(body).not.toContain('aria-expanded="true"');
    expect(body).not.toMatch(TASK_ROW_PATTERN);
    for (const lane of value.lanes) {
      expect(body).toContain(`<section aria-label="${escaped(lane.label)}" class="wtl-lane">`);
      expect(body).toContain(`title="${escaped(lane.key)}">${lane.label}</span>`);
      expect(body).toContain(`${lane.tasks.length} ${lane.tasks.length === 1 ? 'task' : 'tasks'} · ${lane.status}`);
      expect(body).toContain(
        `aria-label="${escaped(lane.track.summary)}" class="wtl-track" data-resolution="day" role="img"`,
      );
    }
    expect(body).toContain('Project · latest activity first');
    expect(body).toContain('13 of 13 followed tasks loaded · 0 of 0 ended follow-ups · Sep 13 – Oct 24, 2026');
  });

  test('an expanded lane lists its active tasks as links and keeps the others behind one control', () => {
    const collapsed = frame({});
    const lane = collapsed.lanes.find((candidate) =>
      candidate.tasks.some((task) => !task.track.active && candidate.tasks.some((other) => other.track.active)),
    );
    if (!lane) {
      throw new Error('The fixture needs a lane with active and inactive tasks');
    }
    const idle = lane.tasks.filter((task) => !task.track.active);
    const active = lane.tasks.filter((task) => task.track.active);
    const open = new URLSearchParams({ open: lane.key });
    const body = html(Board, boardProps(frame({ search: open.toString() })));
    expect(body).toContain('aria-expanded="true"');
    expect(body.match(TASK_ROW_PATTERN)?.length).toBe(active.length);
    for (const task of active) {
      const id = task.row.thread.threadId;
      expect(body).toContain(`data-work-thread="${id}"`);
      expect(body).toContain(
        `<a class="wt-task-title wtl-task-title" href="/work?view=timeline&amp;task=${id}" title="${escaped(task.row.thread.title)}">`,
      );
      expect(body).toContain(`data-hint="${task.hint}"`);
    }
    expect(body).toContain(
      `${idle.length} ${idle.length === 1 ? 'task' : 'tasks'} with no session started and no pull request in this window</button>`,
    );
    expect(body).not.toMatch(QUIET_ROW_PATTERN);
    for (const task of idle) {
      expect(body).not.toContain(`data-work-thread="${task.row.thread.threadId}"`);
    }
    open.append('quiet', lane.key);
    const listed = html(Board, boardProps(frame({ search: open.toString() })));
    expect(listed.match(QUIET_ROW_PATTERN)?.length).toBe(idle.length);
    expect(listed.match(TASK_ROW_PATTERN)?.length).toBe(lane.tasks.length);
  });

  test('attention grouping names each task project and its own lane order', () => {
    const value = frame({ search: 'group=attention&open=to-resume' });
    const body = html(Board, boardProps(value));
    expect(body).toContain('Attention · your move first');
    const resume = laneOf(value.lanes, 'to-resume');
    const task = resume.tasks.find((candidate) => candidate.track.active);
    expect(task).toBeDefined();
    expect(body).toContain(`>${task?.project}</span>`);
    expect(body).toContain('<th scope="col">Attention or task</th>');
  });

  test('a track is one image named by its summary, with one heat cell per scale column', () => {
    const value = frame({});
    const lane = value.lanes.find((candidate) => candidate.track.pullRequests.length > 0);
    if (!lane) {
      throw new Error('The fixture needs a lane with pull requests');
    }
    const body = html(Track, { labels: true, scale: value.scale, track: lane.track });
    expect(body).toContain(
      `aria-label="${escaped(lane.track.summary)}" class="wtl-track" data-resolution="day" role="img"`,
    );
    expect(body.match(HEAT_CELL_PATTERN)?.length).toBe(value.scale.columns.length);
    expect(body).toContain('wtl-today');
    expect(body).toContain('sessions started"');
    for (const bar of lane.track.pullRequests) {
      expect(body).toContain(`data-tone="${bar.tone}"`);
      expect(body).toContain(`title="${escaped(bar.description)}"`);
      expect(body).toContain(`>${bar.label}</span>`);
    }
    // Milestones belong to task rows: a project row draws the bars alone.
    expect(body).not.toContain('wtl-pr-milestone');
    expect(lane.track.hiddenPullRequests).toBeGreaterThan(0);
    expect(body).toContain(`+${lane.track.hiddenPullRequests} PR`);
    const task = lane.tasks.find((candidate) => candidate.track.pullRequests.some((bar) => bar.milestones.length > 0));
    if (!task) {
      throw new Error('The fixture needs a task with a dated pull request milestone');
    }
    const taskBody = html(Track, { labels: true, milestones: true, scale: value.scale, track: task.track });
    expect(taskBody).toContain('class="wtl-pr-milestone" data-milestone="pull-request-');
  });

  test('the scale offers one tab stop of day controls, and none once a day is drawn by the hour', () => {
    const value = frame({});
    const body = html(Board, boardProps(value));
    expect(value.scale.resolution).toBe('day');
    expect(body.match(DAY_CONTROL_PATTERN)?.length).toBe(value.scale.columns.length);
    // Each control says what the heat under it only tints: the sessions started that day, over all lanes.
    for (const [index, column] of value.scale.columns.entries()) {
      const started = value.lanes.reduce((total, lane) => total + (lane.track.heat[index]?.count ?? 0), 0);
      expect(body).toContain(
        `aria-label="${column.label}: ${started} ${started === 1 ? 'session' : 'sessions'} started. Zoom to this day."`,
      );
    }
    const single = html(Board, boardProps(frame({ rows: [plainTask(1, [sessionStart]), plainTask(2, [])] })));
    expect(single).toContain('aria-label="Sat, Oct 24: 1 session started. Zoom to this day."');
    expect(single).toContain('aria-label="Fri, Oct 23: 0 sessions started. Zoom to this day."');
    const ticks = body.slice(body.indexOf('aria-label="Zoom to a day"'), body.indexOf('class="wtl-lane"'));
    expect(ticks.match(TAB_STOP_PATTERN)?.length).toBe(1);
    expect(body).toContain('aria-hidden="true" class="wtl-now"');
    const day = html(Board, boardProps(frame({ window: { from: today, to: today } })));
    expect(day).not.toMatch(DAY_CONTROL_PATTERN);
    expect(day).toContain('Sat, Oct 24, 2026');
  });

  test('the toolbar states the zoom, refuses a move past today and mirrors the filters', () => {
    const value = frame({});
    const body = html(Board, boardProps(value, { query: { project: 'Example shop', search: 'refund' } }));
    expect(body).toContain('aria-pressed="true" id="wtl-zoom-6w"');
    expect(body).toContain('aria-pressed="false" id="wtl-zoom-24h"');
    expect(body).toContain('aria-pressed="false" id="wtl-zoom-7d"');
    expect(body.indexOf('wtl-zoom-24h')).toBeLessThan(body.indexOf('wtl-zoom-7d'));
    expect(body.indexOf('wtl-zoom-7d')).toBeLessThan(body.indexOf('wtl-zoom-6w'));
    // The fixture's domain is the default six weeks: there is nowhere earlier or later to go.
    expect(value.domain.length).toBe(value.scale.days.length);
    expect(body.match(/aria-disabled="true"/g)?.length).toBe(3);
    expect(body).toContain('id="work-task-project"');
    expect(body).toContain('id="work-task-search"');
    expect(body).toContain('value="refund"');
    expect(body).toContain('Expand all');
    expect(body).toContain('Collapse all');
  });

  test('the brush exposes the window as two sliders named by their day', () => {
    const value = frame({ window: { from: '2026-10-12', to: '2026-10-18' } });
    const body = html(Board, boardProps(value));
    expect(value.scale.resolution).toBe('quarter-day');
    expect(body.match(SLIDER_PATTERN)?.length).toBe(2);
    expect(body).toContain('aria-label="Window start"');
    expect(body).toContain('aria-valuetext="Mon, Oct 12"');
    expect(body).toContain('aria-label="Window end"');
    expect(body).toContain('aria-valuetext="Sun, Oct 18"');
    expect(body).toContain(`aria-valuemax="${value.domain.length}"`);
    expect(body).toContain(`aria-valuenow="${value.windowIndexes.fromIndex}"`);
    expect(body).toContain(`aria-valuenow="${value.windowIndexes.toIndex + 1}"`);
    expect(body).toContain('aria-label="Selected time window"');
    expect(body).toContain('class="wtl-brush-overview"');
    expect(body).toContain('aria-pressed="true" id="wtl-zoom-7d"');
    expect(body).toContain('Oct 12 – Oct 18, 2026');
    expect(body).toContain('Sessions started per 6 h');
  });

  test('one day by the hour draws session spans and says how many tasks were read', () => {
    const value = frame({ search: 'open=Example+shop', window: { from: today, to: today } });
    expect(value.scale.resolution).toBe('hour');
    const lane = laneOf(value.lanes, 'Example shop');
    const task = lane.tasks.find((candidate) => candidate.track.active);
    if (!task) {
      throw new Error('The fixture needs a task active on its last day');
    }
    const span = sessionSpan;
    const bars: readonly TimelineSessionBar[] = [
      {
        ...span,
        children: [{ ...span, description: 'Claude · Review the diff · 09:30–09:40', harness: 'claude', key: 'child' }],
        description: `${span.description} · 1 delegated session`,
        row: 0,
      },
      {
        ...span,
        children: [],
        description: 'Claude · Late idea · 23:10 · end not recorded',
        harness: 'claude',
        key: 'point',
        point: true,
        row: 1,
        title: 'Late idea',
      },
    ];
    const body = html(
      Board,
      boardProps(value, {
        detail: { failed: 1, read: 1, skipped: 3, targets: 15 },
        sessionBars: new Map([[task.row.thread.threadId, { bars, rows: 2 }]]),
      }),
    );
    expect(body).toContain(
      'Sat, Oct 24, 2026 · session spans read for 1 of 15 tasks that may have sessions that day · 3 not read (limit 12) · 1 could not be read',
    );
    // The thin strip of delegated sessions is drawn only: the image's name carries their count.
    expect(body).toContain(
      `aria-label="${escaped(task.track.summary)} Session spans: Codex · Respond to the review · 09:20–09:44 · 1 delegated session; Claude · Late idea · 23:10 · end not recorded."`,
    );
    expect(body).toContain('class="wtl-session" data-harness="codex"');
    expect(body).toContain('class="wtl-session wtl-point" data-harness="claude"');
    expect(html(Board, boardProps(value, { detail: { failed: 0, read: 1, skipped: 0, targets: 1 } }))).toContain(
      'Sat, Oct 24, 2026 · session spans read for 1 of 1 task that may have sessions that day</p>',
    );
    expect(body).toContain('class="wtl-child" data-harness="claude"');
    expect(body).toContain('title="Claude · Review the diff · 09:30–09:40"');
    expect(body).toContain('<span class="wtl-session-glyph">Cx</span>');
    expect(body).toContain(
      'Session bar: first to last observed activity, pauses included · thin strip: delegated sessions',
    );
    expect(body).toContain('Sessions started per hour');
    // Only the task whose detail was read trades its heat row for spans.
    expect(body.match(/class="wtl-sessions"/g)?.length).toBe(1);
  });

  test('by the hour a task whose session started earlier and continues is listed, not kept behind the toggle', () => {
    const started = plainTask(1, [sessionStart]);
    const continuing = plainTask(2, []);
    const silent = plainTask(3, []);
    const value = frame({
      rows: [started, continuing, silent],
      search: 'open=Example+shop',
      window: { from: today, to: today },
    });
    expect(value.scale.resolution).toBe('hour');
    expect(laneOf(value.lanes, 'Example shop').tasks.map((task) => task.track.active)).toEqual([true, false, false]);
    const row = (task: WorkThreadRow, quiet: boolean): string =>
      `class="wtl-row wtl-task${quiet ? ' wtl-quiet' : ''}" data-work-thread="${task.thread.threadId}"`;
    const toggle = (count: string): string =>
      `${count} with no session started and no pull request in this window</button>`;
    const unread = html(Board, boardProps(value));
    expect(unread).toContain(row(started, false));
    expect(unread).not.toContain(`data-work-thread="${continuing.thread.threadId}"`);
    expect(unread).toContain(toggle('2 tasks'));
    const bar: TimelineSessionBar = {
      ...sessionSpan,
      children: [],
      description: 'Codex · Respond to the review · Oct 23 22:10–09:44 · started earlier',
      row: 0,
      start: 0,
      startsBefore: true,
    };
    const sessionBars = new Map([
      [continuing.thread.threadId, { bars: [bar], rows: 1 }],
      // A detail that was read and holds no span of that day changes nothing.
      [silent.thread.threadId, { bars: [], rows: 0 }],
    ]);
    const read = html(Board, boardProps(value, { sessionBars }));
    expect(read).toContain(row(started, false));
    expect(read).toContain(row(continuing, false));
    expect(read).not.toContain(`data-work-thread="${silent.thread.threadId}"`);
    expect(read).toContain(toggle('1 task'));
    expect(read).not.toContain(toggle('2 tasks'));
    expect(read).toContain('class="wtl-session wtl-starts-before" data-harness="codex"');
    // The table lists the same tasks as the board.
    const table = read.slice(read.indexOf('<details class="wtl-table">'));
    expect(table.match(/class="wtl-table-task"/g)?.length).toBe(2);
    expect(table).toContain(`<th scope="row">${continuing.thread.title}</th>`);
    const listed = html(
      Board,
      boardProps(
        frame({
          rows: [started, continuing, silent],
          search: 'open=Example+shop&quiet=Example+shop',
          window: { from: today, to: today },
        }),
        {
          sessionBars,
        },
      ),
    );
    expect(listed).toContain(row(continuing, false));
    expect(listed).toContain(row(silent, true));
    expect(listed.match(QUIET_ROW_PATTERN)?.length).toBe(1);
    // Session spans are only drawn by the hour: at another zoom they list nothing.
    const week = frame({
      rows: [started, continuing, silent],
      search: 'open=Example+shop',
      window: { from: '2026-10-18', to: today },
    });
    expect(week.scale.resolution).toBe('quarter-day');
    expect(html(Board, boardProps(week, { sessionBars }))).toContain(toggle('2 tasks'));
  });

  test('the source statuses of the read are stated between the status line and the brush', () => {
    const value = frame({});
    const failed: WorkThreadSourceStatus = {
      lastRunAt: now,
      message: 'The GitHub read failed.',
      source: 'github',
      state: 'failed',
    };
    const body = html(Board, boardProps(value, { sources: [failed] }));
    const status = body.indexOf('class="wtl-status"');
    const availability = body.indexOf('aria-label="Source availability"');
    const brush = body.indexOf(' wtl-brush"');
    expect(status).toBeGreaterThan(-1);
    expect(availability).toBeGreaterThan(status);
    expect(brush).toBeGreaterThan(availability);
    expect(body).toContain('<strong>GitHub: read failed</strong> · The GitHub read failed.');
    expect(body).toContain('Unavailable or older evidence does not establish that nothing is left.');
    // A read is aged against the instant of the timeline read, in the scale's time zone.
    const old = html(
      Board,
      boardProps(value, {
        sources: [{ ...failed, lastRunAt: '2026-10-01T08:00:00.000Z', message: null, state: 'ok' }],
      }),
    );
    expect(old).toContain('<strong>GitHub: read is stale</strong>');
    expect(old).toContain('last read Oct 1');
    // Every source read recently: nothing to state.
    const read = html(Board, boardProps(value, { sources: [{ ...failed, message: null, state: 'ok' }] }));
    expect(read).not.toContain('Source availability');
    // No task to draw is exactly when an unread source matters most.
    const empty = html(Board, boardProps(frame({ rows: [] }), { sources: [failed] }));
    expect(empty).toContain('<strong>GitHub: read failed</strong>');
  });

  test('a task whose marks reach the bound of the list read is tagged partial, and so is its lane', () => {
    const marks = Array.from({ length: WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow }, () => sessionStart);
    const tag = `<span class="wtl-partial" title="${TIMELINE_CAPPED_COPY}">partial</span>`;
    const value = frame({
      rows: [
        plainTask(1, marks),
        plainTask(2, marks.slice(1)),
        { ...plainTask(3, [sessionStart]), thread: { ...plainTask(3, []).thread, projectLabel: 'Example tools' } },
      ],
      search: 'open=Example+shop&open=Example+tools',
    });
    const body = html(Board, boardProps(value));
    expect(body.match(PARTIAL_TAG_PATTERN)?.length).toBe(2);
    // In the lane's name cell, after its label; in the task's, on its meta line.
    expect(body).toContain(`title="Example shop">Example shop</span> ${tag}`);
    const capped = body.slice(body.indexOf(`data-work-thread="${plainTask(1, []).thread.threadId}"`));
    const next = capped.indexOf(`data-work-thread="${plainTask(2, []).thread.threadId}"`);
    expect(capped.slice(0, next)).toContain(`${tag} <span>`);
    expect(capped.slice(next)).not.toContain('wtl-partial');
    // The same sentence closes the text equivalent of both tracks.
    expect(
      body.match(new RegExp(`${TIMELINE_CAPPED_COPY.replaceAll('.', '\\.')}" class="wtl-track"`, 'g'))?.length,
    ).toBe(2);
    expect(html(Board, boardProps(frame({ search: 'open=Example+shop' })))).not.toContain('wtl-partial');
  });

  test('a long list of session spans is named up to twelve, then counted', () => {
    const value = frame({ window: { from: today, to: today } });
    const track = value.lanes[0]?.tasks[0]?.track;
    if (!track) {
      throw new Error('The fixture needs a task');
    }
    const bars = Array.from({ length: 14 }, (_, index) => ({
      children: [],
      description: `Span ${index + 1}`,
      end: 0.5,
      endsAfter: false,
      harness: 'codex',
      key: `span-${index}`,
      point: false,
      row: index,
      start: 0.4,
      startsBefore: false,
      title: `Span ${index + 1}`,
    }));
    const body = html(Track, { scale: value.scale, sessions: { bars, rows: 14 }, track });
    expect(body).toContain('Span 12; and 2 more."');
    expect(body).not.toContain('Span 13;');
    expect(body).not.toContain('class="wtl-heat"');
  });

  test('the legend names the heat steps and the table restates every lane as text', () => {
    const value = frame({ search: 'open=Example+shop' });
    const body = html(Board, boardProps(value));
    const legend = body.slice(body.indexOf('class="wtl-legend"'), body.indexOf('<details class="wtl-table">'));
    expect(legend).toContain('Sessions started per day');
    for (const [index, step] of TIMELINE_HEAT_LEGEND.entries()) {
      expect(legend).toContain(`class="wtl-cell" data-level="${index + 1}"></span> ${step}</span>`);
    }
    for (const sample of [
      'Merged',
      'Open',
      'Approved',
      'Draft',
      'Blocked or failing checks',
      'Closed',
      'State unknown',
      'Now',
    ]) {
      expect(legend).toContain(`${sample}</span>`);
    }
    // An approved pull request is still open: its sample carries the end cap, squared by the stylesheet.
    expect(legend).toContain('class="wtl-pr wtl-open" data-tone="approved"></span> Approved</span>');
    expect(legend).toContain('class="wtl-pr wtl-open" data-tone="open"></span> Open</span>');
    expect(legend).toContain('class="wtl-pr" data-tone="unknown"></span> State unknown</span>');
    expect(legend).toContain('class="wtl-pr" data-tone="merged"></span> Merged</span>');
    expect(legend).toContain(
      'Sessions are placed at their start. Delegated sessions are counted on the task, not in the strip.',
    );
    expect(legend).not.toContain('Session bar:');
    const table = body.slice(body.indexOf('<details class="wtl-table">'));
    expect(table).toContain('<summary>Timeline as a table</summary>');
    expect(table).toContain('<caption>Sep 13 – Oct 24, 2026</caption>');
    for (const heading of ['Project or task', 'Tasks', 'Sessions started', 'Pull requests', 'Summary']) {
      expect(table).toContain(`<th scope="col">${heading}</th>`);
    }
    const shop = laneOf(value.lanes, 'Example shop');
    for (const lane of value.lanes) {
      expect(table).toContain(`<th scope="row">${lane.label}</th><td>${lane.tasks.length}</td>`);
      expect(table).toContain(`<td>${lane.track.summary}</td>`);
    }
    expect(table).toContain(`+${shop.track.hiddenPullRequests} more`);
    const active = shop.tasks.filter((task) => task.track.active);
    expect(table.match(/class="wtl-table-task"/g)?.length).toBe(active.length);
    expect(table).toContain(`<th scope="row">${active[0]?.row.thread.title}</th>`);
  });

  test('the table names the milestones a task row only draws as glyphs', () => {
    const milestoned = (track: TimelineLane['track']) =>
      track.pullRequests.find((candidate) => candidate.milestones.length > 0);
    const lane = frame({}).lanes.find((candidate) => candidate.tasks.some((item) => milestoned(item.track)));
    if (!lane) {
      throw new Error('The fixture needs a task with a dated pull request milestone');
    }
    const value = frame({ search: new URLSearchParams({ open: lane.key }).toString() });
    const body = html(Board, boardProps(value));
    const table = body.slice(body.indexOf('<details class="wtl-table">'));
    /** The "Pull requests" cell of the table row headed by `heading`. */
    const pullRequestCell = (heading: string): string => {
      const start = table.indexOf(`<th scope="row">${heading}</th>`);
      expect(start).toBeGreaterThan(-1);
      return table.slice(start, table.indexOf('</tr>', start)).split('<td>')[3] ?? '';
    };
    const task = lane.tasks.find((item) => milestoned(item.track));
    const bar = task && milestoned(task.track);
    if (!(task && bar)) {
      throw new Error('The lane lost its task with milestones');
    }
    const labels = bar.milestones.map((milestone) => milestone.label);
    expect(labels.every(Boolean)).toBe(true);
    expect(pullRequestCell(task.row.thread.title)).toContain(`${bar.description} (${labels.join('; ')})`);
    // A lane row draws the bars alone: its cell names no milestone.
    const laneCell = pullRequestCell(lane.label);
    expect(laneCell).not.toBe('');
    for (const label of labels) {
      expect(laneCell).not.toContain(label);
    }
  });

  test('no task is an explicit empty state, with a way out of the filters', () => {
    const value = frame({ rows: [] });
    expect(value.lanes).toEqual([]);
    const body = html(Board, boardProps(value));
    expect(body).toContain('<h2>No tasks in this view</h2>');
    expect(body).not.toContain('Clear filters');
    expect(body).not.toContain('class="wtl-legend"');
    expect(body).not.toContain('<details class="wtl-table">');
    // The window controls stay: an empty window is left by moving it, not by reloading.
    expect(body.match(SLIDER_PATTERN)?.length).toBe(2);
    const filtered = html(Board, boardProps(value, { query: { project: null, search: 'nothing' } }));
    expect(filtered).toContain('Clear filters');
  });
});
