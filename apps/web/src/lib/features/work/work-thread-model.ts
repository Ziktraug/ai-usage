import { parseWorkThreadLinkKey, type WorkThreadEvent } from '@ai-usage/report-core/work-thread';
import {
  deriveWorkThreadSituation,
  isUnreadRemainder,
  settledPullRequests,
  WORK_THREAD_STALE_AFTER_MS,
  type WorkThreadRemainder,
  type WorkThreadSituation,
} from '@ai-usage/report-core/work-thread-situation';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadDetailDataset,
  type WorkThreadEpisode,
  type WorkThreadFact,
  type WorkThreadFactEvent,
  type WorkThreadFactEventKind,
  type WorkThreadListQuery,
  type WorkThreadMark,
  type WorkThreadMarkers,
  type WorkThreadPullRequestMarker,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
  workThreadFactEventLabel,
} from '@ai-usage/report-core/work-thread-view';

/** The lenses of the page, in the order of its switcher. The first is the one a URL without `view` shows. */
export const THREAD_VIEWS = ['lanes', 'pilot', 'timeline', 'disk'] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];

/** The lens is chosen by the URL; an absent or unknown value keeps the lanes. */
export const threadView = (search: URLSearchParams): ThreadView => {
  const value = search.get('view');
  return THREAD_VIEWS.find((view) => view === value) ?? 'lanes';
};

/**
 * Parameters a switch of lens drops. The page size differs per lens, so the place in a paged list
 * and the open task do not carry over; `band` filters Pilot only, and `group` names a different
 * grouping in Lanes and in Timeline. Filters every lens shares (`project`, `q`, `tab`) and the
 * Timeline's own window (`from`, `to`, `open`, `quiet`, read by no other lens) are kept.
 */
const VIEW_SWITCH_DROPPED = ['cursor', 'start', 'scroll', 'focus', 'task', 'detail', 'day', 'band', 'group'] as const;

/** The same page under another lens. Lanes is the URL without `view`. */
export const threadViewUrl = (url: URL, target: ThreadView): string => {
  const next = new URL(url);
  next.pathname = '/work';
  next.hash = '';
  for (const parameter of VIEW_SWITCH_DROPPED) {
    next.searchParams.delete(parameter);
  }
  if (target === 'lanes') {
    next.searchParams.delete('view');
  } else {
    next.searchParams.set('view', target);
  }
  return `${next.pathname}${next.search}`;
};

export const threadListQuery = (search: URLSearchParams): WorkThreadListQuery => ({
  cursor: search.get('cursor') || null,
  // Pilot counts tasks per band, so it reads the whole followed set where it fits one page.
  limit: threadView(search) === 'pilot' ? WORK_THREAD_VIEW_BOUNDS.maxPageSize : 50,
  project: search.get('project') || null,
  search: search.get('q')?.slice(0, 200) || null,
  tab: search.get('tab') === 'done' ? 'done' : 'open',
});

/** Bound concurrent readers; browser Back preserves the previous window on continuation. */
export const THREAD_PAGE_WINDOW = 20;
export const threadPageCursors = (search: URLSearchParams): readonly (string | null)[] =>
  [search.get('start') || null, ...new Set(search.getAll('cursor').filter(Boolean))].slice(0, THREAD_PAGE_WINDOW);

export const threadMoreUrl = (current: URL, nextCursor: string): { url: URL; continuation: boolean } => {
  const url = new URL(current);
  const continuation = threadPageCursors(current.searchParams).length >= THREAD_PAGE_WINDOW;
  if (continuation) {
    url.searchParams.delete('cursor');
    url.searchParams.delete('scroll');
    url.searchParams.set('start', nextCursor);
  } else {
    url.searchParams.append('cursor', nextCursor);
  }
  return { url, continuation };
};

/** The task as a full page, or the list when `threadId` is null. Never the side pane: see `threadSideUrl`. */
export const threadUrl = (url: URL, threadId: string | null, day?: string): string => {
  const next = new URL(url);
  next.pathname = '/work';
  next.hash = '';
  next.searchParams.delete('day');
  next.searchParams.delete('detail');
  if (threadId) {
    next.searchParams.set('task', threadId);
  } else {
    next.searchParams.delete('task');
  }
  if (day) {
    next.searchParams.set('day', day);
  }
  return `${next.pathname}${next.search}`;
};

/** The task in the pane beside the list: the list stays the page (`detail=side`). */
export const threadSideUrl = (url: URL, threadId: string, day?: string): string => {
  const next = new URL(threadUrl(url, threadId, day), url);
  next.searchParams.set('detail', 'side');
  return `${next.pathname}${next.search}`;
};

/** One branch can be checked out in several worktrees: the checkout tells their markers apart. */
export const localMarkerKey = (marker: WorkThreadMarkers['local'][number]): string =>
  `${marker.key}\n${marker.latest?.checkoutPath ?? marker.latestSuccessful?.checkoutPath ?? ''}`;

/** The repository name alone ("Exalibur" for "exaprint/Exalibur"): the owner rarely tells tasks apart. */
export const projectShortLabel = (label: string | null): string =>
  label === null ? 'No project' : (label.split('/').filter(Boolean).at(-1) ?? label);

export const groupThreadRows = (rows: readonly WorkThreadRow[]) => {
  const groups = new Map<string, WorkThreadRow[]>();
  for (const row of rows) {
    const project = row.thread.projectLabel ?? 'No project';
    const group = groups.get(project) ?? [];
    group.push(row);
    groups.set(project, group);
  }
  return [...groups].map(([project, tasks]) => ({
    project,
    label: projectShortLabel(tasks[0]?.thread.projectLabel ?? null),
    tasks,
  }));
};

const SITUATION_GROUPS = [
  { hint: 'to-resume', label: 'To resume', note: 'Your next step' },
  { hint: 'in-progress', label: 'In progress', note: 'A session is still running' },
  { hint: 'undecided', label: 'To decide', note: 'A team request, or evidence missing or stale' },
  { hint: 'waiting', label: 'Waiting', note: 'On reviewers, checks or a reply' },
  { hint: 'ready-to-close', label: 'Ready to close', note: 'Nothing known is left' },
  { hint: 'done', label: 'Done', note: 'Follow-up ended' },
] as const;

/** Whose move it is first: tasks to resume lead, then work that waits on someone else. */
export const groupThreadRowsBySituation = (
  rows: readonly WorkThreadRow[],
  hintOf: (row: WorkThreadRow) => (typeof SITUATION_GROUPS)[number]['hint'],
) =>
  SITUATION_GROUPS.flatMap(({ hint, label, note }) => {
    const tasks = rows.filter((row) => hintOf(row) === hint);
    return tasks.length ? [{ project: label, label, note, tasks }] : [];
  });

/** Calendar keys, not elapsed 24-hour intervals: correct across midnight and DST. */
export const threadDayKey = (at: string | Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export interface ThreadTimelineDay {
  readonly dayOfMonth: number;
  /** Calendar key `YYYY-MM-DD` in the operator's time zone. */
  readonly key: string;
  /** Accessible and tooltip name: "Mon, Oct 20". */
  readonly label: string;
  /** Set on the first day shown and on each first of the month: "Oct 2026". */
  readonly month: string | null;
  readonly today: boolean;
  /** Mondays carry the week tick of the scale. */
  readonly weekStart: boolean;
}

/** Two weeks at least, so a recent task still reads against its days. */
export const THREAD_TIMELINE_MIN_DAYS = 14;

/**
 * Calendar days from the earliest activity among `firstActivities` to today, today last, bounded
 * by `maxTimelineDays`. Days are calendar keys, so DST and midnight never shift a column.
 */
export const threadTimeline = (
  now: string,
  timeZone: string,
  firstActivities: readonly string[] = [],
): readonly ThreadTimelineDay[] => {
  const today = threadDayKey(now, timeZone);
  const anchor = Date.parse(`${today}T12:00:00Z`);
  const earliest = firstActivities.reduce((first, at) => {
    const key = threadDayKey(at, timeZone);
    return key < first ? key : first;
  }, today);
  const span = Math.round((anchor - Date.parse(`${earliest}T12:00:00Z`)) / 86_400_000) + 1;
  const length = Math.min(Math.max(span, THREAD_TIMELINE_MIN_DAYS), WORK_THREAD_VIEW_BOUNDS.maxTimelineDays);
  return Array.from({ length }, (_, index) => {
    const day = new Date(anchor - (length - 1 - index) * 86_400_000);
    const dayOfMonth = day.getUTCDate();
    return {
      key: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }),
      dayOfMonth,
      weekStart: day.getUTCDay() === 1,
      month:
        index === 0 || dayOfMonth === 1
          ? day.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' })
          : null,
      today: index === length - 1,
    };
  });
};

/** Most telling first: when one day holds several milestones of a pull request, its track draws the first. */
const MILESTONE_RANK: readonly WorkThreadFactEventKind[] = [
  'pull-request-merged',
  'pull-request-closed',
  'pull-request-approved',
  'pull-request-changes-requested',
  'pull-request-reopened',
  'pull-request-ready',
  'pull-request-draft',
  'pull-request-opened',
];

/**
 * What one day of a task's lane shows: its sessions, its follow-up changes, and every mark named in
 * the accessible description, so the day reads the same without opening it. Milestones are drawn
 * on their pull request's track (`threadPullRequestTracks`).
 */
