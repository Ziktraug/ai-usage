import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { pullRequestLinkKey, type WorkThread } from '@ai-usage/report-core/work-thread';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadEpisode,
  type WorkThreadFactEventKind,
  type WorkThreadMark,
  type WorkThreadPullRequestMarker,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import {
  createSyntheticWorkThreadStore,
  WORK_THREADS_FIXTURE_IDS,
} from '../../../server/work-threads-e2e-fixture.server';
import { groupThreadRowsBySituation, threadDayKey, threadSituationCopy } from './work-thread-model';
import {
  activeTimelineZoom,
  brushIndexesOfWindow,
  resolveTimelineWindow,
  shiftDayKey,
  TIMELINE_DEFAULT_DAYS,
  TIMELINE_DETAIL_MAX,
  TIMELINE_HEAT_LEGEND,
  TIMELINE_HEAT_STEPS,
  TIMELINE_MAX_PR_ROWS,
  TIMELINE_ZOOMS,
  timelineColumnKey,
  timelineDetailTargets,
  timelineDomain,
  timelineHeatLevel,
  timelineLanes,
  timelineLoadedCopy,
  timelineOverview,
  timelinePosition,
  timelineResolution,
  timelineScale,
  timelineSessionBars,
  timelineShiftWindow,
  timelineTodayWindow,
  timelineViewState,
  timelineViewUrl,
  timelineZoomWindow,
  windowOfBrushIndexes,
} from './work-timeline-model';

/** Wednesday; Monday is Nov 9 and the six-week window starts on Thursday Oct 1. */
const NOW = parseCanonicalInstant('2026-11-11T10:30:00.000Z');
const at = (value: string) => parseCanonicalInstant(`${value}:00.000Z`);
/** The track fraction of a wall-clock minute of the window's `day`th day. */
const fraction = (day: number, minutes: number, days: number): number => (day + minutes / 1440) / days;
/** Session marks are starts: no track may describe them as time worked. */
const WORK_TIME_WORDING = /work time|duration/i;

const store = createSyntheticWorkThreadStore();
const fixture = await store.readDetail(WORK_THREADS_FIXTURE_IDS.payments);
if (!fixture?.episodes[0]) {
  throw new Error('Expected the synthetic payments task and its first episode');
}
const baseRow = fixture.row;
const baseEpisode = fixture.episodes[0];

const sessionMark = (instant: string): WorkThreadMark => ({
  at: at(instant),
  fact: null,
  harness: 'claude',
  kind: 'session',
  label: 'A session',
  source: null,
});
const observation = (number: number, overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'main',
  checksRollup: 'success',
  closedAt: null,
  createdAt: at('2026-11-09T08:00'),
  draft: false,
  headRef: `feat/change-${number}`,
  host: 'github.example',
  machineId: 'test-machine',
  mergedAt: null,
  number,
  observedAt: NOW,
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'acme/shop',
  reviewDecision: null,
  state: 'OPEN',
  title: `Change ${number}`,
  updatedAt: null,
  url: null,
  ...overrides,
});
const pullRequest = (number: number, overrides: Partial<PullRequestObservation> = {}): WorkThreadPullRequestMarker => {
  const fact = observation(number, overrides);
  return {
    key: pullRequestLinkKey(fact),
    latest: fact,
    latestSuccessful: fact,
    mergeable: 'mergeable',
    mergeStateStatus: 'CLEAN',
    role: 'author',
  };
};
const milestone = (number: number, instant: string, fact: WorkThreadFactEventKind): WorkThreadMark => ({
  at: at(instant),
  fact,
  harness: null,
  kind: 'event',
  label: `PR #${number} ${fact.replace('pull-request-', '')}`,
  source: {
    key: pullRequestLinkKey({ host: 'github.example', number, repository: 'acme/shop' }),
    label: `PR #${number}`,
  },
});

