import { parseWorkThreadLinkKey } from '@ai-usage/report-core/work-thread';
import type { WorkThreadSituation } from '@ai-usage/report-core/work-thread-situation';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadEpisode,
  type WorkThreadFactEventKind,
  type WorkThreadPullRequestMarker,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import {
  harnessName,
  type PullRequestTone,
  projectShortLabel,
  pullRequestBadge,
  pullRequestChecks,
  threadDate,
  threadDayKey,
  threadSituationCopy,
  threadTime,
} from './work-thread-model';
import type { WorkTimelineDataset } from './work-timeline-load';

export const TIMELINE_ZOOMS = [
  { id: '24h', label: '24 h', days: 1 },
  { id: '7d', label: '7 d', days: 7 },
  { id: '6w', label: '6 w', days: 42 },
] as const;
export type TimelineZoomId = (typeof TIMELINE_ZOOMS)[number]['id'];
export const TIMELINE_DEFAULT_DAYS = 42;
export type TimelineGrouping = 'project' | 'attention';
export type TimelineResolution = 'hour' | 'quarter-day' | 'day';

/** Inclusive calendar-day keys (`YYYY-MM-DD`) in the operator's time zone. */
export interface TimelineWindow {
  readonly from: string;
  readonly to: string;
}
/** Inclusive indexes into the domain's day keys. */
export interface TimelineWindowIndexes {
  readonly fromIndex: number;
  readonly toIndex: number;
}

export interface TimelineViewState {
  readonly grouping: TimelineGrouping;
  /** Lane keys the operator expanded; order irrelevant, no duplicates. */
  readonly open: readonly string[];
  /** Lane keys whose tasks without activity in the window are listed too. */
  readonly quiet: readonly string[];
  /** `null` is the default window: the last six weeks ending today. */
  readonly window: TimelineWindow | null;
}

const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1440;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, not only the shape: `2026-02-30` would otherwise shift to March. */
const isDayKey = (key: string): boolean => {
  if (!DAY_KEY.test(key)) {
    return false;
  }
  const noon = Date.parse(`${key}T12:00:00Z`);
  return Number.isFinite(noon) && new Date(noon).toISOString().slice(0, 10) === key;
};

/** UTC noon stands for the calendar day: no daylight-saving change moves it to another date. */
const dayKeyNoon = (key: string): number => {
  if (!isDayKey(key)) {
    throw new RangeError(`Invalid timeline day key: ${key}`);
  }
  return Date.parse(`${key}T12:00:00Z`);
};

const dayKeyDifference = (key: string, origin: string): number =>
  Math.round((dayKeyNoon(key) - dayKeyNoon(origin)) / DAY_MS);

/** `key` shifted by whole calendar days (UTC-noon arithmetic, DST-safe). */
export const shiftDayKey = (key: string, days: number): string => {
  if (!Number.isInteger(days)) {
    throw new RangeError(`A day key shifts by whole days, not ${days}.`);
  }
  return new Date(dayKeyNoon(key) + days * DAY_MS).toISOString().slice(0, 10);
};

const laneKeys = (search: URLSearchParams, name: string): readonly string[] => [
  ...new Set(search.getAll(name).filter(Boolean)),
];

/**
 * URL params: `group=attention`, repeated `open=<lane key>`, repeated `quiet=<lane key>`, `from` +
 * `to` (both valid `YYYY-MM-DD` and from <= to, otherwise the window is the default one).
 */
export const timelineViewState = (search: URLSearchParams): TimelineViewState => {
  const from = search.get('from');
  const to = search.get('to');
  return {
    grouping: search.get('group') === 'attention' ? 'attention' : 'project',
    open: laneKeys(search, 'open'),
    quiet: laneKeys(search, 'quiet'),
    window: from !== null && to !== null && isDayKey(from) && isDayKey(to) && from <= to ? { from, to } : null,
  };
};

const TIMELINE_VIEW_PARAMS = ['group', 'open', 'quiet', 'from', 'to'] as const;

/**
 * Returns a new URL. Default values are removed from the URL; every other param is untouched.
 * Changing `grouping` clears `open` and `quiet`: lane keys differ between groupings.
 */
export const timelineViewUrl = (current: URL, patch: Partial<TimelineViewState>): URL => {
  const before = timelineViewState(current.searchParams);
  const grouping = patch.grouping ?? before.grouping;
  const regrouped = grouping !== before.grouping;
  const open = regrouped ? [] : (patch.open ?? before.open);
  const quiet = regrouped ? [] : (patch.quiet ?? before.quiet);
  const window = patch.window === undefined ? before.window : patch.window;
  if (window !== null && !(isDayKey(window.from) && isDayKey(window.to) && window.from <= window.to)) {
    throw new RangeError(`Invalid timeline window: ${window.from} to ${window.to}`);
  }
  const url = new URL(current);
  for (const name of TIMELINE_VIEW_PARAMS) {
    url.searchParams.delete(name);
  }
  if (grouping === 'attention') {
    url.searchParams.set('group', grouping);
  }
  for (const key of new Set(open.filter(Boolean))) {
    url.searchParams.append('open', key);
  }
  for (const key of new Set(quiet.filter(Boolean))) {
    url.searchParams.append('quiet', key);
  }
  if (window !== null) {
    url.searchParams.set('from', window.from);
    url.searchParams.set('to', window.to);
  }
  return url;
};

interface LocalInstant {
  readonly dayKey: string;
  readonly hour: number;
  readonly minutes: number;
}

const localFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * The operator's calendar day and wall-clock minute of an instant. One formatter per time zone is
 * kept: every mark of every task is placed on each window change, and building a formatter per mark
 * is what would make that slow.
 */
const localInstant = (at: string, timeZone: string): LocalInstant => {
  let format = localFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    localFormats.set(timeZone, format);
  }
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError(`Invalid timeline instant: ${at}`);
  }
  const parts = format.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((value) => value.type === type)?.value ?? '';
  const hour = Number(part('hour'));
  return {
    dayKey: `${part('year')}-${part('month')}-${part('day')}`,
    hour,
    minutes: hour * 60 + Number(part('minute')),
  };
};

const requireDomain = (domain: readonly string[]): number => {
  if (domain.length === 0) {
    throw new RangeError('A timeline domain needs at least one day.');
  }
  return domain.length;
};

const domainDay = (domain: readonly string[], index: number): string => {
  const key = domain[index];
  if (key === undefined) {
    throw new RangeError(`Day ${index} is outside a timeline domain of ${domain.length} days.`);
  }
  return key;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const windowAt = (domain: readonly string[], fromIndex: number, toIndex: number): TimelineWindow => ({
  from: domainDay(domain, fromIndex),
  to: domainDay(domain, toIndex),
});

/**
 * Day keys oldest first, today last: from the earliest of `firstActivities` to today, at least
 * TIMELINE_DEFAULT_DAYS, at most WORK_THREAD_VIEW_BOUNDS.maxTimelineDays.
 */
export const timelineDomain = (
  now: string,
  timeZone: string,
  firstActivities: readonly string[],
): readonly string[] => {
  const today = threadDayKey(now, timeZone);
  const earliest = firstActivities.reduce((first, at) => {
    const key = localInstant(at, timeZone).dayKey;
    return key < first ? key : first;
  }, today);
  const length = clamp(
    dayKeyDifference(today, earliest) + 1,
    TIMELINE_DEFAULT_DAYS,
    WORK_THREAD_VIEW_BOUNDS.maxTimelineDays,
  );
  return Array.from({ length }, (_, index) => shiftDayKey(today, index - (length - 1)));
};

/** Clamps into the domain; `null` or a window entirely outside gives the last TIMELINE_DEFAULT_DAYS. */
export const resolveTimelineWindow = (
  domain: readonly string[],
  requested: TimelineWindow | null,
): TimelineWindowIndexes => {
  const last = requireDomain(domain) - 1;
  const fallback = { fromIndex: Math.max(0, last - (TIMELINE_DEFAULT_DAYS - 1)), toIndex: last };
  if (requested === null) {
    return fallback;
  }
  const origin = domainDay(domain, 0);
  const fromIndex = dayKeyDifference(requested.from, origin);
  const toIndex = dayKeyDifference(requested.to, origin);
  if (fromIndex > toIndex) {
    throw new RangeError(`Invalid timeline window: ${requested.from} to ${requested.to}`);
  }
  return toIndex < 0 || fromIndex > last
    ? fallback
    : { fromIndex: Math.max(0, fromIndex), toIndex: Math.min(last, toIndex) };
};

const windowSpan = (window: TimelineWindowIndexes, length: number): number =>
  clamp(window.toIndex - window.fromIndex + 1, 1, length);

/** A preset keeps the window's END and spans `days`; at the domain start it keeps `days` by moving the end. */
export const timelineZoomWindow = (
  domain: readonly string[],
  current: TimelineWindowIndexes,
  days: number,
): TimelineWindow => {
  const length = requireDomain(domain);
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`A timeline window spans at least one whole day, not ${days}.`);
  }
  const span = Math.min(days, length);
  const fromIndex = Math.max(0, clamp(current.toIndex, 0, length - 1) - span + 1);
  return windowAt(domain, fromIndex, fromIndex + span - 1);
};

/** Same span, moved by `direction` spans (-1 earlier, +1 later), clamped into the domain. */
export const timelineShiftWindow = (
  domain: readonly string[],
  current: TimelineWindowIndexes,
  direction: -1 | 1,
): TimelineWindow => {
  const length = requireDomain(domain);
  const span = windowSpan(current, length);
  const fromIndex = clamp(current.fromIndex + direction * span, 0, length - span);
  return windowAt(domain, fromIndex, fromIndex + span - 1);
};

/** Same span ending today (the last domain day). */
export const timelineTodayWindow = (domain: readonly string[], current: TimelineWindowIndexes): TimelineWindow => {
  const length = requireDomain(domain);
  return windowAt(domain, length - windowSpan(current, length), length - 1);
};

export const activeTimelineZoom = (spanDays: number): TimelineZoomId | null =>
  TIMELINE_ZOOMS.find((zoom) => zoom.days === spanDays)?.id ?? null;

/** Beyond two weeks a quarter-day column is too thin to read or to point at. */
const TIMELINE_QUARTER_DAY_MAX_DAYS = 14;

/** 1 day → 'hour'; 2 to 14 days → 'quarter-day'; more → 'day'. */
export const timelineResolution = (spanDays: number): TimelineResolution => {
  if (!Number.isInteger(spanDays) || spanDays < 1) {
    throw new RangeError(`A timeline window spans at least one whole day, not ${spanDays}.`);
  }
  if (spanDays === 1) {
    return 'hour';
  }
  return spanDays <= TIMELINE_QUARTER_DAY_MAX_DAYS ? 'quarter-day' : 'day';
};

/** The brush works on day BOUNDARIES 0..domain.length: window [fromIndex, toIndex] ⇄ [fromIndex, toIndex + 1]. */
export const brushIndexesOfWindow = (window: TimelineWindowIndexes): readonly [number, number] => [
  window.fromIndex,
  window.toIndex + 1,
];