export const threadDayMarks = (marks: readonly WorkThreadMark[], dayLabel: string) => {
  const sessions = marks.filter((mark) => mark.kind === 'session');
  const milestones = marks.filter((mark) => mark.kind === 'event' && mark.fact !== null);
  const others = marks.length - sessions.length - milestones.length;
  const parts = [
    `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`,
    ...milestones.map((mark) => mark.label ?? 'Pull request milestone'),
    ...(others > 0 ? [`${others} ${others === 1 ? 'follow-up change' : 'follow-up changes'}`] : []),
  ];
  return { sessions, others, description: `${dayLabel}: ${parts.join(', ')}. Show activity.` };
};

/** Beyond this, the least recent pull requests are left to the day details rather than growing the row. */
export const THREAD_LANE_MAX_TRACKS = 3;

export interface ThreadPullRequestTrack {
  /** Where its latest milestone leaves it; an open pull request continues to today. */
  readonly end: 'merged' | 'closed' | 'open';
  readonly firstDay: string;
  readonly key: string;
  readonly label: string;
  readonly lastDay: string;
  /** Its first visible milestone is not the opening, so the track leads in from earlier. */
  readonly openedEarlier: boolean;
  /** The most telling milestone of each day, by day key. */
  readonly steps: ReadonlyMap<string, WorkThreadFactEventKind>;
}

const TRACK_ENDS: Partial<Record<WorkThreadFactEventKind, ThreadPullRequestTrack['end']>> = {
  'pull-request-merged': 'merged',
  'pull-request-closed': 'closed',
};

/** One track per pull request, its milestones in order, earliest pull request first. */
export const threadPullRequestTracks = (
  marks: readonly WorkThreadMark[],
  timeZone: string,
): { readonly tracks: readonly ThreadPullRequestTrack[]; readonly hidden: number } => {
  const sources = new Map<
    string,
    { label: string; days: Map<string, WorkThreadFactEventKind[]>; first: WorkThreadFactEventKind; last: string }
  >();
  for (const mark of [...marks].sort((left, right) => left.at.localeCompare(right.at))) {
    if (mark.fact === null) {
      continue;
    }
    const key = mark.source?.key ?? '';
    const source = sources.get(key) ?? {
      label: mark.source?.label ?? 'Pull request',
      days: new Map<string, WorkThreadFactEventKind[]>(),
      first: mark.fact,
      last: mark.at,
    };
    const day = threadDayKey(mark.at, timeZone);
    source.days.set(day, [...(source.days.get(day) ?? []), mark.fact]);
    source.last = mark.at;
    sources.set(key, source);
  }
  const tracks = [...sources]
    .sort(([, left], [, right]) => right.last.localeCompare(left.last))
    .slice(0, THREAD_LANE_MAX_TRACKS)
    .map(([key, source]): ThreadPullRequestTrack => {
      const days = [...source.days.keys()];
      const latest = [...source.days.values()].at(-1)?.at(-1);
      return {
        key,
        label: source.label,
        steps: new Map(
          [...source.days].map(([day, facts]) => [
            day,
            facts.reduce((best, kind) => (MILESTONE_RANK.indexOf(kind) < MILESTONE_RANK.indexOf(best) ? kind : best)),
          ]),
        ),
        firstDay: days[0] ?? '',
        lastDay: days.at(-1) ?? '',
        openedEarlier: source.first !== 'pull-request-opened',
        end: TRACK_ENDS[latest ?? 'pull-request-opened'] ?? 'open',
      };
    })
    .sort((left, right) => left.firstDay.localeCompare(right.firstDay));
  return { tracks, hidden: sources.size - tracks.length };
};

export const bucketThreadMarks = (marks: readonly WorkThreadMark[], timeZone: string) => {
  const days = new Map<string, WorkThreadMark[]>();
  for (const mark of marks) {
    const day = threadDayKey(mark.at, timeZone);
    const group = days.get(day) ?? [];
    group.push(mark);
    days.set(day, group);
  }
  return days;
};

const yearIn = (at: string | Date, timeZone: string): string =>
  new Date(at).toLocaleDateString('en-US', { timeZone, year: 'numeric' });

/** With `now`, a date from another year names its year, so an old PR does not read as recent. */
export const threadDate = (at: string | Date, timeZone: string, long = false, now?: string): string =>
  new Date(at).toLocaleDateString('en-US', {
    timeZone,
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(long ? { weekday: 'long' as const } : {}),
    ...(now !== undefined && yearIn(at, timeZone) !== yearIn(now, timeZone) ? { year: 'numeric' as const } : {}),
  });

export const threadTime = (at: string | Date, timeZone: string): string =>
  new Date(at).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });

/** Calendar-day offsets keep overnight ranges honest even across daylight-saving changes. */
export const threadTimeRange = (startedAt: string | Date, endedAt: string | Date | null, timeZone: string): string => {
  const start = threadTime(startedAt, timeZone);
  if (endedAt === null) {
    return start;
  }
  const dayOffset = Math.round(
    (Date.parse(`${threadDayKey(endedAt, timeZone)}T00:00:00Z`) -
      Date.parse(`${threadDayKey(startedAt, timeZone)}T00:00:00Z`)) /
      86_400_000,
  );
  return `${start}–${threadTime(endedAt, timeZone)}${dayOffset > 0 ? ` +${dayOffset}d` : ''}`;
};

export const episodeTimeRange = (episode: Pick<WorkThreadEpisode, 'startedAt' | 'endedAt'>, timeZone: string): string =>
  threadTimeRange(episode.startedAt, episode.endedAt, timeZone);

export type PullRequestTone =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'blocked'
  | 'approved'
  | 'your-review'
  | 'in-review'
  | 'open'
  | 'unknown';

/**
 * One glanceable state per pull request, most decisive first: a conflict or requested changes
 * block the author whatever the review says, and a review requested of the operator is theirs.
 */
export const pullRequestBadge = (
  marker: WorkThreadPullRequestMarker,
): { readonly tone: PullRequestTone; readonly label: string } => {
  const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful;
  if (!fact?.state) {
    return { tone: 'unknown', label: 'State unknown' };
  }
  if (fact.state === 'MERGED') {
    return { tone: 'merged', label: 'Merged' };
  }
  if (fact.state === 'CLOSED') {
    return { tone: 'closed', label: 'Closed' };
  }
  if (marker.role === 'review-requested') {
    return { tone: 'your-review', label: 'Your review' };
  }
  if (marker.role === 'team-review-requested') {
    return { tone: 'in-review', label: 'Team review' };
  }
  if (fact.draft) {
    return { tone: 'draft', label: 'Draft' };
  }
  if (marker.mergeable === 'conflicting' || marker.mergeStateStatus === 'DIRTY') {
    return { tone: 'blocked', label: 'Conflicts' };
  }
  if (fact.reviewDecision === 'CHANGES_REQUESTED') {
    return { tone: 'blocked', label: 'Changes requested' };
  }
  if (fact.reviewDecision === 'APPROVED') {
    return { tone: 'approved', label: 'Approved' };
  }
  if (fact.reviewDecision === 'REVIEW_REQUIRED') {
    return { tone: 'in-review', label: 'In review' };
  }
  return { tone: 'open', label: 'Open' };
};

/** Checks only matter while the pull request is open; a merged PR's last run is history. */
export const pullRequestChecks = (
  marker: WorkThreadPullRequestMarker,
): { readonly tone: 'passing' | 'failing' | 'pending' | 'unknown'; readonly label: string } | null => {
  const fact = marker.latest?.outcome === 'observed' ? marker.latest : marker.latestSuccessful;
  if (fact?.state !== 'OPEN') {
    return null;
  }
  switch (fact.checksRollup) {
    case 'success':
      return { tone: 'passing', label: 'Checks pass' };
    case 'failure':
      return { tone: 'failing', label: 'Checks fail' };
    case 'pending':
      return { tone: 'pending', label: 'Checks running' };
    default:
      return { tone: 'unknown', label: 'Checks unknown' };
  }
};