interface TaskInput {
  readonly first?: string;
  readonly last: string;
  readonly marks?: readonly WorkThreadMark[];
  readonly project?: string | null;
  readonly pullRequests?: readonly WorkThreadPullRequestMarker[];
  readonly running?: number;
  readonly thread?: Partial<WorkThread>;
}
/** A task with no link and no session source to qualify, so its hint follows only what the test sets. */
const task = (id: number, input: TaskInput): WorkThreadRow => ({
  ...baseRow,
  afterDone: null,
  combinedThreads: [],
  delegatedSessionCount: 0,
  firstActivityAt: at(input.first ?? input.last),
  lastActivityAt: at(input.last),
  links: [],
  markers: { jiraIssues: [], local: [], pullRequests: input.pullRequests ?? [] },
  marks: input.marks ?? [],
  nativeRequestCoverage: 'complete',
  nativeRequests: [],
  runningSessions: input.running ?? 0,
  sessionCount: 0,
  thread: {
    ...baseRow.thread,
    followState: 'following',
    intent: 'change',
    projectLabel: input.project === undefined ? 'acme/shop' : input.project,
    threadId: `14000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    title: `Task ${id}`,
    waitingFor: null,
    waitingOn: null,
    ...input.thread,
  },
});
const idOf = (row: WorkThreadRow): string => row.thread.threadId;

const sixWeeks = timelineDomain(NOW, 'UTC', []);
const sixWeekScale = timelineScale(sixWeeks, NOW, 'UTC');
const lanesOf = (rows: readonly WorkThreadRow[], grouping: 'project' | 'attention' = 'project', scale = sixWeekScale) =>
  timelineLanes({ grouping, now: NOW, rows, scale, sourcesOf: () => [] });
const onlyTrack = (row: WorkThreadRow, scale = sixWeekScale) => {
  const track = lanesOf([row], 'project', scale)[0]?.tasks[0]?.track;
  if (!track) {
    throw new Error('Expected one task track');
  }
  return track;
};

describe('timeline view state in the URL', () => {
  test('reads the grouping, the opened and quiet lanes and the window', () => {
    const state = timelineViewState(
      new URLSearchParams(
        'view=timeline&group=attention&open=to-resume&open=waiting&open=to-resume&quiet=waiting&from=2026-10-01&to=2026-10-07',
      ),
    );
    expect(state).toEqual({
      grouping: 'attention',
      open: ['to-resume', 'waiting'],
      quiet: ['waiting'],
      window: { from: '2026-10-01', to: '2026-10-07' },
    });
    expect(timelineViewState(new URLSearchParams('group=anything&open='))).toEqual({
      grouping: 'project',
      open: [],
      quiet: [],
      window: null,
    });
  });
  test.each([
    ['a missing end', 'from=2026-10-01'],
    ['a missing start', 'to=2026-10-07'],
    ['a reversed range', 'from=2026-10-07&to=2026-10-01'],
    ['a malformed day', 'from=2026-10-1&to=2026-10-07'],
    ['a day that does not exist', 'from=2026-02-30&to=2026-03-07'],
    ['a timestamp', 'from=2026-10-01T00:00:00Z&to=2026-10-07'],
  ])('ignores a window with %s', (_label, search) => {
    expect(timelineViewState(new URLSearchParams(search)).window).toBeNull();
  });
  test('round-trips a state and leaves every other param untouched', () => {
    const current = new URL('http://localhost/work?view=timeline&project=acme%2Fshop&q=retry&task=abc#top');
    const state = {
      grouping: 'project' as const,
      open: ['acme/shop', 'No project'],
      quiet: ['No project'],
      window: { from: '2026-11-05', to: '2026-11-11' },
    };
    const url = timelineViewUrl(current, state);
    expect(timelineViewState(url.searchParams)).toEqual(state);
    // The other grouping round-trips too, once the URL is in it.
    const attention = { ...state, grouping: 'attention' as const, open: ['to-resume', 'done'], quiet: ['done'] };
    const regrouped = timelineViewUrl(url, { grouping: 'attention' });
    expect(timelineViewState(timelineViewUrl(regrouped, attention).searchParams)).toEqual(attention);
    expect(url.searchParams.get('view')).toBe('timeline');
    expect(url.searchParams.get('project')).toBe('acme/shop');
    expect(url.searchParams.get('q')).toBe('retry');
    expect(url.searchParams.get('task')).toBe('abc');
    expect(url.hash).toBe('#top');
    expect(url.pathname).toBe('/work');
    // The input URL is never mutated.
    expect(current.search).toBe('?view=timeline&project=acme%2Fshop&q=retry&task=abc');
  });
  test('removes default values instead of writing them', () => {
    const current = new URL(
      'http://localhost/work?view=timeline&group=attention&open=waiting&quiet=waiting&from=2026-11-05&to=2026-11-11',
    );
    const url = timelineViewUrl(current, { grouping: 'project', window: null });
    expect(url.search).toBe('?view=timeline');
    expect(timelineViewUrl(current, { open: [], quiet: [] }).search).toBe(
      '?view=timeline&group=attention&from=2026-11-05&to=2026-11-11',
    );
  });
  test('a patch changes only what it names and never duplicates a lane key', () => {
    const current = new URL('http://localhost/work?view=timeline&open=acme%2Fshop&from=2026-11-05&to=2026-11-11');
    const url = timelineViewUrl(current, { open: ['acme/shop', 'No project', 'acme/shop'] });
    expect(url.searchParams.getAll('open')).toEqual(['acme/shop', 'No project']);
    expect(timelineViewState(url.searchParams).window).toEqual({ from: '2026-11-05', to: '2026-11-11' });
    expect(timelineViewUrl(current, { window: null }).searchParams.getAll('open')).toEqual(['acme/shop']);
  });
  test('changing the grouping clears the opened and quiet lanes, whose keys differ between groupings', () => {
    const current = new URL(
      'http://localhost/work?view=timeline&open=acme%2Fshop&quiet=acme%2Fshop&from=2026-11-05&to=2026-11-11',
    );
    const regrouped = timelineViewState(timelineViewUrl(current, { grouping: 'attention' }).searchParams);
    expect(regrouped).toEqual({
      grouping: 'attention',
      open: [],
      quiet: [],
      window: { from: '2026-11-05', to: '2026-11-11' },
    });
    // A full state handed back with another grouping still drops the stale lane keys.
    const state = timelineViewState(current.searchParams);
    expect(timelineViewUrl(current, { ...state, grouping: 'attention' }).searchParams.getAll('open')).toEqual([]);
    // The same grouping is not a change.
    expect(timelineViewUrl(current, { grouping: 'project' }).searchParams.getAll('open')).toEqual(['acme/shop']);
  });
  test('refuses a window the URL could not carry back', () => {
    const current = new URL('http://localhost/work');
    expect(() => timelineViewUrl(current, { window: { from: '2026-11-11', to: '2026-11-05' } })).toThrow(RangeError);
    expect(() => timelineViewUrl(current, { window: { from: 'yesterday', to: '2026-11-05' } })).toThrow(RangeError);
  });
});

describe('timeline domain and window', () => {
  const domain = timelineDomain(NOW, 'UTC', ['2026-08-04T09:00:00.000Z']);
  const day = (index: number): string => {
    const key = domain[index];
    if (key === undefined) {
      throw new Error(`No domain day ${index}`);
    }
    return key;
  };

  test('day keys shift by calendar days across months, years and daylight-saving changes', () => {
    expect(shiftDayKey('2026-11-11', -41)).toBe('2026-10-01');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDayKey('2026-10-25', 1)).toBe('2026-10-26');
    expect(shiftDayKey('2026-03-29', -1)).toBe('2026-03-28');
    expect(shiftDayKey('2026-11-11', 0)).toBe('2026-11-11');
    expect(() => shiftDayKey('2026-11-11T10:00', 1)).toThrow(RangeError);
    expect(() => shiftDayKey('2026-11-11', 0.5)).toThrow(RangeError);
  });
  test('the domain reaches back six weeks at least, to the earliest activity, within the view bound', () => {
    expect(sixWeeks).toHaveLength(TIMELINE_DEFAULT_DAYS);
    expect(sixWeeks[0]).toBe('2026-10-01');
    expect(sixWeeks.at(-1)).toBe('2026-11-11');
    expect(new Set(sixWeeks).size).toBe(sixWeeks.length);
    const reaching = timelineDomain(NOW, 'UTC', ['2026-11-01T10:00:00.000Z', '2026-08-30T23:30:00.000Z']);
    expect(reaching[0]).toBe('2026-08-30');
    expect(reaching.at(-1)).toBe('2026-11-11');
    // The same instant is already the next calendar day in Paris.
    expect(timelineDomain(NOW, 'Europe/Paris', ['2026-08-30T23:30:00.000Z'])[0]).toBe('2026-08-31');
    expect(timelineDomain(NOW, 'UTC', ['2020-01-01T00:00:00.000Z'])).toHaveLength(
      WORK_THREAD_VIEW_BOUNDS.maxTimelineDays,
    );
    // Today is the operator's calendar day, not the UTC one.
    expect(timelineDomain('2026-11-11T23:30:00.000Z', 'Europe/Paris', []).at(-1)).toBe('2026-11-12');
  });
  test('the default window is the last six weeks; a requested one is clamped into the domain', () => {
    expect(domain).toHaveLength(100);
    expect(resolveTimelineWindow(domain, null)).toEqual({ fromIndex: 58, toIndex: 99 });
    expect(resolveTimelineWindow(domain, { from: day(10), to: day(20) })).toEqual({ fromIndex: 10, toIndex: 20 });
    expect(resolveTimelineWindow(domain, { from: day(7), to: day(7) })).toEqual({ fromIndex: 7, toIndex: 7 });
    expect(resolveTimelineWindow(domain, { from: '2026-07-01', to: day(5) })).toEqual({ fromIndex: 0, toIndex: 5 });
    expect(resolveTimelineWindow(domain, { from: day(95), to: '2026-12-25' })).toEqual({ fromIndex: 95, toIndex: 99 });
    expect(resolveTimelineWindow(domain, { from: '2026-01-01', to: '2027-01-01' })).toEqual({
      fromIndex: 0,
      toIndex: 99,
    });
  });
  test('a window entirely outside the domain gives the default one, and a short domain is shown whole', () => {
    expect(resolveTimelineWindow(domain, { from: '2026-06-01', to: '2026-06-30' })).toEqual({
      fromIndex: 58,
      toIndex: 99,
    });
    expect(resolveTimelineWindow(domain, { from: '2026-12-01', to: '2026-12-02' })).toEqual({
      fromIndex: 58,
      toIndex: 99,
    });
    expect(resolveTimelineWindow(domain.slice(-10), null)).toEqual({ fromIndex: 0, toIndex: 9 });
  });
  test('an empty domain or a reversed window is refused instead of resolved to something plausible', () => {
    expect(() => resolveTimelineWindow([], null)).toThrow(RangeError);
    expect(() => resolveTimelineWindow(domain, { from: day(20), to: day(10) })).toThrow(RangeError);
    expect(() => resolveTimelineWindow(domain, { from: 'last week', to: day(10) })).toThrow(RangeError);
    expect(() => timelineZoomWindow([], { fromIndex: 0, toIndex: 0 }, 7)).toThrow(RangeError);
    expect(() => timelineShiftWindow([], { fromIndex: 0, toIndex: 0 }, 1)).toThrow(RangeError);
    expect(() => timelineTodayWindow([], { fromIndex: 0, toIndex: 0 })).toThrow(RangeError);
  });
  test('a zoom preset keeps the window end, and keeps its span at the domain start by moving the end', () => {
    expect(timelineZoomWindow(domain, { fromIndex: 58, toIndex: 99 }, 7)).toEqual({ from: day(93), to: day(99) });
    expect(timelineZoomWindow(domain, { fromIndex: 30, toIndex: 50 }, 1)).toEqual({ from: day(50), to: day(50) });
    expect(timelineZoomWindow(domain, { fromIndex: 30, toIndex: 50 }, 42)).toEqual({ from: day(9), to: day(50) });
    expect(timelineZoomWindow(domain, { fromIndex: 0, toIndex: 2 }, 7)).toEqual({ from: day(0), to: day(6) });
    expect(timelineZoomWindow(domain, { fromIndex: 0, toIndex: 2 }, 500)).toEqual({ from: day(0), to: day(99) });
    expect(() => timelineZoomWindow(domain, { fromIndex: 0, toIndex: 2 }, 0)).toThrow(RangeError);
  });
  test('a shift moves the window by its own span and stops at the domain edges', () => {
    expect(timelineShiftWindow(domain, { fromIndex: 86, toIndex: 92 }, -1)).toEqual({ from: day(79), to: day(85) });
    expect(timelineShiftWindow(domain, { fromIndex: 86, toIndex: 92 }, 1)).toEqual({ from: day(93), to: day(99) });
    expect(timelineShiftWindow(domain, { fromIndex: 93, toIndex: 99 }, 1)).toEqual({ from: day(93), to: day(99) });
    expect(timelineShiftWindow(domain, { fromIndex: 90, toIndex: 96 }, 1)).toEqual({ from: day(93), to: day(99) });
    expect(timelineShiftWindow(domain, { fromIndex: 2, toIndex: 8 }, -1)).toEqual({ from: day(0), to: day(6) });
    expect(timelineShiftWindow(domain, { fromIndex: 50, toIndex: 50 }, -1)).toEqual({ from: day(49), to: day(49) });
  });
  test('back to today keeps the span and ends on the last domain day', () => {
    expect(timelineTodayWindow(domain, { fromIndex: 10, toIndex: 16 })).toEqual({ from: day(93), to: day(99) });
    expect(timelineTodayWindow(domain, { fromIndex: 0, toIndex: 0 })).toEqual({ from: day(99), to: day(99) });
    expect(timelineTodayWindow(domain, { fromIndex: 58, toIndex: 99 })).toEqual({ from: day(58), to: day(99) });
  });
  test('only the exact preset spans light a zoom button', () => {
    expect(TIMELINE_ZOOMS.map((zoom) => [zoom.id, activeTimelineZoom(zoom.days)])).toEqual([
      ['24h', '24h'],
      ['7d', '7d'],
      ['6w', '6w'],
    ]);
    expect(activeTimelineZoom(10)).toBeNull();
    expect(activeTimelineZoom(0)).toBeNull();
  });
  test.each([
    [1, 'hour'],
    [2, 'quarter-day'],
    [7, 'quarter-day'],
    [14, 'quarter-day'],
    [15, 'day'],
    [42, 'day'],
    [366, 'day'],
  ] as const)('a window of %i days reads at the %s resolution', (span, resolution) => {
    expect(timelineResolution(span)).toBe(resolution);
  });
  test('a window of no day or of a fraction of a day has no resolution', () => {
    expect(() => timelineResolution(0)).toThrow(RangeError);
    expect(() => timelineResolution(1.5)).toThrow(RangeError);
    expect(() => timelineResolution(Number.NaN)).toThrow(RangeError);
  });
  test('the brush selects day boundaries: a window maps to its boundaries and back', () => {
    const window = { fromIndex: 3, toIndex: 9 };
    expect(brushIndexesOfWindow(window)).toEqual([3, 10]);
    expect(windowOfBrushIndexes(domain, brushIndexesOfWindow(window))).toEqual({ from: day(3), to: day(9) });
    expect(brushIndexesOfWindow({ fromIndex: 99, toIndex: 99 })).toEqual([99, 100]);
    expect(windowOfBrushIndexes(domain, [0, 100])).toEqual({ from: day(0), to: day(99) });
    expect(windowOfBrushIndexes(domain, [10, 3])).toEqual({ from: day(3), to: day(9) });
    expect(windowOfBrushIndexes(domain, [3.4, 9.6])).toEqual({ from: day(3), to: day(9) });
  });
  test('a collapsed or out-of-range brush selection becomes one valid day', () => {
    expect(windowOfBrushIndexes(domain, [5, 5])).toEqual({ from: day(5), to: day(5) });
    expect(windowOfBrushIndexes(domain, [0, 0])).toEqual({ from: day(0), to: day(0) });
    expect(windowOfBrushIndexes(domain, [100, 100])).toEqual({ from: day(99), to: day(99) });
    expect(windowOfBrushIndexes(domain, [150, 160])).toEqual({ from: day(99), to: day(99) });
    expect(windowOfBrushIndexes(domain, [-8, -2])).toEqual({ from: day(0), to: day(0) });
    expect(windowOfBrushIndexes(domain, [-4, 250])).toEqual({ from: day(0), to: day(99) });
    expect(() => windowOfBrushIndexes(domain, [Number.NaN, 4])).toThrow(RangeError);
    expect(() => windowOfBrushIndexes([], [0, 1])).toThrow(RangeError);
  });
});

describe('timeline scale', () => {
  test('six weeks read one column per day, weeks ticked on Mondays under their months', () => {
    const scale = sixWeekScale;
    expect(scale.resolution).toBe('day');
    expect(scale.timeZone).toBe('UTC');
    expect(scale.days).toEqual(sixWeeks);
    expect(scale.columns).toHaveLength(42);
    expect(scale.columns.map((column) => column.key)).toEqual([...sixWeeks]);
    expect(scale.columns.every((column) => column.key === column.dayKey)).toBe(true);
    expect(scale.columns[0]).toEqual({
      dayKey: '2026-10-01',
      key: '2026-10-01',
      label: 'Thu, Oct 1',
      major: false,
      tick: null,
      today: false,
    });
    expect(scale.columns.flatMap((column) => (column.tick === null ? [] : [`${column.key} ${column.tick}`]))).toEqual([
      '2026-10-05 5',
      '2026-10-12 12',
      '2026-10-19 19',
      '2026-10-26 26',
      '2026-11-02 2',
      '2026-11-09 9',
    ]);
    expect(scale.columns.filter((column) => column.major).map((column) => column.label)).toEqual([
      'Mon, Oct 5',
      'Mon, Oct 12',
      'Mon, Oct 19',
      'Mon, Oct 26',
      'Mon, Nov 2',
      'Mon, Nov 9',
    ]);
    expect(scale.groups).toEqual([
      { label: 'Oct 2026', start: 1, span: 31 },
      { label: 'Nov 2026', start: 32, span: 11 },
    ]);
    expect(scale.columns.filter((column) => column.today).map((column) => column.key)).toEqual(['2026-11-11']);
    expect(scale.now).toBeCloseTo(fraction(41, 630, 42), 12);
  });
  test('past two months of columns only month starts keep a tick, and Mondays stay major', () => {
    const scale = timelineScale(timelineDomain(NOW, 'UTC', ['2026-08-14T09:00:00.000Z']), NOW, 'UTC');
    expect(scale.columns).toHaveLength(90);
    expect(scale.columns.flatMap((column) => (column.tick === null ? [] : [`${column.key} ${column.tick}`]))).toEqual([
      '2026-09-01 1',
      '2026-10-01 1',
      '2026-11-01 1',
    ]);
    expect(scale.columns.filter((column) => column.major)).toHaveLength(13);
    expect(scale.groups.map((group) => [group.label, group.start, group.span])).toEqual([
      ['Aug 2026', 1, 18],
      ['Sep 2026', 19, 30],
      ['Oct 2026', 49, 31],
      ['Nov 2026', 80, 11],
    ]);
  });
  test('seven days read four six-hour blocks per day, each day named on its first block', () => {
    const days = sixWeeks.slice(-7);
    const scale = timelineScale(days, NOW, 'UTC');
    expect(scale.resolution).toBe('quarter-day');
    expect(scale.columns).toHaveLength(28);
    expect(scale.columns.slice(0, 5).map((column) => column.key)).toEqual([
      '2026-11-05#0',
      '2026-11-05#1',
      '2026-11-05#2',
      '2026-11-05#3',
      '2026-11-06#0',
    ]);
    expect(scale.columns.slice(0, 4).map((column) => column.label)).toEqual([
      'Thu, Nov 5, 00:00–06:00',
      'Thu, Nov 5, 06:00–12:00',
      'Thu, Nov 5, 12:00–18:00',
      'Thu, Nov 5, 18:00–24:00',
    ]);
    expect(scale.columns.flatMap((column) => (column.tick === null ? [] : [column.tick]))).toEqual([
      'Thu 5',
      'Fri 6',
      'Sat 7',
      'Sun 8',
      'Mon 9',
      'Tue 10',
      'Wed 11',
    ]);
    expect(scale.columns.map((column) => column.major)).toEqual(
      Array.from({ length: 28 }, (_, index) => index % 4 === 0),
    );
    expect(scale.columns.filter((column) => column.today).map((column) => column.key)).toEqual([
      '2026-11-11#0',
      '2026-11-11#1',
      '2026-11-11#2',
      '2026-11-11#3',
    ]);
    expect(scale.groups).toEqual([{ label: 'Nov 2026', start: 1, span: 28 }]);
    expect(scale.now).toBeCloseTo(fraction(6, 630, 7), 12);
    // A week across two months pins both, over whole days of blocks.
    expect(timelineScale(sixWeeks.slice(28, 35), NOW, 'UTC').groups).toEqual([
      { label: 'Oct 2026', start: 1, span: 12 },
      { label: 'Nov 2026', start: 13, span: 16 },
    ]);
  });
  test('one day reads twenty-four hours under its full date', () => {
    const scale = timelineScale(['2026-11-11'], NOW, 'UTC');
    expect(scale.resolution).toBe('hour');
    expect(scale.columns).toHaveLength(24);
    expect(scale.columns.map((column) => column.key)).toEqual(
      Array.from({ length: 24 }, (_, hour) => `2026-11-11#${hour}`),
    );
    expect(scale.columns[14]).toEqual({
      dayKey: '2026-11-11',
      key: '2026-11-11#14',
      label: 'Wed, Nov 11, 14:00–15:00',
      major: false,
      tick: null,
      today: true,
    });
    expect(scale.columns[23]?.label).toBe('Wed, Nov 11, 23:00–24:00');
    expect(scale.columns.map((column) => column.tick)).toEqual(
      Array.from({ length: 24 }, (_, hour) => (hour % 3 === 0 ? String(hour).padStart(2, '0') : null)),
    );
    expect(scale.columns.flatMap((column, hour) => (column.major ? [hour] : []))).toEqual([0, 6, 12, 18]);
    expect(scale.groups).toEqual([{ label: 'Wed, Nov 11, 2026', start: 1, span: 24 }]);
    expect(scale.now).toBeCloseTo(630 / 1440, 12);
  });
  test('"now" is absent from a window that does not hold today', () => {
    const past = timelineScale(sixWeeks.slice(0, 7), NOW, 'UTC');
    expect(past.now).toBeNull();
    expect(past.columns.some((column) => column.today)).toBe(false);
    expect(timelineScale(['2026-11-12'], NOW, 'UTC').now).toBeNull();
    // 23:30 UTC is already tomorrow in Paris: today is the operator's calendar day.
    const paris = timelineScale(['2026-11-12'], '2026-11-11T23:30:00.000Z', 'Europe/Paris');
    expect(paris.now).toBeCloseTo(30 / 1440, 12);
    expect(paris.columns.every((column) => column.today)).toBe(true);
  });
  test.each([
    ['the 25-hour day', '2026-10-25'],
    ['the 23-hour day', '2026-03-29'],
  ])('a daylight-saving change keeps the columns of %s', (_label, day) => {
    const hours = timelineScale([day], NOW, 'Europe/Paris');
    expect(hours.columns.map((column) => column.key)).toEqual(
      Array.from({ length: 24 }, (_, hour) => `${day}#${hour}`),
    );
    const days = Array.from({ length: 7 }, (_, index) => shiftDayKey(day, index - 3));
    const week = timelineScale(days, NOW, 'Europe/Paris');
    expect(week.days).toEqual(days);
    expect(week.columns).toHaveLength(28);
    expect(new Set(week.columns.map((column) => column.key)).size).toBe(28);
    const six = timelineScale(
      Array.from({ length: 42 }, (_, index) => shiftDayKey(day, index - 20)),
      NOW,
      'Europe/Paris',
    );
    expect(six.columns).toHaveLength(42);
    expect(six.columns[20]?.key).toBe(day);
  });
  test('the repeated hour of a daylight-saving change is one wall-clock column', () => {
    const scale = timelineScale(['2026-10-25'], NOW, 'Europe/Paris');
    // 02:30 CEST then 02:30 CET, one real hour apart.
    expect(timelineColumnKey(scale, '2026-10-25T00:30:00.000Z')).toBe('2026-10-25#2');
    expect(timelineColumnKey(scale, '2026-10-25T01:30:00.000Z')).toBe('2026-10-25#2');
    expect(timelinePosition(scale, '2026-10-25T00:30:00.000Z')).toBeCloseTo(150 / 1440, 12);
    expect(timelinePosition(scale, '2026-10-25T01:30:00.000Z')).toBeCloseTo(150 / 1440, 12);
    // The last instant of that long day is still inside its 24 columns.
    expect(timelineColumnKey(scale, '2026-10-25T22:59:00.000Z')).toBe('2026-10-25#23');
    expect(timelinePosition(scale, '2026-10-25T22:59:00.000Z')).toBeLessThan(1);
  });
  test('refuses no day, days out of order and a day that is not a calendar key', () => {
    expect(() => timelineScale([], NOW, 'UTC')).toThrow(RangeError);
    expect(() => timelineScale(['2026-11-10', '2026-11-12'], NOW, 'UTC')).toThrow(RangeError);
    expect(() => timelineScale(['2026-11-11', '2026-11-10'], NOW, 'UTC')).toThrow(RangeError);
    expect(() => timelineScale(['11/11/2026'], NOW, 'UTC')).toThrow(RangeError);
    expect(() => timelineScale(['2026-11-11'], 'not a date', 'UTC')).toThrow(RangeError);
  });
});

