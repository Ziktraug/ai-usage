import type { WorkThreadEpisode } from '@ai-usage/report-core/work-thread-view';
import { type ThreadHistoryEntry, threadDayKey } from './work-thread-model';

/**
 * The cascade of a task's sessions: one row per session on an hour axis, child sessions nested
 * under the parent that declared them, and the task's dated events cutting across.
 *
 * Only declared lineage nests a session. Sessions that merely started together are grouped as a
 * burst and say so; closeness in time never becomes a parent link (CONTEXT.md, Campaign).
 */

/** Sessions closer than this belong to the same stretch of work. */
export const CASCADE_STRETCH_GAP_MS = 45 * 60_000;
/** Parentless sessions starting within this window of the first one form a burst. */
export const CASCADE_BURST_WINDOW_MS = 60_000;
/** A lone session still gets a readable axis. */
export const CASCADE_MIN_AXIS_MS = 60 * 60_000;
export const CASCADE_MAX_TICKS = 12;

/**
 * What a session's own evidence declares, most pressing first. It is a dated declaration read
 * later, never a live state: `quiet` only means a last activity was observed and no open request was
 * read. Request coverage can be partial, so it never says that nothing is pending.
 */
export const CASCADE_MARKS = ['asks', 'unclear', 'running', 'open-ended', 'quiet'] as const;
export type CascadeMark = (typeof CASCADE_MARKS)[number];

export interface CascadeTitle {
  /** Start of the session identifier, shown beside the text or alone when nothing readable was read. */
  readonly fingerprint: string;
  /** Where the text comes from; `none` when the stored label only restates the harness and the id. */
  readonly source: 'title' | 'first-prompt' | 'none';
  readonly text: string | null;
}

/** Totals over a group of sessions. Spans include pauses: they are never work time. */
export interface CascadeSummary {
  readonly count: number;
  /** Latest observed activity in the group; `null` when none was observed. */
  readonly endMs: number | null;
  /** Sum of the known first-to-last spans; `null` when no span is known. */
  readonly spanMs: number | null;
  readonly startMs: number;
  /** Sessions whose span is unknown and therefore missing from `spanMs`. */
  readonly unknownSpans: number;
}

export interface CascadeSessionNode {
  readonly children: readonly CascadeSessionNode[];
  /** Most pressing mark among every descendant; `null` without descendants. */
  readonly childrenMark: CascadeMark | null;
  /** Every descendant, at any depth; `null` without descendants. */
  readonly descendants: CascadeSummary | null;
  /** Last observed activity, or `nowMs` while the session is declared running; `null` when unknown. */
  readonly endMs: number | null;
  readonly episode: WorkThreadEpisode;
  /** The episode's link key. */
  readonly id: string;
  readonly kind: 'session';
  /** The session's own mark, whatever its children declare. */
  readonly mark: CascadeMark;
  readonly startMs: number;
  readonly title: CascadeTitle;
}

/** Parentless sessions that started together. No lineage is declared between them. */
export interface CascadeBurstNode {
  readonly endMs: number | null;
  readonly id: string;
  readonly kind: 'burst';
  /** Most pressing mark among the members and their descendants. */
  readonly mark: CascadeMark;
  readonly members: readonly CascadeSessionNode[];
  readonly startMs: number;
  /** The members only, without their descendants. */
  readonly summary: CascadeSummary;
}

export type CascadeRow = CascadeSessionNode | CascadeBurstNode;

export type CascadeHistoryEntry = Exclude<ThreadHistoryEntry, { readonly kind: 'session' }>;

export interface CascadeMilestone {
  readonly atMs: number;
  /**
   * True for the events that change the reading of the sessions around them: a pull request fact,
   * the task's creation and a follow-state change. Those draw a line across the cascade.
   */
  readonly cuts: boolean;
  readonly entry: CascadeHistoryEntry;
  readonly id: string;
}

export interface CascadeAxis {
  readonly endMs: number;
  readonly startMs: number;
  readonly stepMs: number;
  /** Tick instants from `startMs` to `endMs` inclusive, one per step. */
  readonly ticks: readonly number[];
}