export const harnessName = (harness: string): string =>
  ({ claude: 'Claude', 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' })[harness] ??
  harness;
/** Harnesses whose provider publishes a mark the design system draws (`ProviderMark`). */
export const harnessHasMark = (harness: string | null): boolean =>
  harness !== null && ['claude', 'claude-code', 'codex', 'cursor', 'opencode'].includes(harness);
export const harnessGlyph = (harness: string | null): string => {
  if (harness === null) {
    return 'S';
  }
  return (
    { claude: 'Cl', 'claude-code': 'Cl', codex: 'Cx', cursor: 'Cu', opencode: 'Oc' }[harness] ?? harness.slice(0, 2)
  );
};

export const threadRefs = (row: WorkThreadRow): string => {
  const refs = row.links
    .filter((link) => link.detachedAt === null)
    .flatMap((link) => {
      const key = parseWorkThreadLinkKey(link.kind, link.key);
      if (key?.kind === 'pull-request') {
        return [`PR #${key.number}`];
      }
      if (key?.kind === 'jira-issue') {
        return [key.key];
      }
      return [];
    });
  if (!refs.length && row.markers.local.length) {
    refs.push('Local branch');
  }
  refs.push(`${row.sessionCount} linked ${row.sessionCount === 1 ? 'session' : 'sessions'}`);
  if (row.delegatedSessionCount > 0) {
    refs.push(`${row.delegatedSessionCount} delegated`);
  }
  return refs.join(' · ');
};

/** A linked source with no observation must remain a visible unknown marker. */
export const threadDisplayMarkers = (row: WorkThreadRow): WorkThreadMarkers => {
  const local = [...row.markers.local];
  const pullRequests = [...row.markers.pullRequests];
  const jiraIssues = [...row.markers.jiraIssues];
  for (const link of row.links.filter((item) => item.detachedAt === null)) {
    const unknown = { key: link.key, latest: null, latestSuccessful: null };
    if (link.kind === 'branch' && !local.some((marker) => marker.key === link.key)) {
      local.push({ ...unknown, checkoutPath: null, lastSessionActivityAt: null, via: 'branch-link' });
    }
    if (link.kind === 'pull-request' && !pullRequests.some((marker) => marker.key === link.key)) {
      pullRequests.push({ ...unknown, mergeable: null, mergeStateStatus: null, role: null });
    }
    if (link.kind === 'jira-issue' && !jiraIssues.some((marker) => marker.key === link.key)) {
      jiraIssues.push(unknown);
    }
  }
  return { local, pullRequests, jiraIssues };
};

export const acknowledgedRemainderCopy = (remainders: readonly WorkThreadRemainder[]): readonly string[] => {
  const summaries = remainders.map((item) =>
    `${remainderCopy(item)} · ${item.key} · ${item.observedAt ?? 'date unknown'}`.slice(0, 512),
  );
  return summaries.length <= 16
    ? summaries
    : [
        ...summaries.slice(0, 15),
        `${summaries.length - 15} additional remainders shown in the confirmation were acknowledged.`,
      ];
};

/** A checkout read as gone from disk whose last successful read still held local work. */
const isLostCheckout = (remainder: WorkThreadRemainder): boolean =>
  remainder.kind === 'source-unavailable' && remainder.source === 'local' && remainder.outcome === 'missing';
const LOST_CHECKOUT_COPY = 'Checkout gone from disk · local work was last seen there';

export const remainderCopy = (remainder: WorkThreadRemainder): string => {
  switch (remainder.kind) {
    case 'native-request':
      return `Native request: ${remainder.request.text}${remainder.request.state === 'uncertain' ? ' (answer unknown)' : ''}`;
    case 'local-files':
      return `Local: ${remainder.modified ?? 'unknown'} modified · ${remainder.staged ?? 'unknown'} staged · ${remainder.untracked ?? 'unknown'} untracked`;
    case 'unpushed-commits':
      return `${remainder.count} unpushed ${remainder.count === 1 ? 'commit' : 'commits'}`;
    case 'running-session':
      return `${remainder.count} ${remainder.count === 1 ? 'session' : 'sessions'} still running`;
    case 'merge-conflict':
      return `Conflicts with ${remainder.baseRef ?? 'the PR base (unknown)'}`;
    case 'behind-base':
      return `Behind ${remainder.baseRef ?? 'the PR base (unknown)'}`;
    case 'changes-requested':
      return 'Review changes to address';
    case 'failing-checks':
      return 'Checks failing';
    case 'pending-checks':
      return 'Checks pending';
    case 'review-requested':
      return 'A PR waits for your review';
    case 'team-review-requested':
      return 'Your team was asked to review · take it or leave it';
    case 'unresolved-review-threads':
      return `${remainder.count} review ${remainder.count === 1 ? 'thread' : 'threads'} to address`;
    case 'awaiting-review':
      return 'Review requested · waiting on reviewers';
    case 'draft-pr':
      return 'Draft PR';
    case 'ready-to-merge':
      return 'Ready to merge';
    case 'open-pr':
      return 'PR still open';
    case 'jira-open':
      return 'Ticket not done';
    case 'jira-after-merge':
      return 'Merged · the ticket moves on without you';
    case 'source-unavailable':
      if (isLostCheckout(remainder)) {
        return LOST_CHECKOUT_COPY;
      }
      return remainder.outcome === 'truncated'
        ? `${sourceName(remainder.source)} evidence incomplete`
        : `${sourceName(remainder.source)} read: ${remainder.outcome}`;
    case 'source-stale':
      return `${sourceName(remainder.source)} read is stale`;
    case 'source-unknown':
      return `${sourceName(remainder.source)} state is unknown`;
    default: {
      const unsupported: never = remainder;
      throw new Error(`Unsupported remainder: ${String(unsupported)}`);
    }
  }
};

export const sourceName = (source: string): string =>
  ({ local: 'Local', checkouts: 'Local', github: 'GitHub', jira: 'Jira', sessions: 'Sessions' })[source] ?? source;

const counted = (count: number, noun: string): string => `${count} ${count === 1 ? noun : `${noun}s`}`;

/** The last state a source established: its latest read when it succeeded, else its latest success. */
const lastKnownFact = <Observation extends { readonly outcome: string }>(
  fact: WorkThreadFact<Observation>,
): Observation | null => (fact.latest?.outcome === 'observed' ? fact.latest : fact.latestSuccessful);

type PullRequestFact = NonNullable<WorkThreadPullRequestMarker['latest']>;

const pullRequestNumber = (key: string): number | null => {
  const parsed = parseWorkThreadLinkKey('pull-request', key);
  return parsed?.kind === 'pull-request' ? parsed.number : null;
};
const pullRequestRef = (key: string): string => {
  const number = pullRequestNumber(key);
  return number === null ? 'the PR' : `#${number}`;
};
const ticketKey = (key: string): string | null => {
  const parsed = parseWorkThreadLinkKey('jira-issue', key);
  return parsed?.kind === 'jira-issue' ? parsed.key : null;
};

/** The changes git counted; `null` when it reported no count, so a dirty checkout never reads "0 changes". */
const localChangeCount = (remainder: Extract<WorkThreadRemainder, { kind: 'local-files' }>): number | null => {
  const total = (remainder.modified ?? 0) + (remainder.staged ?? 0) + (remainder.untracked ?? 0);
  return total > 0 ? total : null;
};

/**
 * The gesture a remainder asks for, where `remainderCopy` states the fact. A remainder the
 * operator cannot act on (checks running, reviewers reading) names what is moving instead.
 */
export const remainderActionCopy = (remainder: WorkThreadRemainder, row: WorkThreadRow): string => {
  switch (remainder.kind) {
    case 'native-request':
      return `Answer ${harnessName(remainder.request.harness)}: ${remainder.request.text}${remainder.request.state === 'uncertain' ? ' (answer unknown)' : ''}`;
    case 'merge-conflict':
      return `Resolve conflicts on ${pullRequestRef(remainder.key)}`;
    case 'unresolved-review-threads':
      return `Address ${counted(remainder.count, 'review thread')} on ${pullRequestRef(remainder.key)}`;
    case 'changes-requested':
      return `Address requested changes on ${pullRequestRef(remainder.key)}`;
    case 'failing-checks':
      return `Fix checks on ${pullRequestRef(remainder.key)}`;
    case 'review-requested':
      return `Review ${pullRequestRef(remainder.key)}`;
    case 'team-review-requested':
      return `Take or leave the team review on ${pullRequestRef(remainder.key)}`;
    case 'local-files': {
      const count = localChangeCount(remainder);
      const changes = count === null ? 'local changes' : counted(count, 'local change');
      // Once its pull requests are merged or closed, the files are what is left to look at. The list
      // cannot tell a dedicated worktree from a primary clone, so it never asks to remove a checkout.
      return settledPullRequests(row) === null ? `Commit or discard ${changes}` : `Check ${changes}, end follow-up`;
    }
    case 'unpushed-commits':
      // A linked pull request that was never read still exists: only a task without any asks to open one.
      return `Push ${counted(remainder.count, 'commit')}${threadDisplayMarkers(row).pullRequests.length === 0 ? ', open a PR' : ''}`;
    case 'jira-open': {
      const ticket = ticketKey(remainder.key);
      return ticket === null ? 'Update the ticket' : `Update ticket ${ticket}`;
    }
    case 'jira-after-merge': {
      const ticket = ticketKey(remainder.key);
      return ticket === null ? 'The ticket moves on without you' : `Ticket ${ticket} moves on without you`;
    }
    case 'draft-pr': {
      const number = pullRequestNumber(remainder.key);
      return number === null ? 'Finish the draft PR' : `Finish draft #${number}`;
    }
    case 'pending-checks':
      return `Checks running on ${pullRequestRef(remainder.key)}`;
    case 'ready-to-merge':
      return `Merge ${pullRequestRef(remainder.key)}`;
    case 'awaiting-review':
      return `Waiting on reviewers of ${pullRequestRef(remainder.key)}`;
    case 'behind-base':
      return `Update ${pullRequestRef(remainder.key)} from ${remainder.baseRef ?? 'its base'}`;
    case 'open-pr':
      return `Check on ${pullRequestRef(remainder.key)}`;
    case 'running-session':
      return `${counted(remainder.count, 'session')} running`;
    case 'source-unavailable':
    case 'source-stale':
    case 'source-unknown':
      return 'Choose the next step';
    default: {
      const unsupported: never = remainder;
      throw new Error(`Unsupported remainder: ${String(unsupported)}`);
    }
  }
};

export interface ThreadSourceAvailabilityDetail {
  readonly label: string;
  readonly lastRunAt: WorkThreadSourceStatus['lastRunAt'];
  readonly message: string | null;
  readonly source: WorkThreadSourceStatus['source'];
  readonly stale: boolean;
}

const hasEpisodeCheckout = (episodes: readonly WorkThreadEpisode[]): boolean =>
  episodes.some(
    (episode) =>
      (episode.resume.kind === 'cli-resume' && Boolean(episode.resume.cwd?.trim())) ||
      hasEpisodeCheckout(episode.children),
  );

/** Task availability follows its active links and served evidence; the list keeps global status. */
export const taskSourceStatuses = (
  data: Pick<WorkThreadDetailDataset, 'episodes' | 'row' | 'sources'>,
): readonly WorkThreadSourceStatus[] => {
  const relevant = new Set<WorkThreadSourceStatus['source']>();
  const sourceForLink = {
    branch: 'checkouts',
    'jira-issue': 'jira',
    'pull-request': 'github',
    session: 'sessions',
  } as const;
  for (const link of data.row.links) {
    if (link.detachedAt === null) {
      relevant.add(sourceForLink[link.kind]);
    }
  }
  if (data.row.markers.local.length > 0 || hasEpisodeCheckout(data.episodes)) {
    relevant.add('checkouts');
  }
  if (data.row.markers.pullRequests.length > 0) {
    relevant.add('github');
  }
  if (data.row.markers.jiraIssues.length > 0) {
    relevant.add('jira');
  }
  if (
    data.episodes.length > 0 ||
    data.row.sessionCount > 0 ||
    data.row.delegatedSessionCount > 0 ||
    data.row.runningSessions > 0
  ) {
    relevant.add('sessions');
  }
  return data.sources.filter((status) => relevant.has(status.source));
};

/** The summary names unavailable sources; partial session coverage stays in on-demand details. */
export const threadSourceAvailability = (
  sources: readonly WorkThreadSourceStatus[],
  now: string,
  timeZone: string,
): { readonly summary: string; readonly details: readonly ThreadSourceAvailabilityDetail[] } => {
  const details: ThreadSourceAvailabilityDetail[] = [];
  const summaries: string[] = [];
  for (const status of sources) {
    const stale =
      status.lastRunAt !== null && Date.parse(now) - Date.parse(status.lastRunAt) > WORK_THREAD_STALE_AFTER_MS;
    if (status.state === 'ok' && status.lastRunAt !== null && !stale) {
      continue;
    }
    const labels: Record<WorkThreadSourceStatus['state'], string> = {
      ok: stale ? 'read is stale' : 'read date unknown',
      'never-run': 'not connected',
      disabled: 'disabled',
      unavailable: 'unavailable',
      unauthenticated: 'sign-in required',
      failed: 'read failed',
      truncated: 'evidence incomplete',
    };
    const label = labels[status.state];
    details.push({ source: status.source, label, message: status.message, lastRunAt: status.lastRunAt, stale });
    if (status.source !== 'sessions' || status.state !== 'truncated') {
      const date = status.lastRunAt === null ? '' : ` ${threadDate(status.lastRunAt, timeZone)}`;
      summaries.push(`${sourceName(status.source)} ${label}${date}`);
    }
  }
  return { summary: summaries.join(' · '), details };
};

export const remainderEvidenceCopy = (remainder: WorkThreadRemainder, timeZone: string): string =>
  sourceName(remainder.source) +
  ' · ' +
  (remainder.observedAt === null ? 'date unknown' : threadDate(remainder.observedAt, timeZone));

const sessionSourceRemainder = (
  row: WorkThreadRow,
  sources: readonly WorkThreadSourceStatus[],
  now: string,
): WorkThreadRemainder | null => {
  const link = row.links.find((item) => item.kind === 'session' && item.detachedAt === null);
  if (!link && row.sessionCount === 0 && row.delegatedSessionCount === 0) {
    return null;
  }
  const source = sources.find((item) => item.source === 'sessions');
  if (!source) {
    return { key: link?.key ?? row.thread.threadId, source: 'sessions', observedAt: null, kind: 'source-unknown' };
  }
  const evidence = { key: link?.key ?? row.thread.threadId, source: 'sessions' as const, observedAt: source.lastRunAt };
  if (source.state !== 'ok') {
    return { ...evidence, kind: 'source-unavailable', outcome: source.state };
  }
  if (source.lastRunAt === null) {
    return { ...evidence, kind: 'source-unknown' };
  }
  return Date.parse(now) - Date.parse(source.lastRunAt) > WORK_THREAD_STALE_AFTER_MS
    ? { ...evidence, kind: 'source-stale' }
    : null;
};

/** The pull requests last known in one end state, in words; nothing when there is none. */
const settledPullRequestsCopy = (row: WorkThreadRow, state: 'MERGED' | 'CLOSED'): string | null => {
  const numbers = row.markers.pullRequests.flatMap((marker) => {
    const fact = lastKnownFact(marker);
    return fact?.state === state ? [fact.number] : [];
  });
  const verb = state === 'MERGED' ? 'merged' : 'closed without merge';
  const [only] = numbers;
  if (only === undefined) {
    return null;
  }
  return numbers.length === 1 ? `PR #${only} ${verb}` : `${numbers.length} PRs ${verb}`;
};

/**
 * The pull requests whose GitHub read is not current (never read, failed or aged). What was last
 * known of them is not a fact to act on: a merge is terminal, everything else may have changed.
 */
const unreadPullRequestKeys = (remainders: readonly WorkThreadRemainder[]): ReadonlySet<string> =>
  new Set(
    remainders.flatMap((remainder) =>
      remainder.source === 'github' && isUnreadRemainder(remainder) ? [remainder.key] : [],
    ),
  );

const hasUnreadSource = (remainders: readonly WorkThreadRemainder[], source: WorkThreadRemainder['source']): boolean =>
  remainders.some((remainder) => isUnreadRemainder(remainder) && remainder.source === source);

/**
 * What the disk holds of a settled task, from observations only; nothing when no checkout is known.
 * Work last seen in a checkout that is gone leads: it is the one thing an end could lose.
 */
const settledDiskCopy = (row: WorkThreadRow, remainders: readonly WorkThreadRemainder[]): string | null => {
  if (remainders.some(isLostCheckout)) {
    return 'checkout gone from disk, local work was last seen there';
  }
  const local = row.markers.local;
  if (local.some((marker) => marker.latest?.outcome === 'observed')) {
    return 'checkout still on disk';
  }
  if (local.length > 0 && local.every((marker) => marker.latest?.outcome === 'missing')) {
    return 'checkout gone from disk';
  }
  return hasUnreadSource(remainders, 'local') ? 'checkout not read on this machine' : null;
};

/** The unread sources a suggested end names after the disk, which speaks for the local source. */
const SETTLED_UNREAD_SOURCES = [
  { source: 'sessions', copy: 'sessions not fully read' },
  { source: 'jira', copy: 'ticket not read' },
  { source: 'github', copy: 'pull request read not current' },
] as const;

/** An end is suggested from known facts; every source that stayed unread is named beside them. */
const settledSituationWords = (
  row: WorkThreadRow,
  reason: 'merged-complete' | 'closed-unmerged',
  remainders: readonly WorkThreadRemainder[],
): { readonly headline: string; readonly caption: string } => {
  const disk = settledDiskCopy(row, remainders);
  // A merge may sit beside attempts closed without merge: the end rests on both, so both are named.
  const pullRequests = (reason === 'merged-complete' ? (['MERGED', 'CLOSED'] as const) : (['CLOSED'] as const)).flatMap(
    (state) => settledPullRequestsCopy(row, state) ?? [],
  );
  const facts = [
    ...pullRequests,
    ...(disk ? [disk] : []),
    ...SETTLED_UNREAD_SOURCES.flatMap(({ source, copy }) => (hasUnreadSource(remainders, source) ? [copy] : [])),
  ];
  return {
    // The list cannot tell a dedicated worktree from a primary clone, so the gesture never removes a checkout.
    headline: 'End follow-up',
    caption: reason === 'merged-complete' ? `${facts.join(' · ')}. Deployment is not established.` : facts.join(' · '),
  };
};

/** The headline is the gesture; an unread source is never one, so it stays in the caption. */
const situationWords = (
  row: WorkThreadRow,
  situation: WorkThreadSituation,
  timeZone: string,
): { readonly headline: string; readonly caption: string } => {
  switch (situation.reason) {
    case 'follow-up-ended':
      return {
        headline: 'You ended this follow-up',
        caption: row.afterDone
          ? `${row.afterDone.count} newer observations · follow-up stays done`
          : 'History and links stay available.',
      };
    case 'explicit-wait':
      return {
        headline: row.thread.waitingFor ?? 'Waiting for a response',
        caption: 'No session needs to keep running while you wait.',
      };
    case 'no-remainder':
      return {
        headline: 'End follow-up',
        caption:
          row.thread.intent === 'review'
            ? 'The review is done. Nothing known is left.'
            : 'An analysis can be enough. No branch, PR or ticket is required.',
      };
    case 'merged-complete':
    case 'closed-unmerged':
      return settledSituationWords(row, situation.reason, situation.remainders);
    case 'next-step':
      return { headline: 'Choose the next step', caption: 'Follow-up stays yours to end' };
    default: {
      const primary = situation.remainders.find((remainder) => remainder.kind === situation.reason);
      if (primary === undefined) {
        // A running session always carries its own remainder: without one the situation is not
        // the one `deriveWorkThreadSituation` produced, and no copy is invented for it.
        if (situation.reason === 'running-session') {
          throw new Error('A running-session situation carries no running-session remainder.');
        }
        return { headline: 'Choose the next step', caption: 'Follow-up stays yours to end' };
      }
      // A step read from a pull request whose read is not current is not a gesture to offer: the
      // unread source is named instead, as when it ranks the task by itself.
      const notRead =
        primary.source === 'github' && !isUnreadRemainder(primary)
          ? situation.remainders.find(
              (remainder) =>
                remainder.source === 'github' && isUnreadRemainder(remainder) && remainder.key === primary.key,
            )
          : undefined;
      if (notRead !== undefined) {
        return {
          headline: 'Choose the next step',
          caption: `${remainderCopy(notRead)} · ${remainderEvidenceCopy(notRead, timeZone)}`,
        };
      }
      const evidence = remainderEvidenceCopy(primary, timeZone);
      return isUnreadRemainder(primary)
        ? { headline: 'Choose the next step', caption: `${remainderCopy(primary)} · ${evidence}` }
        : { headline: remainderActionCopy(primary, row), caption: evidence };
    }
  }
};

export const threadSituationCopy = (
  row: WorkThreadRow,
  now: string,
  sources: readonly WorkThreadSourceStatus[],
  timeZone = 'UTC',
) => {
  const sessionRemainder = sessionSourceRemainder(row, sources, now);
  const situation = deriveWorkThreadSituation(row, now, sessionRemainder ? [sessionRemainder] : []);
  const label = {
    'to-resume': 'To resume',
    'in-progress': 'In progress',
    'ready-to-close': 'Ready to close',
    waiting: 'Waiting',
    undecided: 'To decide',
    done: 'Done',
  }[situation.hint];
  const { headline, caption } = situationWords(row, situation, timeZone);
  // The list repeats no source or date (the timeline shows when); it keeps only explanations.
  const explained = ['follow-up-ended', 'explicit-wait', 'no-remainder', 'merged-complete', 'closed-unmerged'].includes(
    situation.reason,
  );
  return { ...situation, label, headline, caption, note: explained ? caption : null };
};

/** Linked sessions as this machine read them: none read never means none ran elsewhere. */
export const threadSessionsLabel = (row: WorkThreadRow): string => {
  if (row.sessionCount === 0 && row.delegatedSessionCount === 0) {
    return 'No sessions on this machine';
  }
  const delegated = row.delegatedSessionCount > 0 ? ` · ${row.delegatedSessionCount} delegated` : '';
  return `${counted(row.sessionCount, 'session')}${delegated}`;
};

const localBranch = (marker: WorkThreadMarkers['local'][number]): string | null => {
  const observed = lastKnownFact(marker)?.branch ?? marker.latest?.branch;
  if (observed) {
    return observed;
  }
  const parsed = parseWorkThreadLinkKey('branch', marker.key);
  return parsed?.kind === 'branch' ? parsed.ref : null;
};

/**
 * The second line of a compact row: its pull requests (or, without any, its branch), its sessions
 * and what it combines. A linked pull request that was never read stays named, as unknown.
 */
export const threadRowMeta = (row: WorkThreadRow): string => {
  const { pullRequests, local } = threadDisplayMarkers(row);
  const parts: string[] = [];
  if (pullRequests.length > 2) {
    parts.push(`${pullRequests.length} pull requests`);
  } else {
    for (const marker of pullRequests) {
      const number = lastKnownFact(marker)?.number ?? pullRequestNumber(marker.key);
      parts.push(`PR ${number === null ? '' : `#${number} `}${pullRequestBadge(marker).label.toLowerCase()}`);
    }
  }
  if (pullRequests.length === 0) {
    const branch = local.map(localBranch).find((name) => name !== null);
    if (branch) {
      parts.push(branch);
    }
  }
  parts.push(threadSessionsLabel(row));
  if (row.combinedThreads.length > 0) {
    parts.push(`combines ${row.combinedThreads.length + 1} tasks`);
  }
  return parts.join(' · ');
};

export const THREAD_BANDS = [
  { band: 'yours', label: 'Yours', note: 'An answer, a fix or a merge waits on you' },
  { band: 'in-flight', label: 'In flight', note: 'Recent activity, nothing waits on you' },
  { band: 'to-tidy', label: 'To tidy', note: 'Delivered, closed or finished: tidy up and end the follow-up' },
  { band: 'dormant', label: 'Dormant', note: 'No activity for 7 days or more' },
  { band: 'done', label: 'Done', note: 'Follow-up ended' },
] as const;
export type ThreadBand = (typeof THREAD_BANDS)[number]['band'];

/** The band the URL filters on; an unknown value filters nothing. */
export const threadBandFilter = (search: URLSearchParams): ThreadBand | null => {
  const value = search.get('band');
  return THREAD_BANDS.find((item) => item.band === value)?.band ?? null;
};

const elapsedBetween = (at: string, now: string): number => {
  const elapsed = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(elapsed)) {
    throw new RangeError('Two valid instants are required.');
  }
  return elapsed;
};

/**
 * Whose move it is, first match first: an end, something left behind, silence, a step that waits
 * on the operator. Any other recent task is in flight: nothing known waits on the operator.
 */
export const threadBand = (
  row: WorkThreadRow,
  situation: Pick<WorkThreadSituation, 'hint' | 'reason' | 'remainders'>,
  now: string,
): ThreadBand => {
  if (situation.hint === 'done') {
    return 'done';
  }
  if (situation.hint === 'ready-to-close') {
    return 'to-tidy';
  }
  // Silence is measured from the later of the last session activity and the source's own date
  // for the current wait: a commit made today is activity, whatever the age of the last session.
  const since = threadWaitSince(row, situation).at;
  const lastMove = Date.parse(since) > Date.parse(row.lastActivityAt) ? since : row.lastActivityAt;
  const stale = elapsedBetween(lastMove, now) > WORK_THREAD_STALE_AFTER_MS;
  const leftBehind = situation.reason === 'local-files' || situation.reason === 'jira-open' || stale;
  if (leftBehind && settledPullRequests(row) !== null) {
    return 'to-tidy';
  }
  if (stale) {
    return 'dormant';
  }
  return situation.hint === 'to-resume' ? 'yours' : 'in-flight';
};

export interface ThreadWaitSince {
  readonly at: string;
  readonly basis: 'asked' | 'pull-request' | 'merged' | 'closed' | 'last-commit' | 'activity';
}

const instantAtEdge = (
  instants: readonly (string | null | undefined)[],
  edge: 'earliest' | 'latest',
): string | null => {
  const direction = edge === 'latest' ? 1 : -1;
  let found: string | null = null;
  for (const at of instants) {
    if (typeof at === 'string' && (found === null || direction * (Date.parse(at) - Date.parse(found)) > 0)) {
      found = at;
    }
  }
  return found;
};

const sourceWaitStart = (
  row: WorkThreadRow,
  { reason, remainders }: Pick<WorkThreadSituation, 'reason' | 'remainders'>,
): { readonly at: string | null; readonly basis: ThreadWaitSince['basis'] } | null => {
  const pullRequests = row.markers.pullRequests.flatMap((marker) => {
    const fact = lastKnownFact(marker);
    return fact === null ? [] : [{ key: marker.key, fact }];
  });
  if (reason === 'native-request') {
    const asked = remainders.flatMap((item) => (item.kind === 'native-request' ? [item.request.askedAt] : []));
    return { at: instantAtEdge(asked, 'earliest'), basis: 'asked' };
  }
  if (reason === 'merged-complete') {
    return {
      at: instantAtEdge(
        pullRequests.map(({ fact }) => fact.mergedAt),
        'latest',
      ),
      basis: 'merged',
    };
  }
  if (reason === 'closed-unmerged') {
    return {
      at: instantAtEdge(
        pullRequests.map(({ fact }) => fact.closedAt),
        'latest',
      ),
      basis: 'closed',
    };
  }
  const primary = remainders.find((item) => item.kind === reason);
  if (primary?.source === 'github') {
    const milestones = row.marks.flatMap((mark) =>
      mark.fact !== null && mark.source?.key === primary.key ? [mark.at] : [],
    );
    const created = pullRequests.find(({ key }) => key === primary.key)?.fact.createdAt;
    return { at: instantAtEdge(milestones, 'latest') ?? created ?? null, basis: 'pull-request' };
  }
  if (primary !== undefined && (reason === 'local-files' || reason === 'unpushed-commits')) {
    const commits = row.markers.local.flatMap((marker) =>
      marker.key === primary.key && marker.latest?.outcome === 'observed' ? [marker.latest.lastCommitAt] : [],
    );
    return { at: instantAtEdge(commits, 'latest'), basis: 'last-commit' };
  }
  return null;
};

/**
 * When the current wait began, from the sources' own dates (a question asked, a merge, a milestone,
 * a commit), never from the date the product observed them. Without one, the last activity.
 */
export const threadWaitSince = (
  row: WorkThreadRow,
  situation: Pick<WorkThreadSituation, 'reason' | 'remainders'>,
): ThreadWaitSince => {
  const start = sourceWaitStart(row, situation);
  return start === null || start.at === null
    ? { at: row.lastActivityAt, basis: 'activity' }
    : { at: start.at, basis: start.basis };
};

const WAIT_SINCE_LABELS = {
  asked: 'Asked',
  'pull-request': 'PR status since',
  merged: 'Merged',
  closed: 'Closed',
  'last-commit': 'Last commit',
  activity: 'Last activity',
} as const satisfies Record<ThreadWaitSince['basis'], string>;
export const threadWaitSinceLabel = (basis: ThreadWaitSince['basis']): string => WAIT_SINCE_LABELS[basis];

/** Compact elapsed time: "now", "12 min", "5 h", "3 d", "6 w". A date in the future reads "now". */
export const threadAge = (at: string, now: string): string => {
  const minutes = Math.floor(elapsedBetween(at, now) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days} d` : `${Math.floor(days / 7)} w`;
};

/** Same group shape as `groupThreadRowsBySituation`, so one list renders either grouping. */
export interface ThreadBandGroup {
  readonly band: ThreadBand;
  readonly label: string;
  readonly note: string;
  readonly project: string;
  readonly tasks: WorkThreadRow[];
}

/**
 * Tasks by band, in band order. Inside a band the longest wait leads, so the order follows the
 * sources' dates and not the order rows were collected in; dormant tasks and ended follow-ups
 * show the most recent first.
 */
export const groupThreadRowsByBand = (
  rows: readonly WorkThreadRow[],
  bandOf: (row: WorkThreadRow) => ThreadBand,
  sinceOf: (row: WorkThreadRow) => string,
): ThreadBandGroup[] => {
  const placed = rows.map((row) => ({ row, band: bandOf(row), since: Date.parse(sinceOf(row)) }));
  return THREAD_BANDS.flatMap(({ band, label, note }) => {
    const direction = band === 'dormant' || band === 'done' ? -1 : 1;
    const tasks = placed
      .filter((item) => item.band === band)
      .sort(
        (left, right) =>
          direction * (left.since - right.since) || left.row.thread.threadId.localeCompare(right.row.thread.threadId),
      )
      .map((item) => item.row);
    return tasks.length ? [{ band, project: label, label, note, tasks }] : [];
  });
};

export const threadBandCounts = (
  rows: readonly WorkThreadRow[],
  bandOf: (row: WorkThreadRow) => ThreadBand,
): Record<ThreadBand, number> => {
  const counts: Record<ThreadBand, number> = { yours: 0, 'in-flight': 0, 'to-tidy': 0, dormant: 0, done: 0 };
  for (const row of rows) {
    counts[bandOf(row)] += 1;
  }
  return counts;
};

export const THREAD_LIFECYCLE_STEPS = [
  { key: 'sessions', short: 'Sess', name: 'Sessions' },
  { key: 'push', short: 'Push', name: 'Push' },
  { key: 'pull-request', short: 'PR', name: 'Pull request' },
  { key: 'checks', short: 'CI', name: 'Checks' },
  { key: 'review', short: 'Rev', name: 'Review' },
  { key: 'merge', short: 'Merge', name: 'Merge' },
  { key: 'disk', short: 'Disk', name: 'Disk' },
  { key: 'ticket', short: 'Ticket', name: 'Ticket' },
] as const;
export type ThreadLifecycleKey = (typeof THREAD_LIFECYCLE_STEPS)[number]['key'];
export type ThreadLifecycleState = 'done' | 'yours' | 'running' | 'failed' | 'upcoming' | 'unread' | 'none';
export interface ThreadLifecycleStep {
  /** A short plain phrase for the fact that decided the state. */
  readonly detail: string;
  readonly key: ThreadLifecycleKey;
  readonly name: string;
  readonly short: string;
  readonly state: ThreadLifecycleState;
}

interface LifecycleFact {
  readonly detail: string;
  readonly state: ThreadLifecycleState;
}
interface LifecycleContext {
  /** Observed markers plus the links never read, so an unread link still holds its step. */
  readonly display: WorkThreadMarkers;
  readonly remainders: readonly WorkThreadRemainder[];
  readonly row: WorkThreadRow;
}

/** Worst first: when several facts apply to one step, the first state of this order wins. */
const LIFECYCLE_SEVERITY: readonly ThreadLifecycleState[] = [
  'failed',
  'yours',
  'running',
  'unread',
  'upcoming',
  'done',
  'none',
];
/** The worst of the facts that apply, the first one among equals; `otherwise` when none applies. */
const worstFact = (facts: readonly LifecycleFact[], otherwise: LifecycleFact): LifecycleFact => {
  const [first, ...others] = facts;
  return first === undefined
    ? otherwise
    : others.reduce(
        (worst, fact) =>
          LIFECYCLE_SEVERITY.indexOf(fact.state) < LIFECYCLE_SEVERITY.indexOf(worst.state) ? fact : worst,
        first,
      );
};

/** The known remainders that speak for a step; they are the single source of what waits. */
const projectedFacts = (
  remainders: readonly WorkThreadRemainder[],
  project: (remainder: WorkThreadRemainder) => LifecycleFact | null,
): readonly LifecycleFact[] =>
  remainders.flatMap((remainder) => {
    const fact = project(remainder);
    return fact === null ? [] : [fact];
  });

const pullRequestNotRead = (key: string): LifecycleFact => ({
  state: 'unread',
  detail: `${pullRequestRef(key)} not read`,
});

/**
 * The known remainders of pull requests that speak for a step. One read from a pull request whose
 * read is not current shows as not read: its last known fact is not what waits now.
 */
const projectedPullRequestFacts = (
  { remainders }: LifecycleContext,
  project: (remainder: WorkThreadRemainder) => LifecycleFact | null,
): readonly LifecycleFact[] => {
  const unread = unreadPullRequestKeys(remainders);
  return remainders.flatMap((remainder) => {
    const fact = project(remainder);
    if (fact === null) {
      return [];
    }
    return [remainder.source === 'github' && unread.has(remainder.key) ? pullRequestNotRead(remainder.key) : fact];
  });
};

/** What the pull request steps show while the task has no pull request. */
const withoutPullRequestFact = ({ display }: LifecycleContext): LifecycleFact =>
  display.local.length > 0
    ? { state: 'upcoming', detail: 'No pull request yet' }
    : { state: 'none', detail: 'No pull request' };

/**
 * One base fact per pull request for the steps a pull request goes through. A merged or closed
 * pull request, one never read and someone else's read the same on each of them; `ownOpen` says
 * what the operator's own open pull request shows on the step. A merge is terminal and counts by
 * its last known state; any other state whose read is not current shows as not read.
 */
const pullRequestBaseFacts = (
  { display, remainders }: LifecycleContext,
  ownOpen: (fact: PullRequestFact, key: string) => LifecycleFact,
): readonly LifecycleFact[] => {
  const unread = unreadPullRequestKeys(remainders);
  return display.pullRequests.map((marker): LifecycleFact => {
    const fact = lastKnownFact(marker);
    if (!fact?.state) {
      return { state: 'unread', detail: `State of ${pullRequestRef(marker.key)} unknown` };
    }
    if (fact.state === 'MERGED') {
      return { state: 'done', detail: 'Merged' };
    }
    if (unread.has(marker.key)) {
      return pullRequestNotRead(marker.key);
    }
    if (fact.state === 'CLOSED') {
      return { state: 'none', detail: 'Closed without merge' };
    }
    return marker.role === 'review-requested' || marker.role === 'team-review-requested'
      ? { state: 'none', detail: "Someone else's pull request" }
      : ownOpen(fact, marker.key);
  });
};

const sessionsLifecycleFact = ({ row, remainders }: LifecycleContext): LifecycleFact => {
  if (row.sessionCount + row.delegatedSessionCount === 0) {
    return row.links.some((link) => link.kind === 'session' && link.detachedAt === null)
      ? { state: 'unread', detail: 'Linked sessions could not be read' }
      : { state: 'none', detail: 'No sessions on this machine' };
  }
  const partlyRead =
    row.nativeRequestCoverage === 'partial' ||
    remainders.some((remainder) => isUnreadRemainder(remainder) && remainder.source === 'sessions');
  const base: LifecycleFact = partlyRead
    ? { state: 'unread', detail: `${threadSessionsLabel(row)} · not fully read` }
    : { state: 'done', detail: threadSessionsLabel(row) };
  const waits = projectedFacts(remainders, (remainder) => {
    switch (remainder.kind) {
      case 'running-session':
        return { state: 'running', detail: remainderActionCopy(remainder, row) };
      case 'native-request':
        return { state: 'yours', detail: 'An agent waits for your answer' };
      default:
        return null;
    }
  });
  return worstFact([...waits, base], base);
};

const pushLifecycleFact = ({ row, remainders, display }: LifecycleContext): LifecycleFact => {
  const unpushed = remainders.reduce((sum, item) => sum + (item.kind === 'unpushed-commits' ? item.count : 0), 0);
  if (unpushed > 0) {
    return { state: 'yours', detail: `${counted(unpushed, 'commit')} to push` };
  }
  if (row.markers.pullRequests.some((marker) => lastKnownFact(marker) !== null)) {
    // The pull request is what establishes the push, not a checkout read.
    return { state: 'done', detail: 'Pushed · a pull request exists' };
  }
  if (display.local.length === 0) {
    return display.pullRequests.length > 0
      ? { state: 'unread', detail: 'Push state unknown' }
      : { state: 'none', detail: 'No branch or pull request' };
  }
  // A checkout never read, or whose read failed, may hold commits: another one, pushed, says nothing of it.
  const unread = display.local.some(
    (marker) => marker.latest?.outcome !== 'observed' && marker.latest?.outcome !== 'missing',
  );
  if (unread) {
    return { state: 'unread', detail: 'Checkout not read on this machine' };
  }
  const onDisk = display.local.flatMap((marker) => (marker.latest?.outcome === 'observed' ? [marker.latest] : []));
  if (onDisk.length === 0) {
    return { state: 'unread', detail: 'Checkout gone from disk · push state unknown' };
  }
  if (onDisk.every((fact) => fact.ahead === 0)) {
    return { state: 'done', detail: 'Branch pushed' };
  }
  return onDisk.some((fact) => fact.upstream === null)
    ? { state: 'upcoming', detail: 'Branch not pushed yet' }
    : { state: 'unread', detail: 'Push state unknown' };
};

const PULL_REQUEST_STATE_WORDS = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed without merge' } as const;

const pullRequestLifecycleFact = (context: LifecycleContext): LifecycleFact => {
  const drafts = projectedPullRequestFacts(context, (remainder) => {
    if (remainder.kind !== 'draft-pr') {
      return null;
    }
    const number = pullRequestNumber(remainder.key);
    return { state: 'yours', detail: number === null ? 'Draft pull request' : `Draft #${number}` };
  });
  const known: string[] = [];
  const unread: LifecycleFact[] = [];
  const notCurrent = unreadPullRequestKeys(context.remainders);
  for (const marker of context.display.pullRequests) {
    const state = lastKnownFact(marker)?.state;
    if (state && state !== 'MERGED' && notCurrent.has(marker.key)) {
      unread.push(pullRequestNotRead(marker.key));
    } else if (state) {
      known.push(`${pullRequestRef(marker.key)} ${PULL_REQUEST_STATE_WORDS[state]}`);
    } else {
      unread.push({ state: 'unread', detail: `State of ${pullRequestRef(marker.key)} unknown` });
    }
  }
  const [only] = known;
  const read: readonly LifecycleFact[] =
    only === undefined
      ? []
      : [{ state: 'done', detail: known.length === 1 ? only : counted(known.length, 'pull request') }];
  return worstFact([...drafts, ...unread, ...read], withoutPullRequestFact(context));
};