/** A collapsed or out-of-range selection becomes one valid day. */
export const windowOfBrushIndexes = (domain: readonly string[], indexes: readonly [number, number]): TimelineWindow => {
  const length = requireDomain(domain);
  if (!indexes.every(Number.isFinite)) {
    throw new RangeError(`Invalid timeline brush selection: ${indexes.join(' to ')}`);
  }
  const fromIndex = clamp(Math.round(Math.min(...indexes)), 0, length - 1);
  const endBoundary = clamp(Math.round(Math.max(...indexes)), fromIndex + 1, length);
  return windowAt(domain, fromIndex, endBoundary - 1);
};

export interface TimelineColumn {
  readonly dayKey: string;
  /** 'YYYY-MM-DD' (day) | 'YYYY-MM-DD#0..3' (quarter-day, 6-hour blocks) | 'YYYY-MM-DD#0..23' (hour). */
  readonly key: string;
  /** Accessible name: "Mon, Nov 9" | "Mon, Nov 9, 06:00–12:00" | "Mon, Nov 9, 14:00–15:00". */
  readonly label: string;
  /** Stronger gridline: Monday (day), first block of a day (quarter-day), every 6 hours (hour). */
  readonly major: boolean;
  /**
   * Short scale label or null: day-of-month on Mondays (day; none when > 62 columns except month
   * starts), "Mon 9" on each day's first block (quarter-day), "06" every 3 hours (hour).
   */
  readonly tick: string | null;
  readonly today: boolean;
}
export interface TimelineScale {
  readonly columns: readonly TimelineColumn[];
  /** The window's day keys, oldest first. */
  readonly days: readonly string[];
  /**
   * Pinned group labels over column spans (1-based `start`): months ("Oct 2026") for day and
   * quarter-day, the single day ("Mon, Nov 9, 2026") for hour.
   */
  readonly groups: readonly { readonly label: string; readonly start: number; readonly span: number }[];
  /** Fraction 0..1 of the track where "now" falls; null when outside the window. */
  readonly now: number | null;
  readonly resolution: TimelineResolution;
  readonly timeZone: string;
}

/** Past two months of day columns, weekly ticks collide: only month starts keep one. */
const TIMELINE_WEEKLY_TICK_MAX_COLUMNS = 62;
const HOURS_PER_BLOCK = { hour: 1, 'quarter-day': 6 } as const;

const utcDayCopy = (date: Date, options: Intl.DateTimeFormatOptions): string =>
  date.toLocaleDateString('en-US', { timeZone: 'UTC', ...options });
const clockHour = (hour: number): string => String(hour).padStart(2, '0');

const dayColumns = (
  dayKey: string,
  resolution: TimelineResolution,
  dense: boolean,
  today: string,
): TimelineColumn[] => {
  const date = new Date(dayKeyNoon(dayKey));
  const label = utcDayCopy(date, { weekday: 'short', month: 'short', day: 'numeric' });
  const dayOfMonth = date.getUTCDate();
  const isToday = dayKey === today;
  if (resolution === 'day') {
    const monday = date.getUTCDay() === 1;
    const ticked = dense ? dayOfMonth === 1 : monday;
    return [{ key: dayKey, dayKey, label, tick: ticked ? String(dayOfMonth) : null, major: monday, today: isToday }];
  }
  const hours = HOURS_PER_BLOCK[resolution];
  const dayTick = `${utcDayCopy(date, { weekday: 'short' })} ${dayOfMonth}`;
  return Array.from({ length: 24 / hours }, (_, block): TimelineColumn => {
    const start = block * hours;
    // Hours are ticked every three and weighted every six; six-hour blocks name and weight each day's first.
    const every = (step: number): boolean => start % (resolution === 'hour' ? step : 24) === 0;
    const tick = resolution === 'hour' ? clockHour(start) : dayTick;
    return {
      key: `${dayKey}#${block}`,
      dayKey,
      label: `${label}, ${clockHour(start)}:00–${clockHour(start + hours)}:00`,
      tick: every(3) ? tick : null,
      major: every(6),
      today: isToday,
    };
  });
};

const scaleGroups = (columns: readonly TimelineColumn[], resolution: TimelineResolution): TimelineScale['groups'] => {
  const groups: { label: string; start: number; span: number }[] = [];
  for (const [index, column] of columns.entries()) {
    const label = utcDayCopy(
      new Date(dayKeyNoon(column.dayKey)),
      resolution === 'hour'
        ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
        : { month: 'short', year: 'numeric' },
    );
    const group = groups.at(-1);
    if (group?.label === label) {
      group.span += 1;
    } else {
      groups.push({ label, start: index + 1, span: 1 });
    }
  }
  return groups;
};

/** Wall-clock placement: a day is one equal share of the track whatever its real length (DST). */
const trackPosition = (days: readonly string[], timeZone: string, at: string): number => {
  const local = localInstant(at, timeZone);
  return (dayKeyDifference(local.dayKey, domainDay(days, 0)) + local.minutes / MINUTES_PER_DAY) / days.length;
};