/** A stretch of work: sessions separated by less than `CASCADE_STRETCH_GAP_MS`. */
export interface CascadeStretch {
  readonly axis: CascadeAxis;
  /** Child sessions at any depth below the stretch's rows. */
  readonly childCount: number;
  /** Local calendar days the stretch covers, oldest first (`YYYY-MM-DD`). */
  readonly dayKeys: readonly string[];
  /** Latest observed activity of the stretch, descendants included. */
  readonly endMs: number;
  readonly id: string;
  readonly kind: 'stretch';
  /** Most pressing mark of the stretch. */
  readonly mark: CascadeMark;
  /** Events dated inside the axis, in the cascade's order. */
  readonly milestones: readonly CascadeMilestone[];
  readonly rows: readonly CascadeRow[];
  /** Sessions at the top level of the stretch, burst members included. */
  readonly sessionCount: number;
  readonly startMs: number;
}

/** Events dated outside every stretch, kept at their place between two stretches. */
export interface CascadeInterlude {
  readonly id: string;
  readonly kind: 'interlude';
  readonly milestones: readonly CascadeMilestone[];
}

export type CascadeBlock = CascadeStretch | CascadeInterlude;

export interface SessionCascadeInput {
  /** The task's root episodes, each with its declared children. */
  readonly episodes: readonly WorkThreadEpisode[];
  /** The task's dated events other than sessions, already filtered by the history controls. */
  readonly events: readonly CascadeHistoryEntry[];
  readonly newestFirst: boolean;
  /** When the dataset was read; the end of a session declared running. */
  readonly nowMs: number;
  readonly timeZone: string;
}

const HARNESS_WORDS = new Set(['agent', 'claude', 'claude-code', 'codex', 'cursor', 'opencode', 'session', 'subagent']);
const FINGERPRINT_LENGTH = 8;
const AGENT_ID_PREFIX = 'agent-';
const TITLE_LIMIT = 120;
const WHITESPACE = /\s+/;

const firstLine = (value: string): string | null => {
  const line = value
    .split('\n')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0);
  if (line === undefined) {
    return null;
  }
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
};

/** A stored label made only of harness words and the start of the session id names nothing. */
const restatesIdentity = (title: string, sourceSessionId: string): boolean =>
  title
    .toLowerCase()
    .split(WHITESPACE)
    .filter((word) => word.length > 0)
    .every((word) => HARNESS_WORDS.has(word) || sourceSessionId.toLowerCase().startsWith(word));

/**
 * The readable name of a session: its stored title, else the first line of its first prompt.
 * When neither was read, the text is `null` and the fingerprint stands alone.
 */
export const cascadeTitle = (
  episode: Pick<WorkThreadEpisode, 'firstPrompt' | 'sourceSessionId' | 'title'>,
): CascadeTitle => {
  // Claude names its sub-agents `agent-<hex>`: the shared prefix would make two of them read alike.
  const fingerprint = episode.sourceSessionId.startsWith(AGENT_ID_PREFIX)
    ? episode.sourceSessionId.slice(0, AGENT_ID_PREFIX.length + FINGERPRINT_LENGTH)
    : episode.sourceSessionId.slice(0, FINGERPRINT_LENGTH);
  const title = episode.title === null ? null : firstLine(episode.title);
  if (title !== null && !restatesIdentity(title, episode.sourceSessionId)) {
    return { fingerprint, source: 'title', text: title };
  }
  const prompt = episode.firstPrompt === null ? null : firstLine(episode.firstPrompt);
  return prompt === null
    ? { fingerprint, source: 'none', text: null }
    : { fingerprint, source: 'first-prompt', text: prompt };
};

/** The session's own mark, from its declared requests, its running flag and its observed end. */
export const cascadeMark = (
  episode: Pick<WorkThreadEpisode, 'endedAt' | 'nativeRequests' | 'running'>,
): CascadeMark => {
  if (episode.nativeRequests.some((request) => request.state === 'open')) {
    return 'asks';
  }
  if (episode.nativeRequests.some((request) => request.state === 'uncertain')) {
    return 'unclear';
  }
  if (episode.running === true) {
    return 'running';
  }
  return episode.endedAt === null ? 'open-ended' : 'quiet';
};

