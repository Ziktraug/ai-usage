import { parseWorkThreadLinkKey, type WorkThreadEvent } from '@ai-usage/report-core/work-thread';
import { deriveWorkThreadSituation, type WorkThreadRemainder } from '@ai-usage/report-core/work-thread-situation';
import type {
  WorkThreadDetailDataset,
  WorkThreadEpisode,
  WorkThreadListQuery,
  WorkThreadMark,
  WorkThreadMarkers,
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

export const threadDate = (at: string, timeZone: string, long = false): string =>
  new Date(at).toLocaleDateString('en-US', {
    timeZone,
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(long ? { weekday: 'long' as const } : {}),
  });

export const threadTime = (at: string, timeZone: string): string =>
  new Date(at).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });

export const harnessName = (harness: string): string =>
  ({ claude: 'Claude', 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' })[harness] ??
  harness;
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
  refs.push(`${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`);
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
    case 'local-files':
      return `Local files: ${remainder.modified ?? 'unknown'} modified, ${remainder.staged ?? 'unknown'} staged, ${remainder.untracked ?? 'unknown'} untracked`;
    case 'unpushed-commits':
      return `${remainder.count} unpushed ${remainder.count === 1 ? 'commit' : 'commits'}`;
    case 'running-session':
      return `${remainder.count} linked ${remainder.count === 1 ? 'session is' : 'sessions are'} still running`;
    case 'merge-conflict':
      return `Conflicts with ${remainder.baseRef ?? 'the PR base (unknown)'}`;
    case 'behind-base':
      return `Behind ${remainder.baseRef ?? 'the PR base (unknown)'}`;
    case 'changes-requested':
      return 'Review changes to address';
    case 'failing-checks':
      return 'PR checks are failing';
    case 'pending-checks':
      return 'PR checks are pending';
    case 'review-requested':
      return 'A PR is waiting for your review';
    case 'open-pr':
      return 'The linked PR is still open';
    case 'jira-open':
      return 'The linked ticket is not done';
    case 'source-unavailable':
      return `${sourceName(remainder.source)} latest read: ${remainder.outcome}`;
    case 'source-stale':
      return `${sourceName(remainder.source)} observation is stale`;
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
  return Date.parse(now) - Date.parse(source.lastRunAt) > 7 * 86_400_000 ? { ...evidence, kind: 'source-stale' } : null;
};

export const threadSituationCopy = (row: WorkThreadRow, now: string, sources: readonly WorkThreadSourceStatus[]) => {
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
  let caption = 'The follow-up stays yours until you end it.';
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
    caption = 'A linked session is still active.';
  } else if (primary?.observedAt) {
    caption = `${sourceName(primary.source)} observation · ${new Date(primary.observedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
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

export const episodeSpan = (episode: WorkThreadEpisode): string => {
  if (episode.durationBasis !== 'span' || episode.durationMs === null) {
    return 'Span unknown';
  }
  const minutes = Math.round(episode.durationMs / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
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
): WorkThreadEpisode | null => {
  const running: WorkThreadEpisode[] = [];
  const visit = (items: readonly WorkThreadEpisode[]): void => {
    for (const episode of items) {
      if (episode.running === true) {
        running.push(episode);
      }
      visit(episode.children);
    }
  };
  visit(episodes);
  return runningCount === 1 && running.length === 1 && running[0]?.resume.kind === 'cli-resume' ? running[0] : null;
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
  };
  const linkLabel = event.linkKey ? eventLinkLabel(event.linkKey, episodes) : null;
  const detail =
    event.kind === 'link-added' || event.kind === 'link-detached' ? linkLabel : (event.reason ?? linkLabel);
  return { title: titles[event.kind], detail };
};

export type ThreadHistoryEntry =
  | { readonly kind: 'session'; readonly at: string; readonly id: string; readonly episode: WorkThreadEpisode }
  | { readonly kind: 'event'; readonly at: string; readonly id: string; readonly event: WorkThreadEvent };

export const threadHistory = (data: WorkThreadDetailDataset, sessionsOnly: boolean, timeZone: string) => {
  const entries: ThreadHistoryEntry[] = data.episodes.map((episode) => ({
    kind: 'session',
    at: episode.startedAt,
    id: episode.linkKey,
    episode,
  }));
  if (!sessionsOnly) {
    entries.push(
      ...data.events.map((event): ThreadHistoryEntry => ({ kind: 'event', at: event.at, id: event.eventId, event })),
    );
  }
  entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  const days = new Map<string, ThreadHistoryEntry[]>();
  for (const entry of entries) {
    const key = threadDayKey(entry.at, timeZone);
    const group = days.get(key) ?? [];
    group.push(entry);
    days.set(key, group);
  }
  return [...days].map(([key, items]) => ({ key, entries: items }));
};