export const timelineScale = (days: readonly string[], now: string, timeZone: string): TimelineScale => {
  if (days.length === 0) {
    throw new RangeError('A timeline scale needs at least one day.');
  }
  for (const [index, day] of days.entries()) {
    if (day !== shiftDayKey(domainDay(days, 0), index)) {
      throw new RangeError(`Timeline scale days must be consecutive calendar days; got ${day} at ${index}.`);
    }
  }
  const resolution = timelineResolution(days.length);
  const today = threadDayKey(now, timeZone);
  const dense = days.length > TIMELINE_WEEKLY_TICK_MAX_COLUMNS;
  const columns = days.flatMap((day) => dayColumns(day, resolution, dense, today));
  const position = trackPosition(days, timeZone, now);
  return {
    columns,
    days,
    groups: scaleGroups(columns, resolution),
    now: position >= 0 && position < 1 ? position : null,
    resolution,
    timeZone,
  };
};

/**
 * Fraction of the track: (index of the instant's local day in the window + local minutes / 1440) / days.
 * Unclamped: < 0 before the window, > 1 after.
 */
export const timelinePosition = (scale: TimelineScale, at: string): number =>
  trackPosition(scale.days, scale.timeZone, at);

/** The column key the instant falls in (may name a column outside the window). */
export const timelineColumnKey = (scale: TimelineScale, at: string): string => {
  const local = localInstant(at, scale.timeZone);
  return scale.resolution === 'day'
    ? local.dayKey
    : `${local.dayKey}#${Math.floor(local.hour / HOURS_PER_BLOCK[scale.resolution])}`;
};

/** Upper-inclusive lower bounds of heat levels 1..4: 1, 2–4, 5–9, 10+. */
export const TIMELINE_HEAT_STEPS = [1, 2, 5, 10] as const;
export const TIMELINE_HEAT_LEGEND = ['1', '2–4', '5–9', '10+'] as const;
export const timelineHeatLevel = (count: number): 0 | 1 | 2 | 3 | 4 => {
  const [one, two, three, four] = TIMELINE_HEAT_STEPS;
  if (count >= four) {
    return 4;
  }
  if (count >= three) {
    return 3;
  }
  if (count >= two) {
    return 2;
  }
  return count >= one ? 1 : 0;
};
export const TIMELINE_MAX_PR_ROWS = 4;

export interface TimelineHeatCell {
  readonly count: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}
export interface TimelineMilestone {
  /** Fraction 0..1 inside the window. */
  readonly at: number;
  readonly kind: WorkThreadFactEventKind;
  readonly label: string;
}
export interface TimelinePullRequestBar {
  readonly checks: 'passing' | 'failing' | 'pending' | 'unknown' | null;
  /** "PR #98 · Merged · opened Nov 9 · merged Nov 10" (dates via threadDate with `now`). */
  readonly description: string;
  /** Clamped 0..1, end >= start. */
  readonly end: number;
  /** Its true end is after the window. */
  readonly endsAfter: boolean;
  readonly key: string;
  /** "#98" */
  readonly label: string;
  /** Milestones inside the window, oldest first (from the row's fact marks of this source). */
  readonly milestones: readonly TimelineMilestone[];
  /**
   * Read open by the latest attempt: the bar ends at "now". When that attempt failed, a pull
   * request last read open ends at that earlier read and is not `open`.
   */
  readonly open: boolean;
  /** Packed row, 0-based: bars of one track never overlap within a row. */
  readonly row: number;
  readonly start: number;
  /** Opened before the window. */
  readonly startsBefore: boolean;
  readonly threadId: string;
  readonly title: string | null;
  readonly tone: PullRequestTone;
}
export interface TimelineTrack {
  /** At least one session start or pull request bar in the window. */
  readonly active: boolean;
  /**
   * A row behind this track carries as many marks as the list read allows: older session starts may
   * be missing from the counts.
   */
  readonly capped: boolean;
  /** One cell per scale column. */
  readonly heat: readonly TimelineHeatCell[];
  /** Bars beyond TIMELINE_MAX_PR_ROWS rows, not drawn. */
  readonly hiddenPullRequests: number;
  readonly pullRequestRows: number;
  /** Bars overlapping the window, rows < TIMELINE_MAX_PR_ROWS, oldest start first. */
  readonly pullRequests: readonly TimelinePullRequestBar[];
  /** Session starts inside the window. */
  readonly sessions: number;
  /**
   * Text equivalent of the track, e.g. "12 sessions started, busiest Mon, Nov 9 (5). PR #98 merged
   * Nov 10; PR #97 open since Nov 8." or "No session started and no pull request in this window."
   * A capped track ends with TIMELINE_CAPPED_COPY.
   */
  readonly summary: string;
  /** Linked pull requests with no usable date: counted, never drawn. */
  readonly undatedPullRequests: number;
}
export type TimelineHint = WorkThreadSituation['hint'];
export interface TimelineTask {
  readonly hint: TimelineHint;
  /** "To resume", "To decide", … (threadSituationCopy(...).label) */
  readonly hintLabel: string;
  /** projectShortLabel(row.thread.projectLabel) */
  readonly project: string;
  readonly row: WorkThreadRow;
  readonly track: TimelineTrack;
}
export interface TimelineLane {
  readonly activeTasks: number;
  /** Project grouping: the full project label, or 'No project'. Attention grouping: the hint. */
  readonly key: string;
  readonly label: string;
  readonly lastActivityAt: string;
  /**
   * Project grouping: "30 to resume · 8 to decide" (hint counts in attention order, lower-cased
   * labels). Attention grouping: "4 projects" / "1 project".
   */
  readonly status: string;
  /** Latest activity first. */
  readonly tasks: readonly TimelineTask[];
  /** Union of its tasks: heat summed per column, pull requests deduplicated by key and re-packed. */
  readonly track: TimelineTrack;
}