/** The most pressing of the given marks; `null` for none. */
export const worstCascadeMark = (marks: readonly CascadeMark[]): CascadeMark | null =>
  CASCADE_MARKS.find((mark) => marks.includes(mark)) ?? null;

/** Where an instant sits on the axis, from 0 to 1, clamped to the axis. */
export const cascadeOffset = (axis: Pick<CascadeAxis, 'endMs' | 'startMs'>, atMs: number): number =>
  Math.min(1, Math.max(0, (atMs - axis.startMs) / (axis.endMs - axis.startMs)));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WIDEST_AXIS_STEP_MS = 7 * DAY_MS;
const AXIS_STEPS_MS = [
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  WIDEST_AXIS_STEP_MS,
] as const;

interface StretchDraft {
  endMs: number;
  /** Oldest first. */
  readonly rows: CascadeRow[];
  readonly startMs: number;
}

/** A stretch being assembled; both milestone lists are filled oldest first. */
interface StretchFrame {
  readonly axis: CascadeAxis;
  readonly draft: StretchDraft;
  /** Events dated in the gap that precedes the stretch, outside every axis. */
  readonly interludeBefore: CascadeMilestone[];
  readonly milestones: CascadeMilestone[];
}

/** Code-unit order: the same on every machine, whatever its locale. */
const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const byStartThenId = (left: CascadeSessionNode, right: CascadeSessionNode): number =>
  left.startMs - right.startMs || compareText(left.id, right.id);

const byInstantThenId = (left: CascadeMilestone, right: CascadeMilestone): number =>
  left.atMs - right.atMs || compareText(left.id, right.id);

/** Everything is assembled oldest first; newest first is its exact reverse. */
const inOrder = <Item>(oldestFirst: readonly Item[], newestFirst: boolean): readonly Item[] =>
  newestFirst ? [...oldestFirst].reverse() : oldestFirst;

/** The reader serves canonical instants, so an unreadable one is a broken invariant, not a case to absorb. */
const instantMs = (value: string, owner: string): number => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`${owner} is not a readable instant: ${JSON.stringify(value)}`);
  }
  return parsed;
};

const latestKnown = (values: readonly (number | null)[]): number | null => {
  const known = values.flatMap((value) => (value === null ? [] : [value]));
  return known.length === 0 ? null : Math.max(...known);
};

/** The most pressing mark of a group that holds at least one session. */
const pressingMark = (marks: readonly CascadeMark[]): CascadeMark => {
  const mark = worstCascadeMark(marks);
  if (mark === null) {
    throw new Error('A cascade group holds at least one session.');
  }
  return mark;
};

const summarize = (sessions: readonly CascadeSessionNode[]): CascadeSummary => {
  if (sessions.length === 0) {
    throw new Error('A cascade summary covers at least one session.');
  }
  let endMs: number | null = null;
  let spanMs: number | null = null;
  let unknownSpans = 0;
  for (const session of sessions) {
    if (session.endMs === null) {
      unknownSpans += 1;
    } else {
      endMs = Math.max(endMs ?? session.endMs, session.endMs);
      spanMs = (spanMs ?? 0) + (session.endMs - session.startMs);
    }
  }
  return {
    count: sessions.length,
    endMs,
    spanMs,
    startMs: Math.min(...sessions.map((session) => session.startMs)),
    unknownSpans,
  };
};

const descendantsOf = (node: CascadeSessionNode): readonly CascadeSessionNode[] =>
  node.children.flatMap((child) => [child, ...descendantsOf(child)]);

/** The session's own mark and the most pressing one below it. */
const marksUnder = (node: CascadeSessionNode): readonly CascadeMark[] =>
  node.childrenMark === null ? [node.mark] : [node.mark, node.childrenMark];