const checksLifecycleFact = (context: LifecycleContext): LifecycleFact =>
  worstFact(
    [
      ...projectedPullRequestFacts(context, (remainder) => {
        switch (remainder.kind) {
          case 'failing-checks':
            return { state: 'failed', detail: `Checks failing on ${pullRequestRef(remainder.key)}` };
          case 'pending-checks':
            return { state: 'running', detail: `Checks running on ${pullRequestRef(remainder.key)}` };
          default:
            return null;
        }
      }),
      ...pullRequestBaseFacts(context, (fact) =>
        fact.checksRollup === 'success'
          ? { state: 'done', detail: 'Checks pass' }
          : { state: 'unread', detail: 'Checks not reported' },
      ),
    ],
    withoutPullRequestFact(context),
  );

const ownOpenReviewFact = (fact: PullRequestFact): LifecycleFact => {
  if (fact.reviewDecision === 'APPROVED') {
    return { state: 'done', detail: 'Approved' };
  }
  return fact.draft === true
    ? { state: 'upcoming', detail: 'Draft · review not started' }
    : { state: 'none', detail: 'No review required' };
};

const reviewLifecycleFact = (context: LifecycleContext): LifecycleFact =>
  worstFact(
    [
      ...projectedPullRequestFacts(context, (remainder) => {
        switch (remainder.kind) {
          case 'changes-requested':
            return { state: 'yours', detail: `Changes requested on ${pullRequestRef(remainder.key)}` };
          case 'unresolved-review-threads':
            return {
              state: 'yours',
              detail: `${counted(remainder.count, 'review thread')} to address on ${pullRequestRef(remainder.key)}`,
            };
          case 'review-requested':
            return { state: 'yours', detail: `Your review is requested on ${pullRequestRef(remainder.key)}` };
          case 'awaiting-review':
            return { state: 'running', detail: 'Waiting on reviewers' };
          case 'team-review-requested':
            return { state: 'upcoming', detail: 'Your team was asked · take it or leave it' };
          default:
            return null;
        }
      }),
      ...pullRequestBaseFacts(context, ownOpenReviewFact),
    ],
    withoutPullRequestFact(context),
  );