/** Share of the track kept clear after a bar, so two bars of one row never read as one. */
const TIMELINE_BAR_GAP = 0.012;
/** A lane can hold dozens of pull requests; its text equivalent names the first ones and counts the rest. */
const TIMELINE_SUMMARY_MAX_PULL_REQUESTS = 6;
/** Said wherever a capped track is shown: its counts are a lower bound, not the task's history. */
export const TIMELINE_CAPPED_COPY = 'Older sessions are beyond what the list read carries and are not counted.';

/** Greedy first-fit over items sorted by start: the first row whose last item ends a gap earlier. */
const packRows = <Item>(
  items: readonly Item[],
  extent: (item: Item) => readonly [number, number],
): { readonly rows: readonly number[]; readonly count: number } => {
  const ends: number[] = [];
  const rows = items.map((item) => {
    const [start, end] = extent(item);
    const free = ends.findIndex((rowEnd) => rowEnd + TIMELINE_BAR_GAP <= start);
    const row = free === -1 ? ends.length : free;
    ends[row] = end;
    return row;
  });
  return { rows, count: ends.length };
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** A bar before it is packed, with what only the track's text equivalent and ordering need. */
interface PullRequestDraft extends Omit<TimelinePullRequestBar, 'row'> {
  /** "PR #98 merged Nov 10" */
  readonly phrase: string;
  readonly startedAt: number;
}
interface TrackParts {
  readonly bars: readonly PullRequestDraft[];
  /** A row reached the mark bound of the list read. */
  readonly capped: boolean;
  /** Session starts per scale column. */
  readonly counts: readonly number[];
  /** Keys of linked pull requests no date places. */
  readonly undated: readonly string[];
}

const pullRequestDraft = (
  row: WorkThreadRow,
  marker: WorkThreadPullRequestMarker,
  scale: TimelineScale,
  now: string,
): PullRequestDraft | 'undated' | 'outside' => {
  const current = marker.latest?.outcome === 'observed';
  const observation = current ? marker.latest : marker.latestSuccessful;
  const facts = row.marks
    .flatMap((mark) =>
      mark.fact !== null && mark.source?.key === marker.key
        ? [{ at: mark.at, kind: mark.fact, label: mark.label }]
        : [],
    )
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const firstFact = facts[0];
  const lastFact = facts.at(-1);
  const startAt = observation?.createdAt ?? firstFact?.at ?? null;
  if (startAt === null) {
    return 'undated';
  }
  const date = (at: string): string => threadDate(at, scale.timeZone, false, now);
  const linked = parseWorkThreadLinkKey('pull-request', marker.key);
  const number = observation?.number ?? (linked?.kind === 'pull-request' ? linked.number : null);
  const name = number === null ? 'Pull request' : `PR #${number}`;
  const opened = Boolean(observation?.createdAt) || firstFact?.kind === 'pull-request-opened';
  const lastKnownAt = lastFact?.at ?? observation?.updatedAt ?? null;
  const lastKnownCopy = lastFact ? 'last milestone' : 'last updated';
  let endAt: string | null = lastKnownAt;
  let ending: string | null = lastKnownAt === null ? null : `${lastKnownCopy} ${date(lastKnownAt)}`;
  let phrase = `${name} state unknown`;
  if (observation?.state === 'MERGED') {
    endAt = observation.mergedAt ?? lastKnownAt;
    ending = observation.mergedAt === null ? ending : `merged ${date(observation.mergedAt)}`;
    phrase = `${name} merged${observation.mergedAt === null ? '' : ` ${date(observation.mergedAt)}`}`;
  } else if (observation?.state === 'CLOSED') {
    const closedAt = observation.closedAt ?? null;
    endAt = closedAt ?? observation.updatedAt ?? lastKnownAt;
    ending = closedAt === null ? ending : `closed ${date(closedAt)}`;
    phrase = `${name} closed${closedAt === null ? '' : ` ${date(closedAt)}`}`;
  } else if (observation?.state === 'OPEN' && current) {
    endAt = now;
    ending = 'still open';
    phrase = `${name} open${opened ? ` since ${date(startAt)}` : ''}`;
  } else if (observation?.state === 'OPEN') {
    // The latest read failed: the bar stops where the pull request was last read open, never at a
    // "now" that nobody observed.
    endAt = observation.observedAt;
    ending = `last read open ${date(observation.observedAt)}`;
    phrase = `${name} ${ending}`;
  }
  const rawStart = timelinePosition(scale, startAt);
  // A pull request known only by its opening is drawn where it opened, never stretched to a guess.
  const rawEnd = Math.max(rawStart, endAt === null ? rawStart : timelinePosition(scale, endAt));
  if (rawEnd < 0 || rawStart >= 1) {
    return 'outside';
  }
  const badge = pullRequestBadge(marker);
  const checks = pullRequestChecks(marker);
  return {
    checks: checks?.tone ?? null,
    description: [
      name,
      badge.label,
      `${opened ? 'opened' : 'first milestone'} ${date(startAt)}`,
      ending,
      checks?.label ?? null,
    ]
      .filter((part) => part !== null)
      .join(' · '),
    end: clamp(rawEnd, 0, 1),
    endsAfter: rawEnd >= 1,
    key: marker.key,
    label: number === null ? 'PR' : `#${number}`,
    milestones: facts.flatMap((fact): TimelineMilestone[] => {
      const at = timelinePosition(scale, fact.at);
      return at >= 0 && at < 1 ? [{ at, kind: fact.kind, label: fact.label ?? 'Pull request milestone' }] : [];
    }),
    open: observation?.state === 'OPEN' && current,
    phrase,
    start: clamp(rawStart, 0, 1),
    startedAt: Date.parse(startAt),
    startsBefore: rawStart < 0,
    threadId: row.thread.threadId,
    title: observation?.title ?? null,
    tone: badge.tone,
  };
};

const taskTrackParts = (
  row: WorkThreadRow,
  scale: TimelineScale,
  columnIndexes: ReadonlyMap<string, number>,
  now: string,
): TrackParts => {
  const counts = scale.columns.map(() => 0);
  for (const mark of row.marks) {
    const index = mark.kind === 'session' ? columnIndexes.get(timelineColumnKey(scale, mark.at)) : undefined;
    if (index !== undefined) {
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }
  const bars: PullRequestDraft[] = [];
  const undated: string[] = [];
  for (const marker of row.markers.pullRequests) {
    const draft = pullRequestDraft(row, marker, scale, now);
    if (draft === 'undated') {
      undated.push(marker.key);
    } else if (draft !== 'outside') {
      bars.push(draft);
    }
  }
  return { bars, capped: row.marks.length >= WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow, counts, undated };
};

/** One pull request linked to several tasks of a lane is one bar: the most recently active task owns it. */
const mergeTrackParts = (parts: readonly TrackParts[], columns: number): TrackParts => {
  const bars = new Map<string, PullRequestDraft>();
  for (const bar of parts.flatMap((part) => part.bars)) {
    if (!bars.has(bar.key)) {
      bars.set(bar.key, bar);
    }
  }
  return {
    bars: [...bars.values()],
    capped: parts.some((part) => part.capped),
    counts: Array.from({ length: columns }, (_, index) =>
      parts.reduce((total, part) => total + (part.counts[index] ?? 0), 0),
    ),
    undated: [...new Set(parts.flatMap((part) => part.undated))].filter((key) => !bars.has(key)),
  };
};

const trackSummary = (
  scale: TimelineScale,
  parts: TrackParts,
  sessions: number,
  bars: readonly PullRequestDraft[],
): string => {
  const sentences: string[] = [];
  if (sessions === 0 && bars.length === 0) {
    sentences.push('No session started and no pull request in this window.');
  } else if (sessions === 0) {
    sentences.push('No session started.');
  } else {
    const peak = Math.max(...parts.counts);
    const busiest = scale.columns[parts.counts.indexOf(peak)]?.label ?? '';
    sentences.push(
      sessions === 1 ? `1 session started, ${busiest}.` : `${sessions} sessions started, busiest ${busiest} (${peak}).`,
    );
  }
  if (bars.length > 0) {
    const named = bars.slice(0, TIMELINE_SUMMARY_MAX_PULL_REQUESTS).map((bar) => bar.phrase);
    const rest = bars.length - named.length;
    sentences.push(
      `${[...named, ...(rest > 0 ? [plural(rest, 'more pull request', 'more pull requests')] : [])].join('; ')}.`,
    );
  }
  if (parts.undated.length > 0) {
    sentences.push(
      `${plural(parts.undated.length, 'linked pull request has', 'linked pull requests have')} no usable date.`,
    );
  }
  if (parts.capped) {
    sentences.push(TIMELINE_CAPPED_COPY);
  }
  return sentences.join(' ');
};

const composeTrack = (scale: TimelineScale, parts: TrackParts): TimelineTrack => {
  const sorted = [...parts.bars].sort(
    (left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key),
  );
  const packed = packRows(sorted, (bar) => [bar.start, bar.end]);
  const pullRequests = sorted.flatMap(({ phrase: _phrase, startedAt: _startedAt, ...bar }, index) => {
    const row = packed.rows[index] ?? 0;
    return row < TIMELINE_MAX_PR_ROWS ? [{ ...bar, row }] : [];
  });
  const sessions = parts.counts.reduce((total, count) => total + count, 0);
  return {
    active: sessions > 0 || sorted.length > 0,
    capped: parts.capped,
    heat: parts.counts.map((count) => ({ count, level: timelineHeatLevel(count) })),
    hiddenPullRequests: sorted.length - pullRequests.length,
    pullRequestRows: Math.min(packed.count, TIMELINE_MAX_PR_ROWS),
    pullRequests,
    sessions,
    summary: trackSummary(scale, parts, sessions, sorted),
    undatedPullRequests: parts.undated.length,
  };
};

/** Whose move it is first, as the task list orders its attention groups. A record, so no hint can be left out. */
const TIMELINE_HINT_RANK: Record<TimelineHint, number> = {
  'to-resume': 0,
  'in-progress': 1,
  undecided: 2,
  waiting: 3,
  'ready-to-close': 4,
  done: 5,
};

interface TaskDraft {
  readonly parts: TrackParts;
  readonly task: TimelineTask;
}

const groupBy = <Item, Key>(items: readonly Item[], keyOf: (item: Item) => Key): Map<Key, Item[]> => {
  const groups = new Map<Key, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
};

const projectKey = (row: WorkThreadRow): string => row.thread.projectLabel ?? 'No project';
const latestFirst = (left: { readonly lastActivityAt: string }, right: { readonly lastActivityAt: string }): number =>
  Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);

type LaneCopy = (tasks: readonly TimelineTask[], latest: TimelineTask) => Pick<TimelineLane, 'label' | 'status'>;

const projectLaneCopy: LaneCopy = (tasks, latest) => ({
  label: latest.project,
  status: [...groupBy(tasks, (task) => task.hint)]
    .sort(([left], [right]) => TIMELINE_HINT_RANK[left] - TIMELINE_HINT_RANK[right])
    .flatMap(([, group]) => (group[0] ? [`${group.length} ${group[0].hintLabel.toLowerCase()}`] : []))
    .join(' · '),
});
const attentionLaneCopy: LaneCopy = (tasks, latest) => ({
  label: latest.hintLabel,
  status: plural(new Set(tasks.map((task) => projectKey(task.row))).size, 'project', 'projects'),
});

const composeLane = (scale: TimelineScale, key: string, drafts: readonly TaskDraft[], copy: LaneCopy): TimelineLane => {
  const ordered = [...drafts].sort(
    (left, right) =>
      latestFirst(left.task.row, right.task.row) ||
      left.task.row.thread.threadId.localeCompare(right.task.row.thread.threadId),
  );
  const tasks = ordered.map((draft) => draft.task);
  const latest = tasks[0];
  if (latest === undefined) {
    throw new RangeError(`Timeline lane ${key} has no task.`);
  }
  return {
    ...copy(tasks, latest),
    activeTasks: tasks.filter((task) => task.track.active).length,
    key,
    lastActivityAt: latest.row.lastActivityAt,
    tasks,
    track: composeTrack(
      scale,
      mergeTrackParts(
        ordered.map((draft) => draft.parts),
        scale.columns.length,
      ),
    ),
  };
};

/**
 * Project grouping: lanes by most recent activity first; two projects that share a short label are
 * labelled by their full one. Attention grouping: to-resume, in-progress, undecided, waiting,
 * ready-to-close, done (empty groups omitted).
 */
export const timelineLanes = (input: {
  readonly grouping: TimelineGrouping;
  readonly now: string;
  readonly rows: readonly WorkThreadRow[];
  readonly scale: TimelineScale;
  /** The source statuses of the read a task came from: its hint is qualified by them alone. */
  readonly sourcesOf: (threadId: string) => readonly WorkThreadSourceStatus[];
}): readonly TimelineLane[] => {
  const { grouping, now, rows, scale, sourcesOf } = input;
  const columnIndexes = new Map(scale.columns.map((column, index) => [column.key, index]));
  const drafts = rows.map((row): TaskDraft => {
    const situation = threadSituationCopy(row, now, sourcesOf(row.thread.threadId), scale.timeZone);
    const parts = taskTrackParts(row, scale, columnIndexes, now);
    return {
      parts,
      task: {
        hint: situation.hint,
        hintLabel: situation.label,
        project: projectShortLabel(row.thread.projectLabel),
        row,
        track: composeTrack(scale, parts),
      },
    };
  });
  if (grouping === 'attention') {
    return [...groupBy(drafts, (draft) => draft.task.hint)]
      .sort(([left], [right]) => TIMELINE_HINT_RANK[left] - TIMELINE_HINT_RANK[right])
      .map(([hint, group]) => composeLane(scale, hint, group, attentionLaneCopy));
  }
  const lanes = [...groupBy(drafts, (draft) => projectKey(draft.task.row))]
    .map(([key, group]) => composeLane(scale, key, group, projectLaneCopy))
    .sort((left, right) => latestFirst(left, right) || left.key.localeCompare(right.key));
  // Two repositories can share their last path segment: named by it alone they would read as one project.
  const sameLabel = groupBy(lanes, (lane) => lane.label);
  return lanes.map((lane) => ((sameLabel.get(lane.label)?.length ?? 0) > 1 ? { ...lane, label: lane.key } : lane));
};

/**
 * Session starts per domain day over every task, for the brush. It depends on the read and the
 * domain only, never on the window: a brush move does not recount.
 */
export const timelineOverview = (
  rows: readonly WorkThreadRow[],
  domain: readonly string[],
  timeZone: string,
): readonly number[] => {
  const indexes = new Map(domain.map((key, index) => [key, index]));
  const counts = domain.map(() => 0);
  for (const row of rows) {
    for (const mark of row.marks) {
      const index = mark.kind === 'session' ? indexes.get(localInstant(mark.at, timeZone).dayKey) : undefined;
      if (index !== undefined) {
        counts[index] = (counts[index] ?? 0) + 1;
      }
    }
  }
  return counts;
};

/** 24 h zoom: at most this many task details are read for their session spans. */
export const TIMELINE_DETAIL_MAX = 12;

/**
 * The tasks whose session spans are worth reading for the window: first those with a session
 * started in it, then the others whose [firstActivityAt, lastActivityAt] overlaps it (a session
 * started earlier may continue into it). Most recent activity first within each group, so the bound
 * cuts the least likely candidates.
 */
export const timelineDetailTargets = (
  lanes: readonly TimelineLane[],
  scale: TimelineScale,
  max: number = TIMELINE_DETAIL_MAX,
): { readonly threadIds: readonly string[]; readonly skipped: number } => {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError(`The number of task details to read must be a whole number, not ${max}.`);
  }
  const candidates = new Map<string, { readonly row: WorkThreadRow; readonly started: boolean }>();
  for (const task of lanes.flatMap((lane) => lane.tasks)) {
    const started = task.track.sessions > 0;
    if (
      started ||
      (timelinePosition(scale, task.row.firstActivityAt) < 1 && timelinePosition(scale, task.row.lastActivityAt) >= 0)
    ) {
      candidates.set(task.row.thread.threadId, { row: task.row, started });
    }
  }
  const threadIds = [...candidates.values()]
    .sort(
      (left, right) =>
        Number(right.started) - Number(left.started) ||
        latestFirst(left.row, right.row) ||
        left.row.thread.threadId.localeCompare(right.row.thread.threadId),
    )
    .map((candidate) => candidate.row.thread.threadId);
  return { threadIds: threadIds.slice(0, max), skipped: Math.max(0, threadIds.length - max) };
};