describe('timeline placement', () => {
  const days = ['2026-11-10', '2026-11-11'];
  const utc = timelineScale(days, NOW, 'UTC');
  const paris = timelineScale(days, NOW, 'Europe/Paris');
  const angeles = timelineScale(days, NOW, 'America/Los_Angeles');
  const lateEvening = '2026-11-10T23:30:00.000Z';

  test('an instant is placed by its wall-clock day and minute in the operator time zone', () => {
    expect(timelinePosition(utc, lateEvening)).toBeCloseTo(fraction(0, 1410, 2), 12);
    // Past midnight in Paris: the next column day, half an hour in.
    expect(timelinePosition(paris, lateEvening)).toBeCloseTo(fraction(1, 30, 2), 12);
    expect(timelinePosition(angeles, lateEvening)).toBeCloseTo(fraction(0, 930, 2), 12);
    expect(timelinePosition(utc, '2026-11-10T00:00:00.000Z')).toBe(0);
    expect(timelinePosition(utc, '2026-11-11T12:00:00.000Z')).toBe(0.75);
  });
  test('an instant outside the window is placed by its day distance, unclamped', () => {
    expect(timelinePosition(utc, '2026-11-08T12:00:00.000Z')).toBe(-0.75);
    expect(timelinePosition(utc, '2026-11-12T00:00:00.000Z')).toBe(1);
    expect(timelinePosition(utc, '2026-11-12T12:00:00.000Z')).toBe(1.25);
    expect(timelinePosition(utc, '2025-11-10T00:00:00.000Z')).toBe(-365 / 2);
    // 00:30 UTC on the first day is still the evening before in Los Angeles.
    expect(timelinePosition(angeles, '2026-11-10T00:30:00.000Z')).toBeCloseTo(fraction(-1, 990, 2), 12);
  });
  test('the column key follows the same wall clock at every resolution', () => {
    expect(timelineColumnKey(utc, lateEvening)).toBe('2026-11-10#3');
    expect(timelineColumnKey(paris, lateEvening)).toBe('2026-11-11#0');
    expect(timelineColumnKey(angeles, lateEvening)).toBe('2026-11-10#2');
    const hours = timelineScale(['2026-11-11'], NOW, 'Europe/Paris');
    expect(timelineColumnKey(hours, lateEvening)).toBe('2026-11-11#0');
    expect(timelineColumnKey(hours, '2026-11-11T22:59:00.000Z')).toBe('2026-11-11#23');
    // A column outside the window is still named, so the caller can tell it is not one of its own.
    expect(timelineColumnKey(hours, '2026-11-11T23:00:00.000Z')).toBe('2026-11-12#0');
    const parisDays = timelineScale(sixWeeks, NOW, 'Europe/Paris');
    expect(timelineColumnKey(parisDays, lateEvening)).toBe('2026-11-11');
    expect(timelineColumnKey(sixWeekScale, lateEvening)).toBe('2026-11-10');
  });
  test('column days are the calendar days the rest of the Work view uses', () => {
    for (const timeZone of ['UTC', 'Europe/Paris', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']) {
      const scale = timelineScale(sixWeeks, NOW, timeZone);
      for (const instant of [
        '2026-10-24T23:59:59.999Z',
        '2026-10-25T00:30:00.000Z',
        '2026-03-29T01:30:00.000Z',
        '2026-12-31T23:30:00.000Z',
        '2027-01-01T00:00:00.000Z',
      ]) {
        expect(timelineColumnKey(scale, instant)).toBe(threadDayKey(instant, timeZone));
      }
    }
  });
  test('an instant that is not a date is refused', () => {
    expect(() => timelinePosition(utc, 'soon')).toThrow(RangeError);
    expect(() => timelineColumnKey(utc, '')).toThrow(RangeError);
  });
});

describe('timeline heat', () => {
  test('levels follow the published steps and legend', () => {
    expect(TIMELINE_HEAT_STEPS).toEqual([1, 2, 5, 10]);
    expect(TIMELINE_HEAT_LEGEND).toEqual(['1', '2–4', '5–9', '10+']);
    expect([0, 1, 2, 4, 5, 9, 10, 250].map(timelineHeatLevel)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('timeline lanes', () => {
  const merged = task(1, {
    first: '2026-09-20T09:00',
    last: '2026-11-10T12:00',
    marks: [
      sessionMark('2026-09-20T09:00'),
      sessionMark('2026-11-09T09:00'),
      sessionMark('2026-11-09T10:00'),
      sessionMark('2026-11-09T23:59'),
      sessionMark('2026-11-10T09:00'),
      { ...sessionMark('2026-11-09T09:30'), harness: null, kind: 'event', label: 'Marked as waiting' },
      milestone(98, '2026-11-09T08:00', 'pull-request-opened'),
      milestone(98, '2026-11-10T12:00', 'pull-request-merged'),
    ],
    pullRequests: [pullRequest(98, { mergedAt: at('2026-11-10T12:00'), state: 'MERGED' })],
  });
  const failing = task(2, {
    first: '2026-09-20T08:00',
    last: '2026-11-09T11:00',
    marks: [sessionMark('2026-11-09T08:00'), sessionMark('2026-11-09T11:00')],
    pullRequests: [pullRequest(97, { checksRollup: 'failure', createdAt: at('2026-09-20T08:00') })],
  });
  const undecided = task(3, { last: '2026-11-11T09:00', project: null });
  const ended = task(4, {
    last: '2026-11-01T12:00',
    marks: [sessionMark('2026-11-01T12:00')],
    project: 'other/tools',
    thread: { followState: 'done' },
  });
  const rows = [ended, failing, undecided, merged];

  test('project lanes come by most recent activity, their tasks latest first, with their attention counts', () => {
    const lanes = lanesOf(rows);
    expect(lanes.map((lane) => [lane.key, lane.label, lane.status, lane.lastActivityAt])).toEqual([
      ['No project', 'No project', '1 to decide', at('2026-11-11T09:00')],
      ['acme/shop', 'shop', '1 to resume · 1 ready to close', at('2026-11-10T12:00')],
      ['other/tools', 'tools', '1 done', at('2026-11-01T12:00')],
    ]);
    expect(lanes.map((lane) => lane.tasks.map((item) => idOf(item.row)))).toEqual([
      [idOf(undecided)],
      [idOf(merged), idOf(failing)],
      [idOf(ended)],
    ]);
    expect(lanes.map((lane) => lane.activeTasks)).toEqual([0, 2, 1]);
    const shop = lanes[1]?.tasks ?? [];
    expect(shop.map((item) => [item.hint, item.hintLabel, item.project])).toEqual([
      ['ready-to-close', 'Ready to close', 'shop'],
      ['to-resume', 'To resume', 'shop'],
    ]);
    expect(shop[0]?.row).toBe(merged);
  });
  test('a task hint is the one the task list derives', () => {
    for (const lane of lanesOf(rows)) {
      for (const item of lane.tasks) {
        const copy = threadSituationCopy(item.row, NOW, [], 'UTC');
        expect([item.hint, item.hintLabel]).toEqual([copy.hint, copy.label]);
      }
    }
    // The sources given to the lanes qualify the hint: a failed sessions read leaves a linked session undecided.
    const linked = { ...task(5, { last: '2026-11-10T09:00', thread: { intent: 'analysis' } }), sessionCount: 1 };
    const hintWith = (sources: readonly WorkThreadSourceStatus[]) =>
      timelineLanes({ grouping: 'project', now: NOW, rows: [linked], scale: sixWeekScale, sourcesOf: () => sources })[0]
        ?.tasks[0]?.hint;
    expect(hintWith([{ source: 'sessions', state: 'ok', lastRunAt: NOW, message: null }])).toBe('ready-to-close');
    expect(hintWith([{ source: 'sessions', state: 'failed', lastRunAt: NOW, message: 'Collection failed' }])).toBe(
      'undecided',
    );
  });
  test('each task is qualified by the sources of its own read, not by the worst of all reads', () => {
    const linked = (id: number, last: string): WorkThreadRow => ({
      ...task(id, { last, thread: { intent: 'analysis' } }),
      sessionCount: 1,
    });
    const fresh = linked(5, '2026-11-10T09:00');
    const unread = linked(6, '2026-11-09T09:00');
    const asked: string[] = [];
    const lanes = timelineLanes({
      grouping: 'attention',
      now: NOW,
      rows: [fresh, unread],
      scale: sixWeekScale,
      sourcesOf: (threadId) => {
        asked.push(threadId);
        return [
          threadId === idOf(unread)
            ? { source: 'sessions', state: 'failed', lastRunAt: NOW, message: 'Collection failed' }
            : { source: 'sessions', state: 'ok', lastRunAt: NOW, message: null },
        ];
      },
    });
    expect(asked).toEqual([idOf(fresh), idOf(unread)]);
    expect(lanes.map((lane) => [lane.key, lane.tasks.map((item) => idOf(item.row))])).toEqual([
      ['undecided', [idOf(unread)]],
      ['ready-to-close', [idOf(fresh)]],
    ]);
  });
  test('two projects that share a short name are labelled by their full name', () => {
    const lanes = lanesOf([
      task(24, { last: '2026-11-10T09:00' }),
      task(25, { last: '2026-11-09T09:00', project: 'other/shop' }),
      task(26, { last: '2026-11-08T09:00', project: 'other/tools' }),
      task(27, { last: '2026-11-07T09:00', project: null }),
    ]);
    expect(lanes.map((lane) => [lane.key, lane.label])).toEqual([
      ['acme/shop', 'acme/shop'],
      ['other/shop', 'other/shop'],
      ['other/tools', 'tools'],
      ['No project', 'No project'],
    ]);
    // A task still names its project by its short name; only the lanes that would read as one are spelled out.
    expect(lanes.map((lane) => lane.tasks[0]?.project)).toEqual(['shop', 'shop', 'tools', 'No project']);
  });
  test('attention lanes follow the task list order and count their projects', () => {
    const every = [
      ...rows,
      task(5, { last: '2026-11-07T09:00', project: 'other/tools', thread: { followState: 'waiting' } }),
      task(6, { last: '2026-11-06T09:00', running: 1 }),
      task(7, { last: '2026-11-05T09:00', project: 'other/tools' }),
    ];
    const lanes = lanesOf(every, 'attention');
    expect(lanes.map((lane) => [lane.key, lane.label, lane.status, lane.tasks.length])).toEqual([
      ['to-resume', 'To resume', '1 project', 1],
      ['in-progress', 'In progress', '1 project', 1],
      ['undecided', 'To decide', '2 projects', 2],
      ['waiting', 'Waiting', '1 project', 1],
      ['ready-to-close', 'Ready to close', '1 project', 1],
      ['done', 'Done', '1 project', 1],
    ]);
    expect(lanes.map((lane) => lane.label)).toEqual(
      groupThreadRowsBySituation(every, (row) => threadSituationCopy(row, NOW, [], 'UTC').hint).map(
        (group) => group.label,
      ),
    );
    expect(lanes[2]?.tasks.map((item) => idOf(item.row))).toEqual([idOf(undecided), idOf(every[6] ?? undecided)]);
    expect(lanes[2]?.lastActivityAt).toBe(at('2026-11-11T09:00'));
    // Empty groups are omitted, not listed with a zero.
    expect(lanesOf(rows, 'attention').map((lane) => lane.key)).toEqual([
      'to-resume',
      'undecided',
      'ready-to-close',
      'done',
    ]);
    expect(lanesOf([])).toEqual([]);
    expect(lanesOf([], 'attention')).toEqual([]);
  });
  test('heat counts session starts per column inside the window, and a lane sums its tasks', () => {
    const lane = lanesOf(rows)[1];
    const [first, second] = lane?.tasks ?? [];
    // Nov 9 is column 39, Nov 10 column 40. The September start and the follow-up change are not counted.
    expect(first?.track.heat).toHaveLength(42);
    expect(first?.track.heat[39]).toEqual({ count: 3, level: 2 });
    expect(first?.track.heat[40]).toEqual({ count: 1, level: 1 });
    expect(first?.track.sessions).toBe(4);
    expect(second?.track.heat[39]).toEqual({ count: 2, level: 2 });
    expect(second?.track.sessions).toBe(2);
    expect(lane?.track.heat[39]).toEqual({ count: 5, level: 3 });
    expect(lane?.track.heat[40]).toEqual({ count: 1, level: 1 });
    expect(lane?.track.heat.filter((cell) => cell.count > 0)).toHaveLength(2);
    expect(lane?.track.sessions).toBe(6);
  });
  test('heat follows the scale resolution and the operator time zone', () => {
    const late = task(8, { last: '2026-11-10T23:30', marks: [sessionMark('2026-11-10T23:30')] });
    const cells = (timeZone: string, days: readonly string[]) => {
      const scale = timelineScale(days, NOW, timeZone);
      return onlyTrack(late, scale).heat.flatMap((cell, index) => (cell.count > 0 ? [scale.columns[index]?.key] : []));
    };
    expect(cells('UTC', ['2026-11-10', '2026-11-11'])).toEqual(['2026-11-10#3']);
    expect(cells('Europe/Paris', ['2026-11-10', '2026-11-11'])).toEqual(['2026-11-11#0']);
    expect(cells('UTC', ['2026-11-10'])).toEqual(['2026-11-10#23']);
    // In Paris that start belongs to the next day: the 24 h window of Nov 10 does not hold it.
    expect(cells('Europe/Paris', ['2026-11-10'])).toEqual([]);
    expect(onlyTrack(late, timelineScale(['2026-11-10'], NOW, 'Europe/Paris')).active).toBe(false);
  });
  test('a pull request is one bar from its opening to its merge, with its milestones and state', () => {
    const track = onlyTrack(merged);
    expect(track.pullRequests).toHaveLength(1);
    const bar = track.pullRequests[0];
    expect(bar).toMatchObject({
      checks: null,
      description: 'PR #98 · Merged · opened Nov 9 · merged Nov 10',
      endsAfter: false,
      key: 'github.example/acme/shop#98',
      label: '#98',
      open: false,
      row: 0,
      startsBefore: false,
      threadId: idOf(merged),
      title: 'Change 98',
      tone: 'merged',
    });
    expect(bar?.start).toBeCloseTo(fraction(39, 480, 42), 12);
    expect(bar?.end).toBeCloseTo(fraction(40, 720, 42), 12);
    expect(bar?.milestones.map((item) => [item.kind, item.label])).toEqual([
      ['pull-request-opened', 'PR #98 opened'],
      ['pull-request-merged', 'PR #98 merged'],
    ]);
    expect(bar?.milestones[0]?.at).toBeCloseTo(fraction(39, 480, 42), 12);
    expect(bar?.milestones[1]?.at).toBeCloseTo(fraction(40, 720, 42), 12);
    expect(track.pullRequestRows).toBe(1);
    expect(track.hiddenPullRequests).toBe(0);
    expect(track.undatedPullRequests).toBe(0);
    expect(track.active).toBe(true);
  });
  test('an open pull request opened before the window starts at its edge and ends at now', () => {
    const bar = onlyTrack(failing).pullRequests[0];
    expect(bar).toMatchObject({
      checks: 'failing',
      description: 'PR #97 · Open · opened Sep 20 · still open · Checks fail',
      endsAfter: false,
      label: '#97',
      milestones: [],
      open: true,
      start: 0,
      startsBefore: true,
      tone: 'open',
    });
    expect(bar?.end).toBeCloseTo(fraction(41, 630, 42), 12);
    expect(bar?.end).toBe(sixWeekScale.now ?? Number.NaN);
  });
  test('an open pull request whose latest read failed ends where it was last read open, not at now', () => {
    const read = observation(96, { createdAt: at('2026-11-02T08:00'), observedAt: at('2026-11-08T12:00') });
    const failedRead: PullRequestObservation = { ...read, observedAt: NOW, outcome: 'network', state: null };
    const trackOf = (latest: PullRequestObservation | null) =>
      onlyTrack(
        task(21, {
          last: '2026-11-08T12:00',
          pullRequests: [{ ...pullRequest(96), latest, latestSuccessful: read }],
        }),
      );
    const stale = trackOf(failedRead);
    const bar = stale.pullRequests[0];
    expect(bar).toMatchObject({
      checks: 'passing',
      description: 'PR #96 · Open · opened Nov 2 · last read open Nov 8 · Checks pass',
      endsAfter: false,
      open: false,
      tone: 'open',
    });
    expect(bar?.start).toBeCloseTo(fraction(32, 480, 42), 12);
    expect(bar?.end).toBeCloseTo(fraction(38, 720, 42), 12);
    expect(stale.summary).toBe('No session started. PR #96 last read open Nov 8.');
    // No latest attempt at all is not a read of "now" either.
    expect(trackOf(null).pullRequests[0]).toMatchObject({ end: bar?.end, open: false });
    // The latest attempt observed it: the bar reaches now, whatever object carries the observation.
    const current = trackOf({ ...read, observedAt: NOW }).pullRequests[0];
    expect(current).toMatchObject({
      description: 'PR #96 · Open · opened Nov 2 · still open · Checks pass',
      open: true,
    });
    expect(current?.end).toBe(sixWeekScale.now ?? Number.NaN);
  });
  test('a task whose marks reach the bound of the list read says that older sessions are not counted', () => {
    const marks = Array.from({ length: WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow }, () => sessionMark('2026-11-09T09:00'));
    const full = task(22, { last: '2026-11-09T09:00', marks });
    const beside = task(23, { last: '2026-11-08T09:00', marks: [sessionMark('2026-11-08T09:00')] });
    const below = task(28, { last: '2026-11-07T09:00', marks: marks.slice(1), project: 'other/tools' });
    const [shop, tools] = lanesOf([full, beside, below]);
    expect(shop?.tasks.map((item) => [item.track.capped, item.track.summary])).toEqual([
      [
        true,
        '240 sessions started, busiest Mon, Nov 9 (240). Older sessions are beyond what the list read carries and are not counted.',
      ],
      [false, '1 session started, Sun, Nov 8.'],
    ]);
    // One capped task makes its lane partial too.
    expect(shop?.track.capped).toBe(true);
    expect(shop?.track.summary).toBe(
      '241 sessions started, busiest Mon, Nov 9 (240). Older sessions are beyond what the list read carries and are not counted.',
    );
    expect(tools?.track.capped).toBe(false);
    expect(tools?.track.summary).toBe('239 sessions started, busiest Mon, Nov 9 (239).');
    // The sentence closes the text equivalent, after the pull requests.
    const withPullRequest = task(29, {
      last: '2026-11-09T09:00',
      marks,
      pullRequests: [pullRequest(95, { mergedAt: at('2026-11-10T12:00'), state: 'MERGED' })],
    });
    expect(onlyTrack(withPullRequest).summary).toBe(
      '240 sessions started, busiest Mon, Nov 9 (240). PR #95 merged Nov 10. Older sessions are beyond what the list read carries and are not counted.',
    );
  });
  test('a bar is clamped into an earlier window and says that it continues', () => {
    const earlier = timelineScale(sixWeeks.slice(0, 14), NOW, 'UTC');
    const open = task(9, {
      last: '2026-10-10T08:00',
      pullRequests: [pullRequest(60, { createdAt: at('2026-10-10T12:00') })],
    });
    expect(onlyTrack(open, earlier).pullRequests[0]).toMatchObject({
      end: 1,
      endsAfter: true,
      open: true,
      startsBefore: false,
    });
    expect(onlyTrack(open, earlier).pullRequests[0]?.start).toBeCloseTo(fraction(9, 720, 14), 12);
    const spanning = task(10, {
      last: '2026-11-01T08:00',
      pullRequests: [
        pullRequest(61, { createdAt: at('2026-09-01T12:00'), mergedAt: at('2026-11-01T08:00'), state: 'MERGED' }),
      ],
    });
    expect(onlyTrack(spanning, earlier).pullRequests[0]).toMatchObject({
      end: 1,
      endsAfter: true,
      open: false,
      start: 0,
      startsBefore: true,
    });
  });
  test('a pull request entirely outside the window is neither drawn nor counted as undated', () => {
    const earlier = timelineScale(sixWeeks.slice(0, 14), NOW, 'UTC');
    const later = task(11, {
      last: '2026-11-06T08:00',
      marks: [milestone(62, '2026-11-05T08:00', 'pull-request-opened')],
      pullRequests: [
        pullRequest(62, { createdAt: at('2026-11-05T08:00'), mergedAt: at('2026-11-06T08:00'), state: 'MERGED' }),
      ],
    });
    expect(onlyTrack(later, earlier)).toMatchObject({
      active: false,
      hiddenPullRequests: 0,
      pullRequestRows: 0,
      pullRequests: [],
      summary: 'No session started and no pull request in this window.',
      undatedPullRequests: 0,
    });
    const before = task(12, {
      last: '2026-09-06T08:00',
      pullRequests: [
        pullRequest(63, { closedAt: at('2026-09-06T08:00'), createdAt: at('2026-09-05T08:00'), state: 'CLOSED' }),
      ],
    });
    expect(onlyTrack(before).pullRequests).toEqual([]);
    expect(onlyTrack(before).active).toBe(false);
  });
  test('a closed pull request ends where it closed, or where it was last updated', () => {
    const closed = (overrides: Partial<PullRequestObservation>) =>
      onlyTrack(
        task(13, {
          last: '2026-11-07T08:00',
          pullRequests: [pullRequest(64, { createdAt: at('2026-11-05T00:00'), state: 'CLOSED', ...overrides })],
        }),
      ).pullRequests[0];
    const dated = closed({ closedAt: at('2026-11-06T00:00'), updatedAt: at('2026-11-08T00:00') });
    expect(dated).toMatchObject({
      description: 'PR #64 · Closed · opened Nov 5 · closed Nov 6',
      open: false,
      tone: 'closed',
    });
    expect(dated?.end).toBeCloseTo(fraction(36, 0, 42), 12);
    const updated = closed({ closedAt: null, updatedAt: at('2026-11-08T00:00') });
    expect(updated?.description).toBe('PR #64 · Closed · opened Nov 5 · last updated Nov 8');
    expect(updated?.end).toBeCloseTo(fraction(38, 0, 42), 12);
  });
  test('without a creation date a pull request starts at its earliest milestone', () => {
    const marker = pullRequest(65, { createdAt: null, updatedAt: at('2026-11-08T00:00') });
    const unknown: WorkThreadPullRequestMarker = {
      ...marker,
      latest: marker.latest && { ...marker.latest, outcome: 'network', state: null },
      latestSuccessful: null,
    };
    const row = task(14, {
      last: '2026-11-07T08:00',
      marks: [
        milestone(65, '2026-11-06T12:00', 'pull-request-approved'),
        milestone(65, '2026-11-05T12:00', 'pull-request-ready'),
        milestone(99, '2026-11-01T12:00', 'pull-request-opened'),
      ],
      pullRequests: [unknown],
    });
    const bar = onlyTrack(row).pullRequests[0];
    expect(bar).toMatchObject({
      checks: null,
      description: 'PR #65 · State unknown · first milestone Nov 5 · last milestone Nov 6',
      label: '#65',
      open: false,
      title: null,
      tone: 'unknown',
    });
    expect(bar?.start).toBeCloseTo(fraction(35, 720, 42), 12);
    expect(bar?.end).toBeCloseTo(fraction(36, 720, 42), 12);
    // Only this pull request's milestones, oldest first.
    expect(bar?.milestones.map((item) => item.kind)).toEqual(['pull-request-ready', 'pull-request-approved']);
    expect(onlyTrack(row).summary).toBe('No session started. PR #65 state unknown.');
  });
  test('a pull request known only by its opening is drawn where it opened, not stretched to a guess', () => {
    const marker = pullRequest(66, { createdAt: at('2026-11-05T12:00'), state: null });
    const bar = onlyTrack(task(15, { last: '2026-11-05T12:00', pullRequests: [marker] })).pullRequests[0];
    expect(bar?.description).toBe('PR #66 · State unknown · opened Nov 5');
    expect(bar?.start).toBeCloseTo(fraction(35, 720, 42), 12);
    expect(bar?.end).toBe(bar?.start ?? Number.NaN);
  });
  test('a linked pull request with no usable date is counted, never drawn', () => {
    const undated = (number: number): WorkThreadPullRequestMarker => ({
      key: `github.example/acme/shop#${number}`,
      latest: null,
      latestSuccessful: null,
      mergeable: null,
      mergeStateStatus: null,
      role: null,
    });
    const row = task(16, { last: '2026-11-05T12:00', pullRequests: [undated(70), undated(71)] });
    expect(onlyTrack(row)).toMatchObject({
      active: false,
      hiddenPullRequests: 0,
      pullRequests: [],
      sessions: 0,
      summary: 'No session started and no pull request in this window. 2 linked pull requests have no usable date.',
      undatedPullRequests: 2,
    });
    const lane = lanesOf([row, task(17, { last: '2026-11-04T12:00', pullRequests: [undated(70)] })])[0];
    expect(lane?.tasks[1]?.track.summary).toBe(
      'No session started and no pull request in this window. 1 linked pull request has no usable date.',
    );
    // The lane counts one pull request once, however many of its tasks link it.
    expect(lane?.track.undatedPullRequests).toBe(2);
    expect(lane?.activeTasks).toBe(0);
  });
  test('bars that overlap take the next row; a bar that starts a gap later shares the row', () => {
    const mergedBar = (number: number, opened: string, mergedAt: string) =>
      pullRequest(number, { createdAt: at(opened), mergedAt: at(mergedAt), state: 'MERGED' });
    const track = onlyTrack(
      task(18, {
        last: '2026-11-08T08:00',
        pullRequests: [
          mergedBar(4, '2026-10-20T00:00', '2026-10-21T00:00'),
          mergedBar(1, '2026-10-05T00:00', '2026-10-07T00:00'),
          mergedBar(3, '2026-10-07T00:00', '2026-10-08T00:00'),
          mergedBar(2, '2026-10-06T00:00', '2026-10-09T00:00'),
        ],
      }),
    );
    // Oldest start first. #3 starts exactly where #1 ends: no gap, so not the same row.
    expect(track.pullRequests.map((bar) => [bar.label, bar.row])).toEqual([
      ['#1', 0],
      ['#2', 1],
      ['#3', 2],
      ['#4', 0],
    ]);
    expect(track.pullRequestRows).toBe(3);
    expect(track.hiddenPullRequests).toBe(0);
    for (const row of [0, 1, 2]) {
      const inRow = track.pullRequests.filter((bar) => bar.row === row);
      for (const [index, bar] of inRow.entries()) {
        expect(bar.start).toBeGreaterThan(inRow[index - 1]?.end ?? -1);
      }
    }
  });
  test('bars beyond the drawn rows are counted, not drawn, and stay named in the summary', () => {
    const open = Array.from({ length: 8 }, (_, index) =>
      pullRequest(index + 1, { createdAt: at(`2026-09-0${index + 1}T08:00`) }),
    );
    const track = onlyTrack(task(19, { last: '2026-11-08T08:00', pullRequests: open }));
    expect(track.pullRequests.map((bar) => [bar.label, bar.row])).toEqual([
      ['#1', 0],
      ['#2', 1],
      ['#3', 2],
      ['#4', 3],
    ]);
    expect(track.pullRequests.every((bar) => bar.row < TIMELINE_MAX_PR_ROWS)).toBe(true);
    expect(track.pullRequestRows).toBe(TIMELINE_MAX_PR_ROWS);
    expect(track.hiddenPullRequests).toBe(4);
    expect(track.active).toBe(true);
    expect(track.summary).toBe(
      'No session started. PR #1 open since Sep 1; PR #2 open since Sep 2; PR #3 open since Sep 3; PR #4 open since Sep 4; PR #5 open since Sep 5; PR #6 open since Sep 6; 2 more pull requests.',
    );
  });
  test('a lane draws a pull request linked to several of its tasks once, and packs its bars again', () => {
    const shared = pullRequest(98, { mergedAt: at('2026-11-10T12:00'), state: 'MERGED' });
    const older = task(20, { last: '2026-11-08T08:00', pullRequests: [shared] });
    const lane = lanesOf([older, merged, failing])[0];
    expect(lane?.tasks.map((item) => item.track.pullRequests.map((bar) => [bar.label, bar.row]))).toEqual([
      [['#98', 0]],
      [['#97', 0]],
      [['#98', 0]],
    ]);
    // Oldest start first; the most recently active task owns the shared bar.
    expect(lane?.track.pullRequests.map((bar) => [bar.label, bar.row, bar.threadId])).toEqual([
      ['#97', 0, idOf(failing)],
      ['#98', 1, idOf(merged)],
    ]);
    expect(lane?.track.pullRequestRows).toBe(2);
    expect(lane?.track.hiddenPullRequests).toBe(0);
  });
  test('each track has a text equivalent of what it draws', () => {
    const lanes = lanesOf(rows);
    expect(lanes[0]?.track.summary).toBe('No session started and no pull request in this window.');
    expect(lanes[0]?.track.active).toBe(false);
    expect(lanes[1]?.tasks.map((item) => item.track.summary)).toEqual([
      '4 sessions started, busiest Mon, Nov 9 (3). PR #98 merged Nov 10.',
      '2 sessions started, busiest Mon, Nov 9 (2). PR #97 open since Sep 20.',
    ]);
    expect(lanes[1]?.track.summary).toBe(
      '6 sessions started, busiest Mon, Nov 9 (5). PR #97 open since Sep 20; PR #98 merged Nov 10.',
    );
    expect(lanes[2]?.track.summary).toBe('1 session started, Sun, Nov 1.');
    expect(lanes.every((lane) => !WORK_TIME_WORDING.test(lane.track.summary))).toBe(true);
    const hours = timelineScale(['2026-11-09'], NOW, 'UTC');
    expect(onlyTrack(merged, hours).summary).toBe(
      '3 sessions started, busiest Mon, Nov 9, 09:00–10:00 (1). PR #98 merged Nov 10.',
    );
  });
});

describe('timeline task details at the 24 h zoom', () => {
  const day = timelineScale(['2026-11-11'], NOW, 'UTC');
  const spanning = task(31, { first: '2026-11-01T08:00', last: '2026-11-11T09:00' });
  const sameDay = task(32, { first: '2026-11-11T08:00', last: '2026-11-11T08:30', project: 'other/tools' });
  const before = task(33, { first: '2026-11-01T08:00', last: '2026-11-10T23:59' });
  const after = task(34, { first: '2026-11-12T00:00', last: '2026-11-12T08:00' });
  const around = task(35, { first: '2026-11-10T08:00', last: '2026-11-12T08:00' });
  // Their sessions started that day: older activity than the tasks above, yet read first.
  const startedEarly = task(36, {
    first: '2026-11-11T06:00',
    last: '2026-11-11T06:10',
    marks: [sessionMark('2026-11-11T06:00')],
  });
  const startedLate = task(37, {
    first: '2026-11-01T08:00',
    last: '2026-11-11T07:10',
    marks: [sessionMark('2026-11-11T07:00'), sessionMark('2026-11-10T07:00')],
    project: 'other/tools',
  });
  // A session started the day before does not make it a task with a session started that day.
  const startedBefore = task(38, {
    first: '2026-11-10T07:00',
    last: '2026-11-11T07:30',
    marks: [sessionMark('2026-11-10T07:00')],
  });
  const lanes = lanesOf([before, sameDay, after, spanning, around], 'project', day);
  const rankedRows = [before, sameDay, startedEarly, after, spanning, startedBefore, around, startedLate];
  const ranked = lanesOf(rankedRows, 'project', day);

  test('without a session started in the window, targets are the tasks whose activity range overlaps it, most recent first', () => {
    expect(timelineDetailTargets(lanes, day)).toEqual({
      threadIds: [idOf(around), idOf(spanning), idOf(sameDay)],
      skipped: 0,
    });
    expect(timelineDetailTargets(lanesOf([before, after], 'project', day), day)).toEqual({ threadIds: [], skipped: 0 });
  });
  test('tasks with a session started in the window are read first, then the others that overlap it', () => {
    expect(timelineDetailTargets(ranked, day)).toEqual({
      threadIds: [
        idOf(startedLate),
        idOf(startedEarly),
        idOf(around),
        idOf(spanning),
        idOf(sameDay),
        idOf(startedBefore),
      ],
      skipped: 0,
    });
    // The bound cuts the tasks that only may have a session that day before the ones known to have one.
    expect(timelineDetailTargets(ranked, day, 3)).toEqual({
      threadIds: [idOf(startedLate), idOf(startedEarly), idOf(around)],
      skipped: 3,
    });
    expect(timelineDetailTargets(ranked, day, 1)).toEqual({ threadIds: [idOf(startedLate)], skipped: 5 });
    // The same ranking whatever the lanes are.
    expect(timelineDetailTargets(lanesOf(rankedRows, 'attention', day), day)).toEqual(
      timelineDetailTargets(ranked, day),
    );
  });
  test('the read is bounded and says how many tasks it left out', () => {
    expect(timelineDetailTargets(lanes, day, 2)).toEqual({ threadIds: [idOf(around), idOf(spanning)], skipped: 1 });
    expect(timelineDetailTargets(lanes, day, 0)).toEqual({ threadIds: [], skipped: 3 });
    const many = Array.from({ length: TIMELINE_DETAIL_MAX + 5 }, (_, index) =>
      task(100 + index, { last: `2026-11-11T08:${String(index).padStart(2, '0')}` }),
    );
    const bounded = timelineDetailTargets(lanesOf(many, 'attention', day), day);
    expect(bounded.threadIds).toHaveLength(TIMELINE_DETAIL_MAX);
    expect(bounded.threadIds[0]).toBe(idOf(many.at(-1) ?? spanning));
    expect(bounded.skipped).toBe(5);
    expect(() => timelineDetailTargets(lanes, day, -1)).toThrow(RangeError);
  });
});

describe('timeline session spans at the 24 h zoom', () => {
  const day = timelineScale(['2026-11-11'], NOW, 'UTC');
  const episode = (key: string, overrides: Partial<WorkThreadEpisode>): WorkThreadEpisode => ({
    ...baseEpisode,
    children: [],
    endedAt: null,
    harness: 'claude',
    linkKey: `session:test-machine/claude/${key}`,
    running: false,
    sourceSessionId: key,
    title: key,
    ...overrides,
  });
  const spanned = (key: string, startedAt: string, endedAt: string, overrides: Partial<WorkThreadEpisode> = {}) =>
    episode(key, { startedAt: at(startedAt), endedAt: at(endedAt), ...overrides });
  const only = (item: WorkThreadEpisode) => {
    const bar = timelineSessionBars([item], day, NOW).bars[0];
    if (!bar) {
      throw new Error('Expected one session bar');
    }
    return bar;
  };

  test('a session spans its first to its last observed activity', () => {
    const bar = only(spanned('card', '2026-11-11T12:40', '2026-11-11T14:42', { title: 'Port product card' }));
    expect(bar).toEqual({
      children: [],
      description: 'Claude · Port product card · 12:40–14:42',
      end: 882 / 1440,
      endsAfter: false,
      harness: 'claude',
      key: 'session:test-machine/claude/card',
      point: false,
      row: 0,
      start: 760 / 1440,
      startsBefore: false,
      title: 'Port product card',
    });
    expect(
      only(spanned('untitled', '2026-11-11T08:00', '2026-11-11T09:00', { harness: 'codex', title: null })),
    ).toMatchObject({
      description: 'Codex · Untitled session · 08:00–09:00',
      harness: 'codex',
      title: 'Untitled session',
    });
  });
  test('a span is clamped to the window and says where it continues', () => {
    expect(only(spanned('overnight', '2026-11-10T22:00', '2026-11-11T01:00'))).toMatchObject({
      description: 'Claude · overnight · Nov 10 22:00–01:00 · started earlier',
      end: 60 / 1440,
      endsAfter: false,
      start: 0,
      startsBefore: true,
    });
    expect(only(spanned('late', '2026-11-11T23:00', '2026-11-12T01:00'))).toMatchObject({
      description: 'Claude · late · 23:00–Nov 12 01:00 · continues',
      end: 1,
      endsAfter: true,
      start: 1380 / 1440,
      startsBefore: false,
    });
    expect(only(spanned('through', '2026-11-09T08:00', '2026-11-13T08:00'))).toMatchObject({
      description: 'Claude · through · Nov 9 08:00–Nov 13 08:00 · started earlier · continues',
      end: 1,
      endsAfter: true,
      start: 0,
      startsBefore: true,
    });
  });
  test('without a recorded end a running session reaches now and any other is a start point', () => {
    expect(only(episode('running', { startedAt: at('2026-11-11T10:00'), running: true }))).toMatchObject({
      description: 'Claude · running · 10:00–now',
      end: 630 / 1440,
      point: false,
      start: 600 / 1440,
    });
    for (const running of [false, null]) {
      expect(only(episode('ended', { startedAt: at('2026-11-11T09:30'), running }))).toMatchObject({
        description: 'Claude · ended · 09:30 · end not recorded',
        end: 570 / 1440,
        endsAfter: false,
        point: true,
        start: 570 / 1440,
      });
    }
    // A recorded end wins over a running flag: the span is what was observed.
    expect(only(spanned('observed', '2026-11-11T08:00', '2026-11-11T09:00', { running: true }))).toMatchObject({
      description: 'Claude · observed · 08:00–09:00',
      end: 540 / 1440,
    });
    const yesterday = timelineScale(['2026-11-10'], NOW, 'UTC');
    expect(
      timelineSessionBars([episode('running', { startedAt: at('2026-11-10T22:00'), running: true })], yesterday, NOW)
        .bars[0],
    ).toMatchObject({ description: 'Claude · running · 22:00–now · continues', end: 1, endsAfter: true });
  });
  test('sessions outside the window are dropped, with their start points', () => {
    const { bars, rows } = timelineSessionBars(
      [
        spanned('yesterday', '2026-11-10T08:00', '2026-11-10T23:59'),
        spanned('tomorrow', '2026-11-12T00:00', '2026-11-12T08:00'),
        episode('old-point', { startedAt: at('2026-11-10T09:30') }),
      ],
      day,
      NOW,
    );
    expect(bars).toEqual([]);
    expect(rows).toBe(0);
    expect(timelineSessionBars([], day, NOW)).toEqual({ bars: [], rows: 0 });
  });
  test('delegated sessions overlapping the window come oldest first, at any depth', () => {
    const bar = only(
      spanned('parent', '2026-11-11T08:00', '2026-11-11T12:00', {
        children: [
          spanned('review', '2026-11-11T10:00', '2026-11-11T11:00', {
            harness: 'codex',
            children: [spanned('nested', '2026-11-11T10:10', '2026-11-11T10:20')],
          }),
          spanned('explore', '2026-11-11T08:30', '2026-11-11T09:00'),
          spanned('elsewhere', '2026-11-12T08:30', '2026-11-12T09:00'),
        ],
      }),
    );
    expect(bar.children.map((child) => [child.title, child.start, child.end])).toEqual([
      ['explore', 510 / 1440, 540 / 1440],
      ['review', 600 / 1440, 660 / 1440],
      ['nested', 610 / 1440, 620 / 1440],
    ]);
    expect(bar.children[1]?.description).toBe('Codex · review · 10:00–11:00');
    expect(bar.children.every((child) => !('children' in child))).toBe(true);
  });
  test('a session says in words how many delegated sessions its strip draws', () => {
    const delegating = (children: readonly WorkThreadEpisode[]) =>
      only(spanned('parent', '2026-11-11T08:00', '2026-11-11T12:00', { children })).description;
    expect(delegating([])).toBe('Claude · parent · 08:00–12:00');
    expect(delegating([spanned('explore', '2026-11-11T08:30', '2026-11-11T09:00')])).toBe(
      'Claude · parent · 08:00–12:00 · 1 delegated session',
    );
    expect(
      delegating([
        spanned('review', '2026-11-11T10:00', '2026-11-11T11:00', {
          children: [spanned('nested', '2026-11-11T10:10', '2026-11-11T10:20')],
        }),
        spanned('explore', '2026-11-11T08:30', '2026-11-11T09:00'),
        // Outside the day: not drawn, so not counted.
        spanned('elsewhere', '2026-11-12T08:30', '2026-11-12T09:00'),
      ]),
    ).toBe('Claude · parent · 08:00–12:00 · 3 delegated sessions');
  });
  test('a parent outside the window stays at the nearest edge for a delegated session inside it', () => {
    const earlier = only(
      spanned('parent', '2026-11-10T20:00', '2026-11-10T21:00', {
        children: [spanned('child', '2026-11-11T02:00', '2026-11-11T03:00')],
      }),
    );
    expect(earlier).toMatchObject({
      description: 'Claude · parent · Nov 10 20:00–Nov 10 21:00 · started earlier · 1 delegated session',
      end: 0,
      endsAfter: false,
      point: false,
      start: 0,
      startsBefore: true,
    });
    expect(earlier.children.map((child) => child.title)).toEqual(['child']);
    const later = only(
      spanned('parent', '2026-11-12T01:00', '2026-11-12T02:00', {
        children: [spanned('child', '2026-11-11T22:00', '2026-11-11T23:00')],
      }),
    );
    expect(later).toMatchObject({ end: 1, endsAfter: true, start: 1, startsBefore: false });
    // Both outside: the parent goes with its children.
    expect(
      timelineSessionBars(
        [
          spanned('parent', '2026-11-10T20:00', '2026-11-10T21:00', {
            children: [spanned('child', '2026-11-10T20:10', '2026-11-10T20:20')],
          }),
        ],
        day,
        NOW,
      ).bars,
    ).toEqual([]);
  });
  test('overlapping sessions take the next row, oldest first, and a row is reused after a gap', () => {
    const { bars, rows } = timelineSessionBars(
      [
        spanned('third', '2026-11-11T08:30', '2026-11-11T09:30'),
        episode('fourth', { startedAt: at('2026-11-11T09:30') }),
        spanned('second', '2026-11-11T08:00', '2026-11-11T09:00'),
        spanned('first', '2026-11-10T22:00', '2026-11-11T01:00'),
        spanned('fifth', '2026-11-11T09:50', '2026-11-11T10:00'),
        // Its delegated session outlasts it: the row stays reserved until that one ends.
        spanned('parent', '2026-11-11T12:00', '2026-11-11T13:00', {
          children: [spanned('child', '2026-11-11T12:30', '2026-11-11T15:00')],
        }),
        spanned('after-parent', '2026-11-11T14:00', '2026-11-11T14:30'),
      ],
      day,
      NOW,
    );
    expect(bars.map((bar) => [bar.title, bar.row])).toEqual([
      ['first', 0],
      ['second', 0],
      ['third', 1],
      ['fourth', 0],
      ['fifth', 0],
      ['parent', 0],
      ['after-parent', 1],
    ]);
    expect(rows).toBe(2);
  });
});

describe('timeline brush overview', () => {
  const rows = [
    task(41, {
      first: '2026-09-20T09:00',
      last: '2026-11-09T23:30',
      marks: [
        sessionMark('2026-09-20T09:00'),
        sessionMark('2026-11-09T09:00'),
        sessionMark('2026-11-09T23:30'),
        milestone(98, '2026-11-09T08:00', 'pull-request-opened'),
        { ...sessionMark('2026-11-09T09:30'), harness: null, kind: 'event', label: 'Marked as waiting' },
      ],
    }),
    task(42, { last: '2026-11-11T08:00', marks: [sessionMark('2026-11-11T08:00')], project: 'other/tools' }),
  ];
  const counted = (counts: readonly number[], domain: readonly string[]) =>
    counts.flatMap((count, index) => (count > 0 ? [[domain[index], count]] : []));

  test('counts the session starts of every task per domain day, and nothing else', () => {
    const counts = timelineOverview(rows, sixWeeks, 'UTC');
    expect(counts).toHaveLength(sixWeeks.length);
    // The September start is before the domain; milestones and follow-up changes are not session starts.
    expect(counted(counts, sixWeeks)).toEqual([
      ['2026-11-09', 2],
      ['2026-11-11', 1],
    ]);
  });
  test('a start belongs to the operator calendar day, as in the heat strip', () => {
    const paris = timelineDomain(NOW, 'Europe/Paris', []);
    const counts = timelineOverview(rows, paris, 'Europe/Paris');
    expect(counted(counts, paris)).toEqual([
      ['2026-11-09', 1],
      ['2026-11-10', 1],
      ['2026-11-11', 1],
    ]);
    const lanes = lanesOf(rows, 'project', timelineScale(paris, NOW, 'Europe/Paris'));
    expect(counts).toEqual(
      paris.map((_, index) => lanes.reduce((total, lane) => total + (lane.track.heat[index]?.count ?? 0), 0)),
    );
  });
  test('no task or no day is an empty count, not an error', () => {
    expect(timelineOverview([], sixWeeks, 'UTC')).toEqual(sixWeeks.map(() => 0));
    expect(timelineOverview(rows, [], 'UTC')).toEqual([]);
  });
});

describe('what the timeline says it loaded', () => {
  const data = { complete: true, counts: { done: 0, open: 63 }, loaded: { done: 0, open: 63 } };
  const unfiltered = { project: null, search: null };

  test('without a filter it counts loaded tasks against the totals of both tabs', () => {
    expect(timelineLoadedCopy(data, unfiltered)).toBe('63 of 63 followed tasks loaded · 0 of 0 ended follow-ups');
    expect(
      timelineLoadedCopy({ complete: true, counts: { done: 1, open: 1 }, loaded: { done: 1, open: 1 } }, unfiltered),
    ).toBe('1 of 1 followed task loaded · 1 of 1 ended follow-up');
  });
  test('with a filter the totals are unknown: it only counts what matched', () => {
    const filtered = { complete: true, counts: { done: 400, open: 63 }, loaded: { done: 2, open: 10 } };
    expect(timelineLoadedCopy(filtered, { project: 'acme/shop', search: null })).toBe('12 matching tasks loaded');
    expect(timelineLoadedCopy(filtered, { project: null, search: 'retry' })).toBe('12 matching tasks loaded');
    expect(
      timelineLoadedCopy({ ...filtered, loaded: { done: 0, open: 1 } }, { project: 'acme/shop', search: 'retry' }),
    ).toBe('1 matching task loaded');
  });
  test('an incomplete read says that more exists', () => {
    const partial = { complete: false, counts: { done: 2400, open: 63 }, loaded: { done: 1000, open: 63 } };
    expect(timelineLoadedCopy(partial, unfiltered)).toBe(
      '63 of 63 followed tasks loaded · 1000 of 2400 ended follow-ups · more exist than this view loads',
    );
    expect(timelineLoadedCopy(partial, { project: null, search: 'retry' })).toBe(
      '1063 matching tasks loaded · more exist than this view loads',
    );
  });
});