const mergeLifecycleFact = (context: LifecycleContext): LifecycleFact =>
  worstFact(
    [
      ...projectedPullRequestFacts(context, (remainder) => {
        switch (remainder.kind) {
          case 'merge-conflict':
            return { state: 'failed', detail: `Conflicts on ${pullRequestRef(remainder.key)}` };
          case 'ready-to-merge':
            return { state: 'yours', detail: `${pullRequestRef(remainder.key)} ready to merge` };
          default:
            return null;
        }
      }),
      ...pullRequestBaseFacts(context, (_fact, key) => ({
        state: 'upcoming',
        detail: context.remainders.some((remainder) => remainder.kind === 'behind-base' && remainder.key === key)
          ? 'Behind its base'
          : 'Not merged yet',
      })),
    ],
    withoutPullRequestFact(context),
  );

const diskLifecycleFact = ({ row, remainders, display }: LifecycleContext): LifecycleFact => {
  const settled = settledPullRequests(row) !== null;
  // Only files wait on the operator. A checkout on disk asks nothing by itself: the list cannot
  // tell a dedicated worktree from a primary clone.
  const waits = projectedFacts(remainders, (remainder) => {
    if (isLostCheckout(remainder)) {
      return { state: 'unread', detail: LOST_CHECKOUT_COPY };
    }
    if (remainder.kind !== 'local-files') {
      return null;
    }
    const count = localChangeCount(remainder);
    return {
      state: 'yours',
      detail: count === null ? 'Local changes on disk' : `${counted(count, 'local change')} on disk`,
    };
  });
  const checkouts = display.local.map((marker): LifecycleFact => {
    if (marker.latest?.outcome === 'observed') {
      return { state: 'upcoming', detail: settled ? 'Checkout still on disk' : 'Checkout on disk' };
    }
    return marker.latest?.outcome === 'missing'
      ? { state: 'done', detail: 'Checkout gone from disk' }
      : { state: 'unread', detail: 'Checkout not read on this machine' };
  });
  // Without any checkout marker there is no disk to speak of, whatever a remainder says.
  return worstFact(checkouts.length > 0 ? [...waits, ...checkouts] : [], {
    state: 'none',
    detail: 'No checkout linked',
  });
};

