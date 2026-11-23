import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { WorkThreadMark, WorkThreadRow } from '@ai-usage/report-core/work-thread-view';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import {
  createSyntheticWorkThreadStore,
  WORK_THREADS_FIXTURE_IDS,
} from '../../../../server/work-threads-e2e-fixture.server';
import {
  THREAD_BANDS,
  THREAD_LIFECYCLE_STEPS,
  type ThreadBand,
  threadAge,
  threadBand,
  threadBandCounts,
  threadLifecycle,
  threadLifecycleSummary,
  threadListQuery,
  threadRecentActivity,
  threadRowMeta,
  threadSituationCopy,
  threadWaitSince,
} from '../work-thread-model';

const TAG = /<[^>]+>/g;
const SPACES = /\s+/g;
const BAND_SECTION = /<section[^>]*\bdata-band="([^"]+)"[^>]*>(.*?)<\/section>/g;
const BAND_HEADING = /<h2[^>]*class="wt-band-head"[^>]*>(.*?)<\/h2>/;
const BUTTON = /<button([^>]*)>(.*?)<\/button>/g;
const RAIL = /<div[^>]*class="wt-rail"[^>]*>(.*?)<\/div>/;
const RAIL_STATE = /class="wt-rail-step" data-state="([^"]+)" data-step="([^"]+)"/g;
const ACTIVITY = /<svg[^>]*class="wt-row-activity"[^>]*>(.*?)<\/svg>/;
const RECT = /<rect([^>]*)><\/rect>/g;
const ROW = /data-work-thread="/g;
const ROW_ID = /data-work-thread="([^"]+)"/g;
const HIDDEN_LIST = /<ul[^>]*\bhidden\b/;
const LOADING_BUTTON = /<button class="wt-button" disabled(="")? type="button"> ?Loading… ?<\/button>/;
const LIST_ITEM_START = /^<li [^>]*>/;
const NEXT_TONE = /class="wt-row-next" data-tone="([^"]+)"/;
const BAR_KIND = /data-day="([^"]+)"/;
const BAR_HEIGHT = / height="([^"]+)"/;
const COLUMN_HEAD = /<div[^>]*class="wt-pilot-cols wt-pilot-colhead"[^>]*>(.*?)<\/div>/;
const COLUMN_LABEL = /<span[^>]*>([^<]+)<\/span>/g;
const LEGEND = /<ul[^>]*class="wt-pilot-legend"[^>]*>(.*?)<\/ul>/;
const LEGEND_ITEM = /<li>(.*?)<\/li>/g;

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: fileURLToPath(new URL('../../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());

const component = async (name: string): Promise<Component> => {
  const module: unknown = await server.ssrLoadModule(`/apps/web/src/lib/features/work/threads/${name}.svelte`);
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
const [Pilot, CompactRow, Rail, List] = await Promise.all(
  ['work-thread-pilot', 'work-thread-compact-row', 'work-thread-rail', 'work-thread-list'].map(component),
);
if (!(Pilot && CompactRow && Rail && List)) {
  throw new Error('Incomplete components');
}
const html = (view: Component, props: Record<string, unknown>) =>
  render(view, { props })
    .body.replaceAll(/<!--[^>]*-->/g, '')
    .replaceAll(SPACES, ' ');
/** The words as rendered: tags are dropped without adding any space the markup does not carry. */
const text = (markup: string): string => markup.replaceAll(TAG, '').replaceAll(SPACES, ' ').trim();
const escaped = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const noop = (): void => undefined;
const forbiddenCommand = (): Promise<never> => Promise.reject(new Error('SSR must never mutate tasks'));

const store = createSyntheticWorkThreadStore();
const query = threadListQuery(new URLSearchParams('view=pilot'));
const list = await store.readList(query);
const doneQuery = threadListQuery(new URLSearchParams('view=pilot&tab=done'));
const doneList = await store.readList(doneQuery);
const NOW = list.generatedAt;
const DAY = 86_400_000;
const instant = (offsetMs: number) => parseCanonicalInstant(new Date(Date.parse(NOW) + offsetMs).toISOString());
const fixtureRow = (id: string): WorkThreadRow => {
  const row = list.rows.find((item) => item.thread.threadId === id);
  if (!row) {
    throw new Error(`Missing fixture task ${id}`);
  }
  return row;
};
const payments = fixtureRow(WORK_THREADS_FIXTURE_IDS.payments);
const analysis = fixtureRow(WORK_THREADS_FIXTURE_IDS.analysis);
const running = fixtureRow(WORK_THREADS_FIXTURE_IDS.sessions);
const variant = (row: WorkThreadRow, suffix: number, patch: Partial<WorkThreadRow> = {}): WorkThreadRow => ({
  ...row,
  ...patch,
  thread: { ...row.thread, threadId: `12000000-0000-4000-8000-0000000009${suffix}`, title: `Variant ${suffix}` },
});
/**
 * Undelivered and silent for more than seven days: one with a step of the operator, one in progress.
 * Their waits are dated by their last activity, so no source date keeps them out of the dormant band.
 */
const dormantRows = [
  variant(fixtureRow(WORK_THREADS_FIXTURE_IDS.webhookTicket), 10, { lastActivityAt: instant(-9 * DAY) }),
  variant(running, 11, { lastActivityAt: instant(-12 * DAY) }),
];
const rows = [...list.rows, ...dormantRows];

const situationOf = (row: WorkThreadRow) => threadSituationCopy(row, NOW, list.sources, 'UTC');
const bandOf = (row: WorkThreadRow): ThreadBand => threadBand(row, situationOf(row), NOW);
const pilotProps = (patch: Record<string, unknown> = {}) => ({
  dataset: list,
  rows,
  query,
  timeZone: 'UTC',
  href: (id: string) => `/work?view=pilot&task=${id}`,
  onOpen: noop,
  onFilter: noop,
  onMore: noop,
  onCommand: forbiddenCommand,
  band: null,
  onBand: noop,
  focusId: null,
  ...patch,
});
const sections = (body: string) =>
  [...body.matchAll(BAND_SECTION)].map(([, band = '', content = '']) => ({
    band,
    heading: text(content.match(BAND_HEADING)?.[1] ?? ''),
    rows: content.match(ROW)?.length ?? 0,
    content,
  }));
const buttons = (body: string) =>
  [...body.matchAll(BUTTON)].map(([, attributes = '', content = '']) => ({ attributes, label: text(content) }));
const chip = (body: string, marker: string) => {
  const found = buttons(body).find(
    (button) => button.attributes.includes('class="wt-band-chip"') && button.attributes.includes(marker),
  );
  if (!found) {
    throw new Error(`Missing chip ${marker}`);
  }
  return found;
};
const rowProps = (row: WorkThreadRow, patch: Record<string, unknown> = {}) => ({
  row,
  situation: situationOf(row),
  band: bandOf(row),
  now: NOW,
  timeZone: 'UTC',
  href: `/work?view=pilot&task=${row.thread.threadId}`,
  onOpen: noop,
  ...patch,
});

describe('the Pilot bands', () => {
  const counts = threadBandCounts(rows, bandOf);
  const body = html(Pilot, pilotProps());

  test('the fixture spreads over every open band', () => {
    expect(counts).toEqual({ yours: 6, 'in-flight': 3, 'to-tidy': 4, dormant: 2, done: 0 });
  });
  test('a recent pull request milestone keeps a task out of the dormant band, whatever its last session', () => {
    const silent = variant(payments, 12, { lastActivityAt: instant(-9 * DAY) });
    expect(Date.parse(threadWaitSince(silent, situationOf(silent)).at)).toBeGreaterThan(Date.parse(instant(-7 * DAY)));
    expect(bandOf(silent)).toBe('yours');
  });
  test('one section per band present, in band order, with its count and note', () => {
    const rendered = sections(body);
    expect(rendered.map((section) => section.band)).toEqual(['yours', 'in-flight', 'to-tidy', 'dormant']);
    expect(rendered.map((section) => section.band)).toEqual(
      THREAD_BANDS.map((item) => item.band).filter((band) => counts[band] > 0),
    );
    expect(rendered.slice(0, 3).map((section) => section.heading)).toEqual([
      'Yours 6 tasks · an answer, a fix or a merge waits on you',
      'In flight 3 tasks · recent activity, nothing waits on you',
      'To tidy 4 tasks · delivered, closed or finished: tidy up and end the follow-up',
    ]);
    expect(rendered.slice(0, 3).map((section) => section.rows)).toEqual([6, 3, 4]);
    for (const section of rendered) {
      expect(section.content).toContain(`id="wt-band-${section.band}"`);
      expect(body).toContain(`aria-labelledby="wt-band-${section.band}"`);
    }
  });
  test('a single task is counted in the singular', () => {
    const [only] = sections(html(Pilot, pilotProps({ rows: [payments] })));
    expect(only?.heading).toBe('Yours 1 task · an answer, a fix or a merge waits on you');
  });
  test('the longest wait leads a band', () => {
    const yours = sections(body)[0]?.content ?? '';
    const waits = rows
      .filter((row) => bandOf(row) === 'yours')
      .map((row) => ({ id: row.thread.threadId, since: Date.parse(threadWaitSince(row, situationOf(row)).at) }))
      .sort((left, right) => left.since - right.since || left.id.localeCompare(right.id));
    expect([...yours.matchAll(ROW_ID)].map((match) => match[1])).toEqual(waits.map((wait) => wait.id));
  });
  test('chips carry each band count and none is pressed without a filter', () => {
    // A fieldset is the group: its name says what the toggle buttons filter.
    expect(body).toContain('<fieldset aria-label="Filter tasks by whose move it is" class="wt-band-chips">');
    for (const [band, label] of [
      ['yours', '6 yours'],
      ['in-flight', '3 in flight'],
      ['to-tidy', '4 to tidy'],
      ['dormant', '2 dormant'],
    ] as const) {
      const found = chip(body, `data-band="${band}"`);
      expect(found.label).toBe(label);
      expect(found.attributes).toContain('aria-pressed="false"');
    }
    const done = chip(body, 'data-tab="done"');
    expect(done.label).toBe(`Done ${list.counts.done}`);
    expect(done.attributes).toContain('aria-pressed="false"');
    expect(body).not.toContain('data-tab="open"');
  });
  test('a band filter presses its chip and renders that band alone, counts unchanged', () => {
    const filtered = html(Pilot, pilotProps({ band: 'in-flight' }));
    expect(sections(filtered).map((section) => [section.band, section.rows])).toEqual([['in-flight', 3]]);
    expect(chip(filtered, 'data-band="in-flight"').attributes).toContain('aria-pressed="true"');
    expect(chip(filtered, 'data-band="yours"').attributes).toContain('aria-pressed="false"');
    expect(chip(filtered, 'data-band="yours"').label).toBe('6 yours');
  });
  test('the column header names the eight steps and stays out of the accessibility tree', () => {
    const head = body.match(COLUMN_HEAD);
    expect(head?.[0]).toContain('aria-hidden="true"');
    expect([...(head?.[1] ?? '').matchAll(COLUMN_LABEL)].map((match) => match[1])).toEqual([
      'Project',
      'Task',
      ...THREAD_LIFECYCLE_STEPS.map((step) => step.short),
      '14 days',
      'Next',
      'Age',
    ]);
    expect(THREAD_LIFECYCLE_STEPS.map((step) => step.short)).toEqual([
      'Sess',
      'Push',
      'PR',
      'CI',
      'Rev',
      'Merge',
      'Disk',
      'Ticket',
    ]);
  });
  test('the filters, the source line and the load status stay with the list', () => {
    const sources = [{ source: 'github', state: 'failed', message: 'Private diagnostic', lastRunAt: NOW }];
    const withSources = html(Pilot, pilotProps({ dataset: { ...list, sources } }));
    expect(withSources).toContain('for="work-task-project"');
    expect(withSources).toContain('for="work-task-search"');
    expect(withSources).toContain('placeholder="Task, PR, ticket, branch…"');
    expect(withSources.indexOf('Source availability')).toBeGreaterThan(withSources.indexOf('work-task-search'));
    expect(body).toContain(`<p class="wt-sr" role="status">${rows.length} tasks loaded.</p>`);
    expect(body).not.toContain('Group by project');
  });
  test('the legend names the seven glyphs without repeating them to assistive technology', () => {
    const legend = body.match(LEGEND)?.[1] ?? '';
    expect([...legend.matchAll(LEGEND_ITEM)].map((match) => text(match[1] ?? ''))).toEqual([
      'Done',
      'Yours',
      'Running',
      'Failing',
      'To come',
      'Not read',
      'Not applicable',
    ]);
    expect(legend.split('<li><span aria-hidden="true"><div').length - 1).toBe(7);
    expect([...legend.matchAll(RAIL_STATE)].map((match) => match[1])).toEqual([
      'done',
      'yours',
      'running',
      'failed',
      'upcoming',
      'unread',
      'none',
    ]);
    expect(body).toContain(
      '“Done” means your follow-up has ended. A session ending, a PR merging and a ticket closing remain separate facts.',
    );
  });
});

describe('the dormant fold', () => {
  const dormant = (body: string) => {
    const section = sections(body).find((item) => item.band === 'dormant');
    if (!section) {
      throw new Error('Missing dormant band');
    }
    const [toggle] = buttons(section.content);
    if (!toggle) {
      throw new Error('Missing dormant toggle');
    }
    return { section, toggle };
  };
  test('is folded by default: its heading is the control and no row is rendered', () => {
    const { section, toggle } = dormant(html(Pilot, pilotProps()));
    expect(toggle.attributes).toContain('aria-expanded="false"');
    expect(toggle.attributes).toContain('aria-controls="wt-band-dormant-rows"');
    expect(toggle.label).toBe('2 dormant tasks · no activity for 7 days or more · 1 with a step of yours Show');
    expect(section.rows).toBe(0);
    expect(section.content).toContain('id="wt-band-dormant-rows"');
    expect(section.content).toMatch(HIDDEN_LIST);
    expect(html(Pilot, pilotProps()).match(ROW)?.length).toBe(rows.length - dormantRows.length);
  });
  test('says nothing of the operator when no dormant task waits on them, in the singular for one', () => {
    const { toggle } = dormant(html(Pilot, pilotProps({ rows: [...list.rows, dormantRows[1]] })));
    expect(toggle.label).toBe('1 dormant task · no activity for 7 days or more Show');
  });
  test('unfolds when the dormant band is the filter', () => {
    const { section, toggle } = dormant(html(Pilot, pilotProps({ band: 'dormant' })));
    expect(toggle.attributes).toContain('aria-expanded="true"');
    expect(toggle.label.endsWith(' Hide')).toBe(true);
    expect(section.rows).toBe(2);
    expect(section.content).not.toMatch(HIDDEN_LIST);
    // Dormant tasks show the most recent first.
    expect(section.content.indexOf('Variant 10')).toBeLessThan(section.content.indexOf('Variant 11'));
  });
  test('unfolds under a search, so a match is never hidden in the fold', () => {
    const { section, toggle } = dormant(html(Pilot, pilotProps({ query: { ...query, search: 'variant' } })));
    expect(toggle.attributes).toContain('aria-expanded="true"');
    expect(section.rows).toBe(2);
  });
  test('unfolds for the dormant task the operator returns from, so its row can take focus back', () => {
    const [returned] = dormantRows;
    if (!returned) {
      throw new Error('Missing dormant fixture');
    }
    const { section, toggle } = dormant(html(Pilot, pilotProps({ focusId: returned.thread.threadId })));
    expect(toggle.attributes).toContain('aria-expanded="true"');
    expect(toggle.label.endsWith(' Hide')).toBe(true);
    expect(section.rows).toBe(2);
    expect(section.content).not.toMatch(HIDDEN_LIST);
    expect(section.content).toContain(`data-work-thread="${returned.thread.threadId}"`);
    // A task of another band, or an id that names no loaded task, leaves the fold closed.
    for (const focusId of [payments.thread.threadId, '12000000-0000-4000-8000-000000000999', 'not an id']) {
      const folded = dormant(html(Pilot, pilotProps({ focusId })));
      expect(folded.toggle.attributes).toContain('aria-expanded="false"');
      expect(folded.section.rows).toBe(0);
    }
  });
});

describe('the Pilot header states', () => {
  test('the done list swaps the band chips for the Following / Done pair', () => {
    const body = html(Pilot, pilotProps({ dataset: doneList, rows: doneList.rows, query: doneQuery }));
    const following = chip(body, 'data-tab="open"');
    expect(following.label).toBe(`Following ${doneList.counts.open}`);
    expect(following.attributes).toContain('aria-pressed="false"');
    const done = chip(body, 'data-tab="done"');
    expect(done.label).toBe(`Done ${doneList.counts.done}`);
    expect(done.attributes).toContain('aria-pressed="true"');
    expect(body).not.toContain('data-band="yours" ');
    expect(buttons(body).filter((button) => button.attributes.includes('class="wt-band-chip"'))).toHaveLength(2);
    expect(sections(body).map((section) => [section.band, section.heading, section.rows])).toEqual([
      ['done', 'Done 1 task · follow-up ended', 1],
    ]);
  });
  test('a partial page says how many tasks the counters cover and offers the next page', () => {
    const partial = html(
      Pilot,
      pilotProps({ dataset: { ...list, nextCursor: 'next', counts: { ...list.counts, open: 240 } } }),
    );
    expect(partial).toContain(`<p class="wt-pilot-partial">first ${rows.length} of 240 tasks counted</p>`);
    expect(buttons(partial).some((button) => button.label === 'Load more')).toBe(true);
    // Under a filter the total of followed tasks is not the total of matches, so it is not quoted.
    for (const filter of [{ project: 'synthetic/example-shop' }, { search: 'payment' }]) {
      const filtered = html(
        Pilot,
        pilotProps({
          dataset: { ...list, nextCursor: 'next', counts: { ...list.counts, open: 240 } },
          query: { ...query, ...filter },
        }),
      );
      expect(filtered).toContain(`<p class="wt-pilot-partial">first ${rows.length} matching tasks counted</p>`);
      expect(filtered).not.toContain('of 240');
    }
    const complete = html(Pilot, pilotProps());
    expect(complete).not.toContain('tasks counted');
    expect(buttons(complete).some((button) => button.label === 'Load more')).toBe(false);
    const continued = html(
      Pilot,
      pilotProps({ dataset: { ...list, nextCursor: 'next' }, continuation: true, loadingMore: true }),
    );
    expect(continued).toContain('Continue in a new page; browser Back keeps this view.');
    expect(continued).toMatch(LOADING_BUTTON);
  });
  test('an empty list keeps the lanes wording, its filter reset and the way to the sessions', () => {
    const empty = html(Pilot, pilotProps({ rows: [], query: { ...query, project: 'ai-usage' } }));
    expect(empty).toContain('No tasks in this view');
    expect(empty).toContain('Try another project or search. Session intake remains available.');
    expect(buttons(empty).some((button) => button.label === 'Clear filters')).toBe(true);
    expect(empty).toContain('<a class="wt-link" href="/work/sessions">Browse sessions</a>');
    expect(empty).not.toContain('wt-pilot-colhead');
    const unfiltered = html(Pilot, pilotProps({ rows: [] }));
    expect(buttons(unfiltered).some((button) => button.label === 'Clear filters')).toBe(false);
    expect(html(Pilot, pilotProps({ dataset: doneList, rows: [], query: doneQuery }))).toContain(
      'No ended follow-ups here',
    );
  });
  test('a band filter that leaves nothing offers every band back', () => {
    const body = html(Pilot, pilotProps({ rows: list.rows, band: 'dormant' }));
    expect(sections(body)).toEqual([]);
    expect(body).toContain('No tasks in this band');
    expect(buttons(body).some((button) => button.label === 'Show all bands')).toBe(true);
    expect(body).not.toContain('No tasks in this view');
    expect(chip(body, 'data-band="dormant"').label).toBe('0 dormant');
  });
});

describe('the task shown in the side pane', () => {
  test('no row is current without a selection', () => {
    expect(html(Pilot, pilotProps())).not.toContain('aria-current');
    expect(html(CompactRow, rowProps(payments))).not.toContain('aria-current');
  });
  test('the selected task marks its row, and only that one', () => {
    const selected = html(Pilot, pilotProps({ selectedId: payments.thread.threadId }));
    expect(selected.split('aria-current="true"').length - 1).toBe(1);
    expect(selected).toContain(
      `aria-current="true" class="wt-pilot-cols wt-row" data-band="yours" data-work-thread="${payments.thread.threadId}"`,
    );
  });
  test('a selected dormant task unfolds its band, so the pane never shows a task the list hides', () => {
    const [chosen] = dormantRows;
    if (!chosen) {
      throw new Error('Missing dormant fixture');
    }
    const body = html(Pilot, pilotProps({ selectedId: chosen.thread.threadId }));
    const section = sections(body).find((item) => item.band === 'dormant');
    expect(section?.rows).toBe(2);
    expect(section?.content).not.toMatch(HIDDEN_LIST);
    expect(body).toContain(`data-work-thread="${chosen.thread.threadId}"`);
    expect(body.split('aria-current="true"').length - 1).toBe(1);
  });
});
describe('a compact row', () => {
  const situation = situationOf(payments);
  const body = html(CompactRow, rowProps(payments));

  test('is one list item carrying its task and band', () => {
    expect(body).toMatch(LIST_ITEM_START);
    expect(body).toContain('class="wt-pilot-cols wt-row"');
    expect(body).toContain(`data-work-thread="${payments.thread.threadId}"`);
    expect(body).toContain('data-band="yours"');
  });
  test('leads with the short project and links the title to the task, its only control', () => {
    const row = { ...payments, thread: { ...payments.thread, projectLabel: 'acmecorp/Meridian' } };
    const named = html(CompactRow, rowProps(row));
    expect(named).toContain('<span class="wt-project-tag" title="acmecorp/Meridian">Meridian</span>');
    // The stretched link covers the row, so its tooltip carries the full next step under the title.
    const raw = render(CompactRow, { props: rowProps(row) }).body;
    expect(raw).toContain(
      `<a class="wt-row-title" href="/work?view=pilot&amp;task=${row.thread.threadId}" title="${row.thread.title}\nNext: ${situation.headline}">${row.thread.title}</a>`,
    );
    expect(named.split('<a ').length - 1).toBe(1);
    expect(named).not.toContain('<button');
    const unassigned = html(CompactRow, rowProps({ ...payments, thread: { ...payments.thread, projectLabel: null } }));
    expect(unassigned).toContain('<span class="wt-project-tag wt-no-project">No project</span>');
  });
  test('its second line is the row meta', () => {
    expect(threadRowMeta(payments)).toBe('PR #1487 changes requested · 4 sessions · 1 delegated');
    expect(body).toContain(`<p class="wt-row-meta">${threadRowMeta(payments)}</p>`);
  });
  test('a task without sessions says where none was read', () => {
    const review = fixtureRow(WORK_THREADS_FIXTURE_IDS.review);
    expect(html(CompactRow, rowProps(review))).toContain('No sessions on this machine</p>');
  });
  test('the next step is the headline, toned by whose move it is', () => {
    expect(situation.headline).toBe('Address 2 review threads on #1487');
    // No tooltip of its own: the title link stretched over the row is what the pointer meets.
    expect(body).toContain(
      `<p class="wt-row-next" data-tone="yours"><span class="wt-sr">Next: </span>${situation.headline}</p>`,
    );
    const toneOf = (row: WorkThreadRow, patch: Record<string, unknown> = {}) =>
      html(CompactRow, rowProps(row, patch)).match(NEXT_TONE)?.[1];
    expect(toneOf(running)).toBe('running');
    expect(toneOf(analysis)).toBe('tidy');
    expect(toneOf(fixtureRow(WORK_THREADS_FIXTURE_IDS.tests))).toBe('failed');
    expect(toneOf(dormantRows[0] ?? payments)).toBe('quiet');
    expect(toneOf(doneList.rows[0] ?? payments, { situation: situationOf(doneList.rows[0] ?? payments) })).toBe(
      'quiet',
    );
    const marker = payments.markers.pullRequests[0];
    if (!marker?.latest) {
      throw new Error('Expected a PR observation');
    }
    const failing = {
      ...payments,
      markers: {
        ...payments.markers,
        pullRequests: [
          {
            ...marker,
            latest: { ...marker.latest, checksRollup: 'failure', reviewDecision: null, unresolvedReviewThreads: 0 },
          },
        ],
      },
    } as WorkThreadRow;
    const failed = html(CompactRow, rowProps(failing));
    expect(failed).toContain('data-tone="failed"');
    expect(failed).toContain('</span>Fix checks on #1487</p>');
  });
  test('the age dates the wait by its source and names that source', () => {
    const since = threadWaitSince(payments, situation);
    expect(since.basis).toBe('pull-request');
    expect(body).toMatch(
      new RegExp(
        `<time class="wt-row-age" datetime="${since.at}" title="PR status since [A-Z][a-z]{2} \\d+"><span class="wt-sr">PR status since </span>${threadAge(since.at, NOW)}</time>`,
      ),
    );
  });
  test('the rail is one image whose name is the lifecycle in words, with eight shaped steps', () => {
    const steps = threadLifecycle(payments, situation.remainders);
    const rail = body.match(RAIL);
    expect(rail?.[0]).toContain('role="img"');
    expect(rail?.[0]).toContain(`aria-label="${escaped(`Lifecycle. ${threadLifecycleSummary(steps)}`)}"`);
    expect([...(rail?.[1] ?? '').matchAll(RAIL_STATE)].map((match) => `${match[2]}:${match[1]}`)).toEqual(
      steps.map((step) => `${step.key}:${step.state}`),
    );
    expect(steps).toHaveLength(8);
    expect((rail?.[1] ?? '').split('<svg aria-hidden="true"').length - 1).toBe(8);
    const [first] = steps;
    expect(rail?.[1]).toContain(`title="${escaped(`${first?.name}: ${first?.detail}`)}"`);
  });
  test('the activity strip is one described image with a bar per day', () => {
    const at = (daysAgo: number) => instant(-daysAgo * DAY);
    const session = (daysAgo: number): WorkThreadMark => ({
      at: at(daysAgo),
      fact: null,
      harness: 'claude',
      kind: 'session',
      label: 'Session',
      source: null,
    });
    const marks: WorkThreadMark[] = [
      session(0),
      session(0),
      session(3),
      {
        at: at(5),
        fact: 'pull-request-opened',
        harness: null,
        kind: 'event',
        label: 'PR #1487 opened',
        source: { key: 'github.example/synthetic/example-shop#1487', label: 'PR #1487' },
      },
    ];
    const strip = html(CompactRow, rowProps({ ...payments, marks })).match(ACTIVITY);
    const activity = threadRecentActivity(marks, NOW, 'UTC');
    expect(activity.description).toBe('Last 14 days: 3 sessions on 2 days, 1 pull request milestone');
    expect(strip?.[0]).toContain('role="img"');
    expect(strip?.[0]).toContain(`aria-label="${activity.description}"`);
    expect(strip?.[0]).toContain('height="18"');
    expect(strip?.[0]).toContain('width="70"');
    const bars = [...(strip?.[1] ?? '').matchAll(RECT)].map(([, attributes = '']) => ({
      day: attributes.match(BAR_KIND)?.[1],
      height: Number(attributes.match(BAR_HEIGHT)?.[1]),
      today: attributes.includes('class="wt-today"'),
      current: attributes.includes('fill="currentColor"'),
    }));
    expect(bars).toHaveLength(14);
    expect(bars.every((bar) => bar.current)).toBe(true);
    expect(bars.map((bar) => bar.today)).toEqual([...Array.from({ length: 13 }, () => false), true]);
    // Today's two sessions set the scale; one session is half of it, never as low as an idle day.
    expect(bars.at(-1)).toMatchObject({ day: 'sessions', height: 16 });
    expect(bars.at(-4)).toMatchObject({ day: 'sessions', height: 8 });
    expect(bars.at(-6)).toMatchObject({ day: 'milestone', height: 2 });
    expect(bars.at(-2)).toMatchObject({ day: 'idle', height: 1 });
    const idle = html(CompactRow, rowProps({ ...payments, marks: [] })).match(ACTIVITY);
    expect(idle?.[0]).toContain('aria-label="Last 14 days: no activity"');
    expect([...(idle?.[1] ?? '').matchAll(RECT)]).toHaveLength(14);
  });
});

describe('the rail alone', () => {
  test('an empty rail is still a named image', () => {
    expect(html(Rail, { steps: [] })).toBe('<div aria-label="Lifecycle. " class="wt-rail" role="img"></div>');
  });
});

describe('the lanes list can group by band', () => {
  const listProps = {
    dataset: list,
    rows,
    query,
    timeZone: 'UTC',
    href: () => '/work',
    onOpen: noop,
    onFilter: noop,
    onMore: noop,
    onCommand: forbiddenCommand,
  };
  test('band grouping renders the band labels and notes over the same rows', () => {
    const body = html(List, { ...listProps, grouping: 'band' });
    for (const label of ['Yours', 'In flight', 'To tidy', 'Dormant']) {
      expect(body).toContain(`aria-label="${label} tasks"`);
    }
    expect(body).toContain('6 tasks · An answer, a fix or a merge waits on you');
    expect(body).not.toContain('aria-label="To resume tasks"');
    expect(body.match(ROW)?.length).toBe(rows.length);
  });
  test('the default grouping still renders the situations', () => {
    const body = html(List, listProps);
    expect(body).toContain('aria-label="To resume tasks"');
    expect(body).not.toContain('aria-label="Yours tasks"');
    expect(body).toBe(html(List, { ...listProps, grouping: 'situation' }));
  });
});