export interface TimelineSessionSpan {
  /**
   * "Claude · Port product card · 12:40–14:42" (+ " · started earlier" / " · continues" /
   * " · end not recorded").
   */
  readonly description: string;
  readonly end: number;
  readonly endsAfter: boolean;
  readonly harness: string;
  readonly key: string;
  /** End not recorded and not known running: drawn as a start tick, `end === start`. */
  readonly point: boolean;
  readonly start: number;
  readonly startsBefore: boolean;
  readonly title: string;
}
export interface TimelineSessionBar extends TimelineSessionSpan {
  /** Delegated sessions overlapping the window, oldest first; the description ends with their count. */
  readonly children: readonly TimelineSessionSpan[];
  /** Packed row, 0-based. */
  readonly row: number;
}

interface SessionDraft {
  readonly overlaps: boolean;
  readonly span: TimelineSessionSpan;
  readonly startedAt: number;
}

const sessionDraft = (episode: WorkThreadEpisode, scale: TimelineScale, now: string): SessionDraft => {
  const running = episode.endedAt === null && episode.running === true;
  const point = episode.endedAt === null && !running;
  const rawStart = timelinePosition(scale, episode.startedAt);
  const rawEnd = Math.max(rawStart, timelinePosition(scale, episode.endedAt ?? (running ? now : episode.startedAt)));
  // A time alone names the shown day: an instant of another day carries its date.
  const clock = (at: string, position: number): string =>
    position < 0 || position >= 1
      ? `${threadDate(at, scale.timeZone, false, now)} ${threadTime(at, scale.timeZone)}`
      : threadTime(at, scale.timeZone);
  let range = clock(episode.startedAt, rawStart);
  if (episode.endedAt !== null) {
    range += `–${clock(episode.endedAt, rawEnd)}`;
  } else if (running) {
    range += '–now';
  }
  const title = episode.title ?? 'Untitled session';
  const startsBefore = rawStart < 0;
  const endsAfter = rawEnd >= 1;
  return {
    overlaps: rawEnd >= 0 && rawStart < 1,
    span: {
      description: [
        harnessName(episode.harness),
        title,
        range,
        startsBefore ? 'started earlier' : null,
        endsAfter ? 'continues' : null,
        point ? 'end not recorded' : null,
      ]
        .filter((part) => part !== null)
        .join(' · '),
      end: clamp(rawEnd, 0, 1),
      endsAfter,
      harness: episode.harness,
      key: episode.linkKey,
      point,
      start: clamp(rawStart, 0, 1),
      startsBefore,
      title,
    },
    startedAt: Date.parse(episode.startedAt),
  };
};