const ticketLifecycleFact = ({ remainders, display }: LifecycleContext): LifecycleFact => {
  const waits = projectedFacts(remainders, (remainder) => {
    switch (remainder.kind) {
      case 'jira-open':
        return { state: 'yours', detail: `${ticketKey(remainder.key) ?? 'Ticket'} to update` };
      case 'jira-after-merge':
        return { state: 'running', detail: 'Moves on without you' };
      default:
        return null;
    }
  });
  const tickets = display.jiraIssues.map((marker): LifecycleFact => {
    const name = ticketKey(marker.key) ?? 'Ticket';
    const fact = lastKnownFact(marker);
    if (fact?.statusCategory === 'done') {
      return { state: 'done', detail: `${name} done` };
    }
    const unread = remainders.some(
      (remainder) => isUnreadRemainder(remainder) && remainder.source === 'jira' && remainder.key === marker.key,
    );
    // An unfinished ticket that is nobody's step yet: its pull request is still open.
    return fact === null || unread
      ? { state: 'unread', detail: `${name} state unknown` }
      : { state: 'upcoming', detail: `${name} follows the open pull request` };
  });
  return worstFact(tickets.length > 0 ? [...waits, ...tickets] : [], { state: 'none', detail: 'No ticket' });
};

/**
 * The task's eight fixed positions, from its first session to its ticket. Each state is the worst
 * of the known remainders that speak for the step (what waits, as the situation ranks it) and of
 * the base state its markers establish; a source that was not read shows as unread, never as done.
 */