/** Latest observed activity of the session and of everything below it; `null` when none was observed. */
const latestEndUnder = (node: CascadeSessionNode): number | null =>
  latestKnown([node.endMs, node.descendants?.endMs ?? null]);

const sessionEndMs = (episode: WorkThreadEpisode, startMs: number, nowMs: number): number | null => {
  let endMs: number | null = null;
  if (episode.endedAt !== null) {
    endMs = instantMs(episode.endedAt, `The end of session ${episode.linkKey}`);
  } else if (episode.running === true) {
    endMs = nowMs;
  }
  // An end before the start measures nothing: the span is unknown, never negative.
  return endMs === null || endMs < startMs ? null : endMs;
};

const sessionNode = (episode: WorkThreadEpisode, nowMs: number, newestFirst: boolean): CascadeSessionNode => {
  const startMs = instantMs(episode.startedAt, `The start of session ${episode.linkKey}`);
  const children = episode.children.map((child) => sessionNode(child, nowMs, newestFirst)).sort(byStartThenId);
  const below = children.flatMap((child) => [child, ...descendantsOf(child)]);
  return {
    children: inOrder(children, newestFirst),
    childrenMark: worstCascadeMark(below.map((node) => node.mark)),
    descendants: below.length === 0 ? null : summarize(below),
    endMs: sessionEndMs(episode, startMs, nowMs),
    episode,
    id: episode.linkKey,
    kind: 'session',
    mark: cascadeMark(episode),
    startMs,
    title: cascadeTitle(episode),
  };
};

/**
 * True when nothing read says the session was launched by another one. A delegated session whose
 * parent is not among the task's sessions still declares a lineage: it never joins a burst.
 */
export const readsNoParent = (episode: Pick<WorkThreadEpisode, 'launchedBy' | 'origin'>): boolean =>
  episode.launchedBy === null && episode.origin !== 'delegated';

/**
 * Splits the roots (oldest first) into runs: each parentless root opens a run that the following
 * parentless roots join while they start within the window of the one that opened it. A root with a
 * declared parent is a run of its own and closes the open one.
 */
const burstRuns = (roots: readonly CascadeSessionNode[]): readonly (readonly CascadeSessionNode[])[] => {
  const runs: CascadeSessionNode[][] = [];
  let open: { readonly members: CascadeSessionNode[]; readonly startMs: number } | null = null;
  for (const root of roots) {
    const parentless = readsNoParent(root.episode);
    if (parentless && open !== null && root.startMs - open.startMs <= CASCADE_BURST_WINDOW_MS) {
      open.members.push(root);
    } else {
      const members = [root];
      runs.push(members);
      open = parentless ? { members, startMs: root.startMs } : null;
    }
  }
  return runs;
};

/** A run of one is a plain session row; a longer run is a burst. */
const rowOf = (run: readonly CascadeSessionNode[], newestFirst: boolean): readonly CascadeRow[] => {
  const [first, ...others] = run;
  if (first === undefined) {
    return [];
  }
  if (others.length === 0) {
    return [first];
  }
  return [
    {
      endMs: latestKnown(run.map(latestEndUnder)),
      id: `burst:${first.id}`,
      kind: 'burst',
      mark: pressingMark(run.flatMap(marksUnder)),
      members: inOrder(run, newestFirst),
      startMs: first.startMs,
      summary: summarize(run),
    },
  ];
};

const sessionsOf = (row: CascadeRow): readonly CascadeSessionNode[] => (row.kind === 'burst' ? row.members : [row]);

const latestStartUnder = (node: CascadeSessionNode): number =>
  Math.max(node.startMs, ...node.children.map(latestStartUnder));

/**
 * Where the row's activity ends, descendants included. A session with no observed end counts as an
 * instant at its start, so a late child without an end still stretches the axis to where it is drawn.
 */
const extentEndOf = (row: CascadeRow): number =>
  Math.max(...sessionsOf(row).map(latestStartUnder), latestKnown(sessionsOf(row).map(latestEndUnder)) ?? row.startMs);

