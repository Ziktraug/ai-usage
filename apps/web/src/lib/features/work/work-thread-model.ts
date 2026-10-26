import { parseWorkThreadLinkKey, type WorkThreadEvent } from '@ai-usage/report-core/work-thread';
import {
  deriveWorkThreadSituation,
  WORK_THREAD_STALE_AFTER_MS,
  type WorkThreadRemainder,
} from '@ai-usage/report-core/work-thread-situation';
import type {
  WorkThreadDetailDataset,
  WorkThreadEpisode,
  WorkThreadFactEvent,
  WorkThreadListQuery,
  WorkThreadMark,
  WorkThreadMarkers,
  WorkThreadPullRequestMarker,
  WorkThreadRow,
  WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';

export const threadListQuery = (search: URLSearchParams): WorkThreadListQuery => ({
  cursor: search.get('cursor') || null,
  limit: 50,
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

export const threadUrl = (url: URL, threadId: string | null, day?: string): string => {
  const next = new URL(url);
  next.pathname = '/work';
  next.hash = '';
  next.searchParams.delete('day');
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

export const groupThreadRows = (rows: readonly WorkThreadRow[]) => {
  const groups = new Map<string, WorkThreadRow[]>();
  for (const row of rows) {
    const project = row.thread.projectLabel ?? 'No project';
    const group = groups.get(project) ?? [];
    group.push(row);
    groups.set(project, group);
  }
  return [...groups].map(([project, tasks]) => ({ project, tasks }));
};

const SITUATION_GROUPS = [
  { hint: 'to-resume', label: 'To resume', note: 'Your next step' },
  { hint: 'in-progress', label: 'In progress', note: 'A session is still running' },
  { hint: 'undecided', label: 'To decide', note: 'Evidence is missing or stale' },
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
    return tasks.length ? [{ project: label, note, tasks }] : [];
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

export const threadWeek = (now: string, timeZone: string) => {
  const today = threadDayKey(now, timeZone);
  const anchor = new Date(`${today}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(anchor);
    day.setUTCDate(anchor.getUTCDate() - 6 + index);
    return {
      key: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric' }),
      today: index === 6,
    };
  });
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

const yearIn = (at: string, timeZone: string): string =>
  new Date(at).toLocaleDateString('en-US', { timeZone, year: 'numeric' });

/** With `now`, a date from another year names its year, so an old PR does not read as recent. */
export const threadDate = (at: string, timeZone: string, long = false, now?: string): string =>
  new Date(at).toLocaleDateString('en-US', {
    timeZone,
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(long ? { weekday: 'long' as const } : {}),
    ...(now !== undefined && yearIn(at, timeZone) !== yearIn(now, timeZone) ? { year: 'numeric' as const } : {}),
  });

export const threadTime = (at: string, timeZone: string): string =>
  new Date(at).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });

/** Calendar-day offsets keep overnight ranges honest even across daylight-saving changes. */
export const episodeTimeRange = (
  episode: Pick<WorkThreadEpisode, 'startedAt' | 'endedAt'>,
  timeZone: string,
): string => {
  const start = threadTime(episode.startedAt, timeZone);
  if (episode.endedAt === null) {
    return start;
  }
  const dayOffset = Math.round(
    (Date.parse(`${threadDayKey(episode.endedAt, timeZone)}T00:00:00Z`) -
      Date.parse(`${threadDayKey(episode.startedAt, timeZone)}T00:00:00Z`)) /
      86_400_000,
  );
  return `${start}–${threadTime(episode.endedAt, timeZone)}${dayOffset > 0 ? ` +${dayOffset}d` : ''}`;
};

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
      local.push({ ...unknown, via: 'branch-link' });
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
    case 'source-unavailable':
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
  const primary = situation.remainders.find((remainder) => remainder.kind === situation.reason);
  let headline = primary ? remainderCopy(primary) : 'Choose the next step';
  let caption = primary ? remainderEvidenceCopy(primary, timeZone) : 'Follow-up stays yours to end';
  if (situation.reason === 'follow-up-ended') {
    headline = 'You ended this follow-up';
    caption = row.afterDone
      ? `${row.afterDone.count} newer observations · follow-up stays done`
      : 'History and links stay available.';
  } else if (situation.reason === 'explicit-wait') {
    headline = row.thread.waitingFor ?? 'Waiting for a response';
    caption = 'No session needs to keep running while you wait.';
  } else if (situation.reason === 'no-remainder') {
    headline = row.thread.intent === 'review' ? 'Review follow-up is ready to end' : 'An analysis can be enough';
    caption = 'No known remainder. No branch, PR or ticket is required.';
  } else if (situation.reason === 'merged-complete') {
    headline = 'Everything is aligned to finish';
    caption = 'PR merged · linked tickets done · no local remainder. Deployment is not established.';
  } else if (situation.reason === 'running-session') {
    headline = 'Work is in progress';
    caption = primary ? remainderEvidenceCopy(primary, timeZone) : 'Sessions · date unknown';
  }
  return { ...situation, label, headline, caption };
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

const formatEpisodeDuration = (milliseconds: number): string => {
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
  title:
    event.label +
    ' ' +
    { 'pull-request-opened': 'opened', 'pull-request-merged': 'merged', 'pull-request-closed': 'closed' }[event.kind],
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