export const threadLifecycle = (
  row: WorkThreadRow,
  remainders: readonly WorkThreadRemainder[],
): readonly ThreadLifecycleStep[] => {
  const context: LifecycleContext = { row, remainders, display: threadDisplayMarkers(row) };
  const facts: Record<ThreadLifecycleKey, LifecycleFact> = {
    sessions: sessionsLifecycleFact(context),
    push: pushLifecycleFact(context),
    'pull-request': pullRequestLifecycleFact(context),
    checks: checksLifecycleFact(context),
    review: reviewLifecycleFact(context),
    merge: mergeLifecycleFact(context),
    disk: diskLifecycleFact(context),
    ticket: ticketLifecycleFact(context),
  };
  return THREAD_LIFECYCLE_STEPS.map((step) => ({ ...step, ...facts[step.key] }));
};

/** The rail in words, for assistive technology: "Sessions: 3 sessions; Push: Pushed; …". */
export const threadLifecycleSummary = (steps: readonly ThreadLifecycleStep[]): string =>
  steps.map((step) => `${step.name}: ${step.detail}`).join('; ');

export interface ThreadRecentActivity {
  readonly days: readonly {
    readonly key: string;
    readonly label: string;
    readonly milestones: number;
    readonly sessions: number;
    readonly today: boolean;
  }[];
  readonly description: string;
}

/**
 * Sessions and pull request milestones of the last calendar days, today last. The window is cut
 * from the task timeline, so it cannot exceed the days that timeline always shows.
 */
export const threadRecentActivity = (
  marks: readonly WorkThreadMark[],
  now: string,
  timeZone: string,
  days = THREAD_TIMELINE_MIN_DAYS,
): ThreadRecentActivity => {
  if (!Number.isInteger(days) || days < 1 || days > THREAD_TIMELINE_MIN_DAYS) {
    throw new RangeError(`The activity window is 1 to ${THREAD_TIMELINE_MIN_DAYS} days.`);
  }
  const byDay = bucketThreadMarks(marks, timeZone);
  const window = threadTimeline(now, timeZone)
    .slice(-days)
    .map((day) => {
      const dayMarks = byDay.get(day.key) ?? [];
      return {
        key: day.key,
        label: day.label,
        sessions: dayMarks.filter((mark) => mark.kind === 'session').length,
        milestones: dayMarks.filter((mark) => mark.fact !== null).length,
        today: day.today,
      };
    });
  const sessions = window.reduce((sum, day) => sum + day.sessions, 0);
  const milestones = window.reduce((sum, day) => sum + day.milestones, 0);
  const activeDays = window.filter((day) => day.sessions > 0).length;
  const parts = [
    ...(sessions > 0 ? [`${counted(sessions, 'session')} on ${counted(activeDays, 'day')}`] : []),
    ...(milestones > 0 ? [counted(milestones, 'pull request milestone')] : []),
  ];
  return {
    days: window,
    description: `Last ${counted(days, 'day')}: ${parts.length > 0 ? parts.join(', ') : 'no activity'}`,
  };
};