/** Rows arrive oldest first; a row joins the stretch whose latest activity it follows closely enough. */
const stretchDrafts = (rows: readonly CascadeRow[]): readonly StretchDraft[] => {
  const drafts: StretchDraft[] = [];
  let current: StretchDraft | null = null;
  for (const row of rows) {
    const extentEnd = extentEndOf(row);
    if (current !== null && row.startMs - current.endMs < CASCADE_STRETCH_GAP_MS) {
      current.rows.push(row);
      current.endMs = Math.max(current.endMs, extentEnd);
    } else {
      current = { endMs: extentEnd, rows: [row], startMs: row.startMs };
      drafts.push(current);
    }
  }
  return drafts;
};

/** Wall-clock time elapsed since local midnight, read from the zone's own clock at that instant. */
const localTimeOfDayMs = (atMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  }).formatToParts(new Date(atMs));
  const read = (type: 'hour' | 'minute' | 'second'): number => {
    const value = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isInteger(value)) {
      throw new TypeError(`The ${type} of ${new Date(atMs).toISOString()} is unreadable in time zone ${timeZone}.`);
    }
    return value;
  };
  const subSecondMs = ((atMs % 1000) + 1000) % 1000;
  return read('hour') * HOUR_MS + read('minute') * MINUTE_MS + read('second') * 1000 + subSecondMs;
};

/**
 * The axis of a stretch: ticks on local clock boundaries (a 6 h step ticks at 00:00, 06:00, 12:00
 * and 18:00 local time), at the smallest step that fits the tick budget.
 *
 * The local clock is read once, at the start of the stretch. A daylight-saving change inside the
 * stretch is ignored: ticks stay evenly spaced, so the ones after the change sit one hour off the
 * local boundaries.
 */
const axisFor = (stretchStartMs: number, stretchEndMs: number, timeZone: string): CascadeAxis => {
  const sinceLocalMidnightMs = localTimeOfDayMs(stretchStartMs, timeZone);
  const neededEndMs = Math.max(stretchEndMs, stretchStartMs + CASCADE_MIN_AXIS_MS);
  // A step longer than a day floors to the local midnight of the start's day.
  const startFor = (step: number): number => stretchStartMs - (sinceLocalMidnightMs % step);
  const stepsFor = (step: number): number => Math.ceil((neededEndMs - startFor(step)) / step);
  const fits = (step: number): boolean => stepsFor(step) + 1 <= CASCADE_MAX_TICKS;
  // Past the listed steps the widest one doubles until it fits: a session open for years keeps a bounded axis.
  let stepMs = AXIS_STEPS_MS.find(fits) ?? WIDEST_AXIS_STEP_MS;
  while (!fits(stepMs)) {
    stepMs *= 2;
  }
  const startMs = startFor(stepMs);
  const steps = stepsFor(stepMs);
  return {
    endMs: startMs + steps * stepMs,
    startMs,
    stepMs,
    ticks: Array.from({ length: steps + 1 }, (_, index) => startMs + index * stepMs),
  };
};

/** Every local calendar day from the first instant's to the last one's, oldest first. */
const dayKeysBetween = (startMs: number, endMs: number, timeZone: string): readonly string[] => {
  // Counted on the calendar keys themselves: a local day is not always 24 hours long.
  const firstDayMs = Date.parse(`${threadDayKey(new Date(startMs), timeZone)}T00:00:00.000Z`);
  const lastDayMs = Date.parse(`${threadDayKey(new Date(endMs), timeZone)}T00:00:00.000Z`);
  const keys: string[] = [];
  for (let dayMs = firstDayMs; dayMs <= lastDayMs; dayMs += DAY_MS) {
    keys.push(new Date(dayMs).toISOString().slice(0, 10));
  }
  return keys;
};

const cutsAcross = (entry: CascadeHistoryEntry): boolean =>
  entry.kind === 'fact-event' || entry.event.kind === 'created' || entry.event.kind === 'follow-state';

const milestoneOf = (entry: CascadeHistoryEntry): CascadeMilestone => ({
  atMs: instantMs(entry.at, `The date of event ${entry.id}`),
  cuts: cutsAcross(entry),
  entry,
  id: entry.id,
});