const delegatedEpisodes = (episode: WorkThreadEpisode): readonly WorkThreadEpisode[] =>
  episode.children.flatMap((child) => [child, ...delegatedEpisodes(child)]);

const oldestFirst = (left: SessionDraft, right: SessionDraft): number =>
  left.startedAt - right.startedAt || left.span.key.localeCompare(right.span.key);

/**
 * Top-level episodes overlapping the window. `endedAt === null`: ends at `now` when
 * `running === true`, otherwise a point. Children of an episode outside the window are dropped
 * with it only if they are outside too (a child overlapping the window keeps its parent as a
 * zero-width clamped bar at the nearest edge).
 */
export const timelineSessionBars = (
  episodes: readonly WorkThreadEpisode[],
  scale: TimelineScale,
  now: string,
): { readonly bars: readonly TimelineSessionBar[]; readonly rows: number } => {
  const drafts = episodes
    .map((episode) => ({
      children: delegatedEpisodes(episode)
        .map((child) => sessionDraft(child, scale, now))
        .filter((child) => child.overlaps)
        .sort(oldestFirst)
        .map((child) => child.span),
      own: sessionDraft(episode, scale, now),
    }))
    .filter((draft) => draft.own.overlaps || draft.children.length > 0)
    .sort((left, right) => oldestFirst(left.own, right.own));
  // A delegated session can outlast its parent: the row is reserved for both.
  const packed = packRows(drafts, ({ children, own }) => [
    Math.min(own.span.start, ...children.map((child) => child.start)),
    Math.max(own.span.end, ...children.map((child) => child.end)),
  ]);
  return {
    bars: drafts.map(({ children, own }, index) => ({
      ...own.span,
      children,
      // The thin strip under a bar is drawn only: its count is the text that stands for it.
      description:
        children.length > 0
          ? `${own.span.description} · ${plural(children.length, 'delegated session', 'delegated sessions')}`
          : own.span.description,
      row: packed.rows[index] ?? 0,
    })),
    rows: packed.count,
  };
};

/**
 * No filter: "63 of 63 followed tasks loaded · 0 of 0 ended follow-ups". With a project or search
 * filter (totals are unknown for a filter): "12 matching tasks loaded". Appends
 * " · more exist than this view loads" when `complete` is false.
 */
export const timelineLoadedCopy = (
  data: Pick<WorkTimelineDataset, 'complete' | 'counts' | 'loaded'>,
  filter: { readonly project: string | null; readonly search: string | null },
): string => {
  const loaded =
    filter.project === null && filter.search === null
      ? `${data.loaded.open} of ${plural(data.counts.open, 'followed task', 'followed tasks')} loaded · ${data.loaded.done} of ${plural(data.counts.done, 'ended follow-up', 'ended follow-ups')}`
      : `${plural(data.loaded.open + data.loaded.done, 'matching task', 'matching tasks')} loaded`;
  return `${loaded}${data.complete ? '' : ' · more exist than this view loads'}`;
};