/** An observed source URL may be opened, but never executable schemes or credentials. */
export const observedWebUrl = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};

export const formatEpisodeDuration = (milliseconds: number): string => {
  if (milliseconds > 0 && milliseconds < 60_000) {
    return '<1 min';
  }
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h${rest > 0 ? ` ${rest}` : ''}`;
};

/** Recorded turn time is never substituted with the first-to-last activity span. */
export const episodeDuration = (entry: WorkThreadEpisode): string =>
  entry.activeMs === null ? '—' : formatEpisodeDuration(entry.activeMs);

export const episodeDurationDetail = (entry: WorkThreadEpisode): string =>
  entry.activeMs === null
    ? 'Duration not recorded for this episode'
    : `${episodeDuration(entry)} recorded for this episode · not the task's lifetime`;

export const episodeSpan = (entry: WorkThreadEpisode): string =>
  entry.spanMs === null ? 'Span unknown' : formatEpisodeDuration(entry.spanMs);

export const episodeSpanContext = (entry: WorkThreadEpisode): string | null => {
  if (
    entry.spanMs === null ||
    entry.activeMs === null ||
    entry.spanMs <= 2 * entry.activeMs ||
    entry.spanMs <= 3_600_000
  ) {
    return null;
  }
  const days = Math.floor(entry.spanMs / 86_400_000);
  if (days > 0) {
    return `over ${days}${days === 1 ? ' day' : ' days'}`;
  }
  return `over ${Math.floor(entry.spanMs / 3_600_000)} h`;
};

export const episodeContext = (episode: WorkThreadEpisode, taskTitle: string): string =>
  [
    `Task: ${taskTitle}`,
    `Session: ${episode.title ?? 'Untitled session'}`,
    episode.firstPrompt ? `Initial request: ${episode.firstPrompt}` : null,
    episode.lastInstruction ? `Last instruction: ${episode.lastInstruction}` : null,
    episode.result ? `What the session left: ${episode.result}` : null,
    episode.question ? `Current question: ${episode.question}` : null,
  ]
    .filter((part) => part !== null)
    .join('\n\n');

export const episodeResumeText = (episode: WorkThreadEpisode, taskTitle: string): string | null =>
  episode.resume.kind === 'cli-resume'
    ? [
        episode.resume.command,
        episode.resume.cwd ? `Working directory: ${episode.resume.cwd}` : null,
        episodeContext(episode, taskTitle),
      ]
        .filter((part) => part !== null)
        .join('\n\n')
    : null;

/** A running hint must never resume a different, completed session. */
export const primaryResumeEpisode = (
  episodes: readonly WorkThreadEpisode[],
  runningCount: number,
  requestSessionKey?: string,
): WorkThreadEpisode | null => {
  const running: WorkThreadEpisode[] = [];
  const visit = (items: readonly WorkThreadEpisode[]): void => {
    for (const episode of items) {
      if (requestSessionKey === undefined ? episode.running === true : episode.linkKey === requestSessionKey) {
        running.push(episode);
      }
      visit(episode.children);
    }
  };
  visit(episodes);
  return (requestSessionKey !== undefined || runningCount === 1) &&
    running.length === 1 &&
    running[0]?.resume.kind === 'cli-resume'
    ? running[0]
    : null;
};

export const threadEventActor = (event: WorkThreadEvent): string => {
  if (event.kind !== 'wait-satisfied' || !event.linkKey) {
    return 'Work event';
  }
  if (parseWorkThreadLinkKey('jira-issue', event.linkKey)) {
    return 'Jira';
  }
  if (parseWorkThreadLinkKey('pull-request', event.linkKey)) {
    return 'GitHub';
  }
  return 'Work event';
};

export const threadContext = (data: WorkThreadDetailDataset): string =>
  [
    data.row.thread.title,
    data.row.thread.objective,
    data.row.thread.note,
    ...data.row.links.filter((link) => link.detachedAt === null).map((link) => link.key),
  ]
    .filter((part) => part !== null)
    .join('\n\n');

const episodeForLink = (episodes: readonly WorkThreadEpisode[], key: string): WorkThreadEpisode | null => {
  for (const episode of episodes) {
    if (episode.linkKey === key) {
      return episode;
    }
    const child = episodeForLink(episode.children, key);
    if (child) {
      return child;
    }
  }
  return null;
};

const eventLinkLabel = (key: string, episodes: readonly WorkThreadEpisode[]): string => {
  if (parseWorkThreadLinkKey('session', key)) {
    const episode = episodeForLink(episodes, key);
    return episode
      ? `${episode.title ?? 'Untitled session'} · ${harnessName(episode.harness)}`
      : 'a session (no longer readable)';
  }
  const pr = parseWorkThreadLinkKey('pull-request', key);
  if (pr?.kind === 'pull-request') {
    return `PR #${pr.number} · ${pr.repository}`;
  }
  const jira = parseWorkThreadLinkKey('jira-issue', key);
  if (jira?.kind === 'jira-issue') {
    return jira.key;
  }
  const branch = parseWorkThreadLinkKey('branch', key);
  return branch?.kind === 'branch' ? branch.ref : 'a source (no longer readable)';
};

export const threadEventCopy = (
  event: WorkThreadEvent,
  episodes: readonly WorkThreadEpisode[],
): { title: string; detail: string | null } => {
  const titles: Record<WorkThreadEvent['kind'], string> = {
    created: 'Task created',
    'follow-state': { done: 'Follow-up ended', waiting: 'Marked as waiting', following: 'Follow-up reopened' }[
      event.toState ?? 'following'
    ],
    'link-added': 'Source linked',
    'link-detached': 'Source detached',
    note: 'Resume note updated',
    renamed: 'Task renamed',
    'wait-satisfied': 'New response observed',
    combined: 'Tasks combined',
    separated: 'Tasks separated',
  };
  const linkLabel = event.linkKey ? eventLinkLabel(event.linkKey, episodes) : null;
  const detail =
    event.kind === 'link-added' || event.kind === 'link-detached' ? linkLabel : (event.reason ?? linkLabel);
  return { title: titles[event.kind], detail };
};

export const threadFactEventCopy = (event: WorkThreadFactEvent): { title: string; detail: string | null } => ({
  title: workThreadFactEventLabel(event),
  detail: event.title,
});

export type ThreadHistoryEntry =
  | { readonly kind: 'session'; readonly at: string; readonly id: string; readonly episode: WorkThreadEpisode }
  | { readonly kind: 'event'; readonly at: string; readonly id: string; readonly event: WorkThreadEvent }
  | { readonly kind: 'fact-event'; readonly at: string; readonly id: string; readonly event: WorkThreadFactEvent };

const visibleThreadEvent = (event: WorkThreadEvent, data: WorkThreadDetailDataset): boolean => {
  if (event.kind === 'created') {
    return data.row.thread.origin !== 'pull-request' && data.row.thread.origin !== 'jira-issue';
  }
  if (event.kind !== 'link-added' || event.linkKey === null) {
    return true;
  }
  const candidates = [...data.row.links, ...data.detachedLinks].filter((link) => link.key === event.linkKey);
  const exact = candidates.filter((link) => link.createdAt === event.at);
  const linksAtEvent =
    exact.length > 0
      ? exact
      : candidates.filter(
          (link) => link.createdAt <= event.at && (link.detachedAt === null || link.detachedAt >= event.at),
        );
  // Missing provenance cannot establish that an event was automatic. Preserve that history.
  return linksAtEvent.length === 0 || linksAtEvent.some((link) => link.provenance === 'user');
};

export const threadHistory = (
  data: WorkThreadDetailDataset,
  sessionsOnly: boolean,
  timeZone: string,
  newestFirst = false,
) => {
  const entries: ThreadHistoryEntry[] = data.episodes.map((entry) => ({
    kind: 'session',
    at: entry.startedAt,
    id: entry.linkKey,
    episode: entry,
  }));
  if (!sessionsOnly) {
    entries.push(
      ...data.events
        .filter((event) => visibleThreadEvent(event, data))
        .map((event): ThreadHistoryEntry => ({ kind: 'event', at: event.at, id: event.eventId, event })),
      ...data.factEvents.map(
        (event): ThreadHistoryEntry => ({
          kind: 'fact-event',
          at: event.at,
          id: ['fact', event.key, event.kind, event.at].join(':'),
          event,
        }),
      ),
    );
  }
  entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  if (newestFirst) {
    entries.reverse();
  }
  const days = new Map<string, ThreadHistoryEntry[]>();
  for (const entry of entries) {
    const key = threadDayKey(entry.at, timeZone);
    const group = days.get(key) ?? [];
    group.push(entry);
    days.set(key, group);
  }
  return [...days].map(([key, items]) => ({ key, entries: items }));
};

export const localCheckoutStatus = (marker: WorkThreadMarkers['local'][number]): string => {
  if (marker.latest?.outcome === 'missing') {
    return 'Absent from disk';
  }
  if (marker.latest?.outcome !== 'observed') {
    return 'Disk state unknown';
  }
  if (marker.latest.dirty === true) {
    return 'On disk · changes';
  }
  if (marker.latest.dirty === false) {
    return 'On disk · clean';
  }
  return 'On disk · state unknown';
};