/**
 * The one stretch an instant is drawn on: among the stretches whose axis covers it, the one whose
 * sessions surround it, else the latest one already started, else the earliest. `undefined` when
 * no axis covers it. An event is thus never listed under sessions that all began after it while an
 * earlier stretch could hold it, nor under an older stretch once a later one has begun.
 */
const attachedFrame = (frames: readonly StretchFrame[], atMs: number): StretchFrame | undefined => {
  const covering = frames.filter((frame) => atMs >= frame.axis.startMs && atMs <= frame.axis.endMs);
  return (
    covering.find((frame) => atMs >= frame.draft.startMs && atMs <= frame.draft.endMs) ??
    covering.findLast((frame) => frame.draft.startMs <= atMs) ??
    covering[0]
  );
};

const interludeOf = (milestones: readonly CascadeMilestone[], newestFirst: boolean): readonly CascadeInterlude[] => {
  const [oldest] = milestones;
  return oldest === undefined
    ? []
    : [{ id: `interlude:${oldest.id}`, kind: 'interlude', milestones: inOrder(milestones, newestFirst) }];
};

const stretchOf = (frame: StretchFrame, timeZone: string, newestFirst: boolean): CascadeStretch => {
  const { endMs, rows, startMs } = frame.draft;
  const sessions = rows.flatMap(sessionsOf);
  return {
    axis: frame.axis,
    childCount: sessions.reduce((count, session) => count + (session.descendants?.count ?? 0), 0),
    dayKeys: dayKeysBetween(startMs, endMs, timeZone),
    endMs,
    id: `stretch:${new Date(startMs).toISOString()}`,
    kind: 'stretch',
    mark: pressingMark(sessions.flatMap(marksUnder)),
    milestones: inOrder(frame.milestones, newestFirst),
    rows: inOrder(rows, newestFirst),
    sessionCount: sessions.length,
    startMs,
  };
};

/**
 * Builds the cascade blocks of a task, in the requested order.
 *
 * - Every root episode becomes a session node with its declared children nested (recursively).
 * - Roots for which no parent was read (`readsNoParent`) and that start within `CASCADE_BURST_WINDOW_MS`
 *   of the first of them form one burst, when there are at least two.
 * - Rows whose extents (start to latest activity, descendants included) are separated by less than
 *   `CASCADE_STRETCH_GAP_MS` form one stretch; a session with no observed end counts as an instant.
 * - Events dated within a stretch's axis are its milestones; the others form interludes placed
 *   between the stretches in time order.
 */
export const buildSessionCascade = (input: SessionCascadeInput): readonly CascadeBlock[] => {
  const { newestFirst, nowMs, timeZone } = input;
  const roots = input.episodes.map((episode) => sessionNode(episode, nowMs, newestFirst)).sort(byStartThenId);
  const rows = burstRuns(roots).flatMap((run) => rowOf(run, newestFirst));
  const frames = stretchDrafts(rows).map(
    (draft): StretchFrame => ({
      axis: axisFor(draft.startMs, draft.endMs, timeZone),
      draft,
      interludeBefore: [],
      milestones: [],
    }),
  );
  // Events dated after the last stretch; every event when the task has no session.
  const trailing: CascadeMilestone[] = [];
  for (const milestone of input.events.map(milestoneOf).sort(byInstantThenId)) {
    const attached = attachedFrame(frames, milestone.atMs);
    if (attached === undefined) {
      // Outside every axis, hence outside every stretch: the next stretch to start bounds its gap.
      const next = frames.find((frame) => frame.draft.startMs > milestone.atMs);
      (next === undefined ? trailing : next.interludeBefore).push(milestone);
    } else {
      attached.milestones.push(milestone);
    }
  }
  const blocks: readonly CascadeBlock[] = [
    ...frames.flatMap((frame) => [
      ...interludeOf(frame.interludeBefore, newestFirst),
      stretchOf(frame, timeZone, newestFirst),
    ]),
    ...interludeOf(trailing, newestFirst),
  ];
  return inOrder(blocks, newestFirst);
};
