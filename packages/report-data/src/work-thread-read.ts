import { type CanonicalInstant, canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import type {
  CheckoutStatusObservation,
  JiraIssueObservation,
  PullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import {
  parseWorkThreadLinkKey,
  sessionLinkKey,
  WORK_THREAD_BOUNDS,
  type WorkThread,
  type WorkThreadEvent,
  type WorkThreadLink,
} from '@ai-usage/report-core/work-thread';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadDetailDataset,
  type WorkThreadEpisode,
  type WorkThreadFact,
  type WorkThreadFactEvent,
  type WorkThreadListDataset,
  type WorkThreadListQuery,
  type WorkThreadMark,
  type WorkThreadMarkers,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import {
  countWorkThreads,
  type LatestCheckoutStatusObservations,
  type LatestJiraIssueObservations,
  type LatestPullRequestObservations,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryUsageLocalMachine,
  queryWorkFactRunStates,
  queryWorkThreadById,
  queryWorkThreadEvents,
  queryWorkThreadLinks,
  queryWorkThreadProjects,
  queryWorkThreadSessionEvidence,
  queryWorkThreadsPage,
  UsageStoreError,
  type WorkFactRunState,
  type WorkThreadSessionEvidence,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

const DAY_MS = 86_400_000;
const text = (value: string | null | undefined): string | null =>
  value?.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeText) ?? null;
const titleText = (value: string | null | undefined): string | null => text(value?.trim()) || null;
const error = (message: string) =>
  new UsageStoreError({ message, operation: 'queryWorkThreads', reason: 'invalid-input' });
const nowOf = (now?: Date): Effect.Effect<CanonicalInstant, UsageStoreError> =>
  Effect.try({
    try: () => canonicalInstantFromDate(now ?? new Date()),
    catch: () => error('now must be a valid instant'),
  });
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const keyOf = (session: WorkThreadSessionEvidence['sessions'][number]): string =>
  sessionLinkKey({
    harness: session.harness,
    machineId: session.member.machineId,
    sessionId: session.member.sourceSessionId,
  });
const parentKeyOf = (session: WorkThreadSessionEvidence['sessions'][number]): string | null =>
  session.member.parentSourceSessionId === null
    ? null
    : sessionLinkKey({
        harness: session.harness,
        machineId: session.member.machineId,
        sessionId: session.member.parentSourceSessionId,
      });

const episodeOf = (
  session: WorkThreadSessionEvidence['sessions'][number],
  parent: WorkThreadSessionEvidence['sessions'][number] | undefined,
  attestedDelegation = false,
): WorkThreadEpisode | null => {
  const { member, desktop, harness } = session;
  const startedAt = desktop?.createdAt ?? normalizeIsoTimestamp(member.startedAt);
  if (startedAt === null) {
    return null;
  }
  const endedAt =
    desktop?.lastActivityAt ??
    (member.activeAt === null ? null : normalizeIsoTimestamp(new Date(member.activeAt).toISOString()));
  const spanMs =
    endedAt !== null && Date.parse(endedAt) >= Date.parse(startedAt)
      ? Date.parse(endedAt) - Date.parse(startedAt)
      : null;
  let origin: WorkThreadEpisode['origin'] = null;
  if (attestedDelegation) {
    origin = 'delegated';
  } else if (member.origin === 'human') {
    origin = 'human';
  } else if (member.origin === 'subagent' || member.origin === 'delegated') {
    origin = 'delegated';
  } else if (member.origin === 'classifier' || member.origin === 'automated-review') {
    origin = 'automated-review';
  }
  return {
    activeMs:
      typeof member.durationMs === 'number' && Number.isFinite(member.durationMs) && member.durationMs >= 0
        ? member.durationMs
        : null,
    children: [],
    endedAt,
    firstPrompt: text(session.firstPrompt),
    harness,
    lastInstruction: null,
    launchedBy:
      parent === undefined
        ? null
        : { harness: parent.harness, title: titleText(parent.desktop?.title) ?? titleText(parent.member.title) },
    linkKey: keyOf(session),
    machineId: member.machineId,
    origin,
    projectLabel: text(member.projectLabel),
    question: text(desktop?.turnSummary?.needsAction ?? desktop?.turnSummary?.detail),
    result: text(desktop?.lastTurnReport),
    spanMs,
    resume:
      harness === 'claude' || harness === 'codex'
        ? {
            kind: 'cli-resume',
            command: `${harness === 'claude' ? 'claude --resume' : 'codex resume'} ${quote(member.sourceSessionId)}`,
            cwd: desktop?.worktreePath ?? desktop?.cwd ?? member.checkoutPath,
          }
        : { kind: 'none', reason: 'CLI resume is not verified for this harness.' },
    // Recency and a historical completion are not evidence that a process is running now.
    running: null,
    sourceSessionId: member.sourceSessionId,
    startedAt,
    title: titleText(desktop?.title) ?? titleText(member.title),
  };
};

const episodesOf = (
  evidence: WorkThreadSessionEvidence,
  links: readonly WorkThreadLink[],
): { episodes: WorkThreadEpisode[]; omitted: boolean; delegatedKeys: ReadonlySet<string> } => {
  const linked = new Set(links.filter((link) => link.kind === 'session').map((link) => link.key));
  const sessions = new Map(evidence.sessions.map((session) => [keyOf(session), session]));
  const delegationParents = new Map<string, string>();
  for (const session of sessions.values()) {
    const parentKey = keyOf(session);
    if (session.harness !== 'claude' || !linked.has(parentKey)) {
      continue;
    }
    for (const delegated of session.member.delegatedSessions ?? []) {
      const childKey = sessionLinkKey({
        harness: delegated.harness,
        machineId: session.member.machineId,
        sessionId: delegated.sourceSessionId,
      });
      if (!delegationParents.has(childKey)) {
        delegationParents.set(childKey, parentKey);
      }
    }
  }
  const parents = new Map<string, string>();
  for (const session of sessions.values()) {
    const key = keyOf(session);
    const nativeParent = parentKeyOf(session);
    // Native lineage keeps its harness namespace; an attestation supplies only the cross-harness edge.
    const parentKey = nativeParent ?? delegationParents.get(key) ?? null;
    if (parentKey !== null) {
      parents.set(key, parentKey);
    }
  }
  const episodes = new Map<string, WorkThreadEpisode>();
  let omitted = false;
  for (const session of sessions.values()) {
    const key = keyOf(session);
    const parentKey = parents.get(key);
    const episode = episodeOf(
      session,
      parentKey === undefined ? undefined : sessions.get(parentKey),
      delegationParents.has(key),
    );
    if (episode === null) {
      omitted = true;
    } else {
      episodes.set(episode.linkKey, episode);
    }
  }
  const children = new Map<string, WorkThreadEpisode[]>();
  for (const [key, episode] of episodes) {
    const parentKey = parents.get(key);
    if (parentKey !== undefined && parentKey !== key && episodes.has(parentKey)) {
      const siblings = children.get(parentKey) ?? [];
      if (siblings.length < WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren) {
        siblings.push(episode);
      } else {
        omitted = true;
      }
      children.set(parentKey, siblings);
    }
  }
  const roots = [...episodes.values()].filter((episode) => {
    if (!linked.has(episode.linkKey) || delegationParents.has(episode.linkKey)) {
      return false;
    }
    const parentKey = parents.get(episode.linkKey);
    return parentKey === undefined || parentKey === episode.linkKey || !episodes.has(parentKey);
  });
  const rendered = new Set<string>();
  const nest = (episode: WorkThreadEpisode, ancestors: ReadonlySet<string>): WorkThreadEpisode => {
    rendered.add(episode.linkKey);
    const path = new Set([...ancestors, episode.linkKey]);
    return {
      ...episode,
      children: (children.get(episode.linkKey) ?? []).flatMap((child) => {
        if (path.has(child.linkKey)) {
          omitted = true;
          return [];
        }
        return [nest(child, path)];
      }),
    };
  };
  const nested = roots.map((episode) => nest(episode, new Set()));
  for (const episode of episodes.values()) {
    if (delegationParents.has(episode.linkKey) && !rendered.has(episode.linkKey)) {
      omitted = true;
      continue;
    }
    if (linked.has(episode.linkKey) && !rendered.has(episode.linkKey)) {
      omitted = true;
      const ancestors = new Set<string>();
      let candidate: string | null = episode.linkKey;
      while (candidate !== null && !ancestors.has(candidate)) {
        ancestors.add(candidate);
        candidate = parents.get(candidate) ?? null;
      }
      // Only a cycle needs a visible root. A child omitted by its parent's bound stays a child.
      if (candidate !== null) {
        nested.push(nest(episode, new Set()));
      }
    }
  }
  nested.sort(
    (left, right) => right.startedAt.localeCompare(left.startedAt) || left.linkKey.localeCompare(right.linkKey),
  );
  return {
    delegatedKeys: new Set(delegationParents.keys()),
    episodes: nested.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodes),
    omitted: omitted || nested.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodes,
  };
};

type Observation = PullRequestObservation | JiraIssueObservation | CheckoutStatusObservation;
const observationKey = (observation: Observation): string => {
  if ('checkoutPath' in observation) {
    return `checkout:${observation.checkoutPath}`;
  }
  if ('key' in observation) {
    return `jira:${observation.key}`;
  }
  return `pr:${observation.host.toLowerCase()}/${observation.repository.toLowerCase()}#${observation.number}`;
};
const factOf = <Value extends Observation>(
  key: string,
  item: { readonly latest: Value; readonly latestObserved: Value | null } | undefined,
): WorkThreadFact<Value> => ({
  key,
  latest: item?.latest ?? null,
  latestSuccessful: item?.latest.outcome === 'observed' ? item.latest : (item?.latestObserved ?? null),
});

interface RowRead {
  readonly episodes: readonly WorkThreadEpisode[];
  readonly evidence: WorkThreadSessionEvidence;
  readonly factEvents: readonly WorkThreadFactEvent[];
  readonly row: WorkThreadRow;
  readonly truncated: ReadonlySet<WorkThreadSourceStatus['source']>;
}

const identityOf = (machineId: string, key: string): string => JSON.stringify([machineId, key]);
const pullRequestIdentity = (value: Pick<PullRequestObservation, 'machineId' | 'host' | 'repository' | 'number'>) =>
  identityOf(value.machineId, `pr:${value.host.toLowerCase()}/${value.repository.toLowerCase()}#${value.number}`);
const checkoutPathsOf = (evidence: WorkThreadSessionEvidence) => {
  const paths = [
    ...evidence.branchCheckouts.map((entry) => ({
      ...entry,
      sessions: [] as { key: string; branch: string | null }[],
      via: 'branch-link' as const,
    })),
    ...evidence.sessions.flatMap((session) => {
      const checkoutPath = session.desktop?.worktreePath ?? session.desktop?.cwd ?? session.member.checkoutPath;
      return checkoutPath === null
        ? []
        : [
            {
              checkoutPath,
              key: keyOf(session),
              machineId: session.member.machineId,
              sessions: [
                {
                  key: keyOf(session),
                  branch: session.desktop === null ? session.member.branch : session.desktop.branch,
                },
              ],
              via: 'session-checkout' as const,
            },
          ];
    }),
  ];
  const unique = new Map<string, (typeof paths)[number]>();
  for (const entry of paths) {
    const identity = identityOf(entry.machineId, entry.checkoutPath);
    const existing = unique.get(identity);
    if (existing === undefined) {
      unique.set(identity, entry);
    } else {
      unique.set(identity, { ...existing, sessions: [...existing.sessions, ...entry.sessions] });
    }
  }
  return [...unique.values()];
};

const branchRef = (branch: string | null | undefined): string | null => {
  const ref = branch?.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
  return ref == null || ref.length === 0 ? null : ref;
};

const sessionCountsOf = (
  episodes: readonly WorkThreadEpisode[],
  links: readonly WorkThreadLink[],
  delegatedKeys: ReadonlySet<string>,
) => {
  const linked = new Set(links.filter((link) => link.kind === 'session').map((link) => link.key));
  const resolved = new Set<string>();
  const pending = [...episodes];
  while (pending.length > 0) {
    const episode = pending.pop();
    if (episode === undefined || resolved.has(episode.linkKey)) {
      continue;
    }
    resolved.add(episode.linkKey);
    pending.push(...episode.children);
  }
  const sessionCount = [...resolved].filter((key) => linked.has(key) && !delegatedKeys.has(key)).length;
  return { sessionCount, delegatedSessionCount: resolved.size - sessionCount };
};

interface RowScope {
  readonly evidence: WorkThreadSessionEvidence;
  readonly links: readonly WorkThreadLink[];
  readonly thread: WorkThread;
}
interface RowFacts {
  readonly checkouts: ReadonlyMap<string, LatestCheckoutStatusObservations['items'][number]>;
  readonly jiraIssues: ReadonlyMap<string, LatestJiraIssueObservations['items'][number]>;
  readonly pullRequests: ReadonlyMap<string, LatestPullRequestObservations['items'][number]>;
  readonly truncated: ReadonlySet<WorkThreadSourceStatus['source']>;
}

const readFacts = (dbPath: string, scopes: readonly RowScope[]): Effect.Effect<RowFacts, UsageStoreError> =>
  Effect.gen(function* () {
    const pullRequests = new Map<
      string,
      Pick<PullRequestObservation, 'machineId' | 'host' | 'repository' | 'number'>
    >();
    const jiraIssues = new Map<string, Pick<JiraIssueObservation, 'machineId' | 'key'>>();
    const checkouts = new Map<string, Pick<CheckoutStatusObservation, 'machineId' | 'checkoutPath'>>();
    for (const { thread, links, evidence } of scopes) {
      for (const link of links) {
        if (link.detachedAt !== null) {
          continue;
        }
        const parsed = parseWorkThreadLinkKey(link.kind, link.key);
        if (parsed?.kind === 'pull-request') {
          const target = {
            machineId: thread.machineId,
            host: parsed.host,
            repository: parsed.repository,
            number: parsed.number,
          };
          pullRequests.set(pullRequestIdentity(target), target);
        } else if (parsed?.kind === 'jira-issue' && parsed.site === 'default') {
          const target = { machineId: thread.machineId, key: parsed.key };
          jiraIssues.set(identityOf(target.machineId, target.key), target);
        }
      }
      for (const checkout of checkoutPathsOf(evidence).slice(0, WORK_THREAD_BOUNDS.maxLinksPerThread)) {
        checkouts.set(identityOf(checkout.machineId, checkout.checkoutPath), {
          machineId: checkout.machineId,
          checkoutPath: checkout.checkoutPath,
        });
      }
    }
    const prs = yield* queryLatestPullRequestObservations({ dbPath, batch: [...pullRequests.values()] });
    const jira = yield* queryLatestJiraIssueObservations({ dbPath, batch: [...jiraIssues.values()] });
    const local = yield* queryLatestCheckoutStatusObservations({ dbPath, batch: [...checkouts.values()] });
    const truncated = new Set<WorkThreadSourceStatus['source']>();
    if (prs.skipped || prs.truncated) {
      truncated.add('github');
    }
    if (jira.skipped || jira.truncated) {
      truncated.add('jira');
    }
    if (local.skipped || local.truncated) {
      truncated.add('checkouts');
    }
    return {
      pullRequests: new Map(prs.items.map((item) => [pullRequestIdentity(item.latest), item])),
      jiraIssues: new Map(jira.items.map((item) => [identityOf(item.latest.machineId, item.latest.key), item])),
      checkouts: new Map(
        local.items.map((item) => [identityOf(item.latest.machineId, item.latest.checkoutPath), item]),
      ),
      truncated,
    };
  });

const MERGEABLE = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting', UNKNOWN: 'unknown' } as const;

const factEventsOf = (pullRequests: WorkThreadMarkers['pullRequests']): WorkThreadFactEvent[] => {
  const distinct = new Map<string, WorkThreadFactEvent>();
  for (const marker of pullRequests) {
    const successful = marker.latestSuccessful;
    if (successful === null) {
      continue;
    }
    const openedAt = normalizeIsoTimestamp(successful.createdAt);
    const mergedAt = normalizeIsoTimestamp(successful.mergedAt);
    const closedAt = normalizeIsoTimestamp(successful.closedAt);
    const add = (kind: WorkThreadFactEvent['kind'], at: CanonicalInstant | null) => {
      if (at === null) {
        return;
      }
      const identity = JSON.stringify([pullRequestIdentity(successful), kind, at]);
      if (!distinct.has(identity)) {
        distinct.set(identity, {
          at,
          key: marker.key,
          kind,
          label: `PR #${successful.number}`,
          title: titleText(successful.title),
        });
      }
    };
    add('pull-request-opened', openedAt);
    add('pull-request-merged', mergedAt);
    if (mergedAt === null && successful.state !== 'MERGED') {
      add('pull-request-closed', closedAt);
    }
  }
  return [...distinct.values()]
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) || left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind),
    )
    .slice(-WORK_THREAD_VIEW_BOUNDS.maxFactEvents);
};

const FOLLOW_STATE_LABELS = { following: 'Following', waiting: 'Waiting', done: 'Follow-up ended' } as const;
const FACT_EVENT_LABELS = {
  'pull-request-opened': 'opened',
  'pull-request-merged': 'merged',
  'pull-request-closed': 'closed',
} as const;
const compareMarks = (left: WorkThreadMark, right: WorkThreadMark): number =>
  left.at.localeCompare(right.at) ||
  left.kind.localeCompare(right.kind) ||
  (left.label ?? '').localeCompare(right.label ?? '') ||
  (left.harness ?? '').localeCompare(right.harness ?? '');

const weekMarksOf = (
  episodes: readonly WorkThreadEpisode[],
  factEvents: readonly WorkThreadFactEvent[],
  events: readonly WorkThreadEvent[],
  now: CanonicalInstant,
): WorkThreadMark[] => {
  const start = Date.parse(now) - 8 * DAY_MS;
  const candidates: WorkThreadMark[] = [
    ...episodes.map((episode) => ({
      at: episode.startedAt,
      harness: episode.harness,
      kind: 'session' as const,
      label: episode.title ?? `Session ${episode.sourceSessionId}`,
    })),
    ...factEvents.map((event) => ({
      at: event.at,
      harness: null,
      kind: 'event' as const,
      label: `${event.label} ${FACT_EVENT_LABELS[event.kind]}`,
    })),
    ...events.flatMap((event) =>
      event.kind === 'follow-state' && event.toState !== null
        ? [{ at: event.at, harness: null, kind: 'event' as const, label: FOLLOW_STATE_LABELS[event.toState] }]
        : [],
    ),
  ];
  const recent = candidates
    .filter(({ at }) => Date.parse(at) >= start && Date.parse(at) <= Date.parse(now))
    .sort((left, right) => compareMarks(right, left));
  const selected = recent.slice(0, WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow);
  const newest = selected[0];
  if (newest !== undefined && selected.every((mark) => mark.kind === newest.kind)) {
    const otherKind = recent.find((mark) => mark.kind !== newest.kind);
    if (otherKind !== undefined) {
      selected[selected.length - 1] = otherKind;
    }
  }
  return selected.sort(compareMarks);
};

const readRow = (
  { thread, links, evidence }: RowScope,
  events: readonly WorkThreadEvent[],
  factsRead: RowFacts,
  now: CanonicalInstant,
  storedActivity = thread.updatedAt,
): RowRead => {
  const active = links.filter((link) => link.detachedAt === null);
  const { episodes, omitted, delegatedKeys } = episodesOf(evidence, active);
  const truncated = new Set(factsRead.truncated);
  if (evidence.truncated || omitted) {
    truncated.add('sessions');
  }
  const pullRequests: WorkThreadMarkers['pullRequests'][number][] = [];
  const jiraIssues: WorkThreadMarkers['jiraIssues'][number][] = [];
  for (const link of active) {
    const parsed = parseWorkThreadLinkKey(link.kind, link.key);
    if (parsed?.kind === 'pull-request') {
      const fact = factOf(
        link.key,
        factsRead.pullRequests.get(pullRequestIdentity({ ...parsed, machineId: thread.machineId })),
      );
      const successful = fact.latestSuccessful;
      const mergeable = successful?.mergeable;
      pullRequests.push({
        ...fact,
        mergeable: mergeable == null ? null : MERGEABLE[mergeable],
        mergeStateStatus: successful?.mergeStateStatus ?? null,
        role: successful?.discoveryRole ?? null,
      });
    } else if (parsed?.kind === 'jira-issue') {
      // The legacy Jira store has one default CLI authority and cannot prove an arbitrary site.
      if (parsed.site === 'default') {
        jiraIssues.push(factOf(link.key, factsRead.jiraIssues.get(identityOf(thread.machineId, parsed.key))));
      } else {
        jiraIssues.push(factOf<JiraIssueObservation>(link.key, undefined));
        truncated.add('jira');
      }
    }
  }
  const checkoutPaths = checkoutPathsOf(evidence);
  if (checkoutPaths.length > WORK_THREAD_BOUNDS.maxLinksPerThread) {
    truncated.add('checkouts');
  }
  const headRefs = new Set(
    pullRequests.flatMap((pullRequest) => {
      const head = branchRef(pullRequest.latestSuccessful?.headRef);
      return head === null ? [] : [head];
    }),
  );
  const local = checkoutPaths
    .slice(0, WORK_THREAD_BOUNDS.maxLinksPerThread)
    .flatMap<WorkThreadMarkers['local'][number]>((checkout) => {
      const observation = factsRead.checkouts.get(identityOf(checkout.machineId, checkout.checkoutPath));
      if (checkout.via === 'branch-link') {
        return [{ ...factOf(checkout.key, observation), via: checkout.via }];
      }
      const successful = observation?.latest.outcome === 'observed' ? observation.latest : observation?.latestObserved;
      const branch = branchRef(successful?.branch);
      if (branch === null) {
        return [];
      }
      if (pullRequests.length > 0 && !headRefs.has(branch)) {
        return [];
      }
      const key =
        pullRequests.length > 0
          ? checkout.key
          : (checkout.sessions.find((session) => branchRef(session.branch) === branch)?.key ?? null);
      return key === null ? [] : [{ ...factOf(key, observation), via: checkout.via }];
    });
  const sessions = [...new Map(evidence.sessions.map((session) => [keyOf(session), session])).values()];
  const linkedSessionKeys = new Set(active.filter((link) => link.kind === 'session').map((link) => link.key));
  const firstActivityAt = [
    thread.createdAt,
    ...sessions.flatMap((session) => {
      const startedAt = session.desktop?.createdAt ?? normalizeIsoTimestamp(session.member.startedAt);
      return linkedSessionKeys.has(keyOf(session)) && startedAt !== null ? [startedAt] : [];
    }),
    ...pullRequests.flatMap((marker) => {
      const createdAt = normalizeIsoTimestamp(marker.latestSuccessful?.createdAt);
      return createdAt === null ? [] : [createdAt];
    }),
  ].reduce((earliest, candidate) => (Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest));
  const factEvents = factEventsOf(pullRequests);
  const facts = [...pullRequests, ...jiraIssues, ...local];
  const factDates = new Map<string, CanonicalInstant>();
  for (const marker of facts) {
    const observation = marker.latestSuccessful;
    if (observation === null) {
      continue;
    }
    let instants: readonly (CanonicalInstant | null)[];
    if ('checkoutPath' in observation) {
      instants = [
        observation.lastCommitAt,
        factsRead.checkouts.get(identityOf(observation.machineId, observation.checkoutPath))?.countsChangedAt ?? null,
      ];
    } else if ('key' in observation) {
      instants = [observation.updatedAt];
    } else {
      instants = [
        observation.updatedAt,
        observation.mergedAt,
        observation.createdAt ?? null,
        observation.closedAt ?? null,
      ];
    }
    const at = instants
      .filter((instant): instant is CanonicalInstant => instant !== null)
      .sort()
      .at(-1);
    if (at !== undefined) {
      factDates.set(JSON.stringify([observation.machineId, observationKey(observation)]), at);
    }
  }
  const sessionDates = sessions.flatMap((session) => {
    const activeAt =
      session.desktop?.lastActivityAt ??
      (session.member.activeAt === null
        ? normalizeIsoTimestamp(session.member.startedAt)
        : normalizeIsoTimestamp(new Date(session.member.activeAt).toISOString()));
    return activeAt === null ? [] : [activeAt];
  });
  const dates = [...factDates.values(), ...sessionDates];
  const after = thread.doneAt === null ? [] : dates.filter((at) => Date.parse(at) > Date.parse(thread.doneAt ?? at));
  const marks = weekMarksOf(episodes, factEvents, events, now);
  const latest = (instants: readonly CanonicalInstant[]): CanonicalInstant =>
    instants.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b));
  return {
    episodes,
    evidence,
    factEvents,
    truncated,
    row: {
      afterDone: after.length === 0 ? null : { count: after.length, latestAt: latest(after) },
      firstActivityAt,
      lastActivityAt: latest([storedActivity, ...dates]),
      links: active,
      markers: { pullRequests, jiraIssues, local },
      marks,
      // Neither stored session family carries native lifecycle evidence; recency is not a running state.
      runningSessions: 0,
      ...sessionCountsOf(episodes, active, delegatedKeys),
      thread,
    },
  };
};

const SOURCE_IDS = { checkouts: 'checkouts.status', github: 'github.pull-requests', jira: 'jira.issues' } as const;
const sourcesOf = (
  runs: readonly WorkFactRunState[],
  reads: readonly RowRead[],
  machineId: string,
  runRowsSkipped: number,
): WorkThreadSourceStatus[] => {
  const sources = (Object.keys(SOURCE_IDS) as (keyof typeof SOURCE_IDS)[]).map((source): WorkThreadSourceStatus => {
    const run = runs.find(
      (candidate) => candidate.machineId === machineId && candidate.sourceId === SOURCE_IDS[source],
    );
    if (run === undefined) {
      const state = runRowsSkipped ? 'unavailable' : 'never-run';
      return {
        source,
        state: reads.some((read) => read.truncated.has(source)) ? 'truncated' : state,
        lastRunAt: null,
        message: runRowsSkipped ? 'Some source run records could not be read.' : null,
      };
    }
    const observations = reads.flatMap<Observation | null>(({ row }) => {
      if (source === 'github') {
        return row.markers.pullRequests.map((item) => item.latest);
      }
      if (source === 'jira') {
        return row.markers.jiraIssues.map((item) => item.latest);
      }
      return row.markers.local.map((item) => item.latest);
    });
    let state: WorkThreadSourceStatus['state'] = 'ok';
    if (run.disabled) {
      state = 'disabled';
    } else if (run.failed > 0) {
      state =
        run.outcomeCode === 'unauthenticated' || observations.some((item) => item?.outcome === 'unauthenticated')
          ? 'unauthenticated'
          : 'failed';
    } else if (reads.some((read) => read.truncated.has(source))) {
      state = 'truncated';
    }
    return { source, state, lastRunAt: run.ranAt, message: run.message };
  });
  const evidence = reads.find((read) => read.evidence.revision !== null)?.evidence;
  const desktopObservedAt =
    reads
      .flatMap((read) => read.evidence.sessions.flatMap((session) => session.desktop?.observedAt ?? []))
      .toSorted()
      .at(-1) ?? null;
  let sessionState: WorkThreadSourceStatus['state'] =
    evidence === undefined && desktopObservedAt === null ? 'never-run' : 'ok';
  if (reads.some((read) => read.truncated.has('sessions'))) {
    sessionState = 'truncated';
  }
  const sessionMessages: string[] = [];
  if (reads.some((read) => read.truncated.has('sessions'))) {
    sessionMessages.push('Some linked session evidence was unavailable or exceeded the read bounds.');
  }
  if (reads.some((read) => read.evidence.sessions.length > 0)) {
    sessionMessages.push('Running state is unknown for the linked sessions.');
  }
  sources.push({
    source: 'sessions',
    state: sessionState,
    lastRunAt: evidence?.generatedAt ?? desktopObservedAt,
    message: sessionMessages.length > 0 ? sessionMessages.join(' ') : null,
  });
  return sources;
};

export const queryWorkThreadList = (input: {
  readonly dbPath: string;
  readonly query: WorkThreadListQuery;
  readonly now?: Date;
}): Effect.Effect<WorkThreadListDataset, UsageStoreError> =>
  Effect.gen(function* () {
    const generatedAt = yield* nowOf(input.now);
    const page = yield* queryWorkThreadsPage(input);
    const machine = yield* queryUsageLocalMachine(input);
    // An empty page still reports whether a served revision exists.
    if (page.rows.length === 0) {
      const evidence = yield* queryWorkThreadSessionEvidence({
        dbPath: input.dbPath,
        machineId: machine.id,
        links: [],
      });
      const runStates = yield* queryWorkFactRunStates(input);
      const sources = sourcesOf(runStates.runs, [], machine.id, runStates.skipped).map(
        (source): WorkThreadSourceStatus =>
          source.source === 'sessions'
            ? { ...source, state: evidence.revision === null ? 'never-run' : 'ok', lastRunAt: evidence.generatedAt }
            : source,
      );
      return {
        counts: yield* countWorkThreads(input),
        generatedAt,
        machineId: machine.id,
        nextCursor: page.nextCursor,
        projects: yield* queryWorkThreadProjects(input),
        rows: [],
        sources,
      };
    }
    const links = yield* queryWorkThreadLinks({
      dbPath: input.dbPath,
      threadIds: page.rows.map(({ thread }) => thread.threadId),
    });

    const linksByThread = new Map<string, WorkThreadLink[]>();
    for (const link of links) {
      const group = linksByThread.get(link.threadId) ?? [];
      group.push(link);
      linksByThread.set(link.threadId, group);
    }
    const scopes = page.rows.map(({ thread }) => ({
      thread,
      links: linksByThread.get(thread.threadId) ?? [],
    }));
    const evidence = yield* queryWorkThreadSessionEvidence({
      dbPath: input.dbPath,
      threads: scopes.map(({ thread, links: threadLinks }) => ({
        threadId: thread.threadId,
        machineId: thread.machineId,
        links: threadLinks.filter((link) => link.detachedAt === null),
      })),
    });
    const evidenceByThread = new Map(evidence.map((item) => [item.threadId, item.evidence]));
    const rowScopes: RowScope[] = [];
    for (const scope of scopes) {
      const threadEvidence = evidenceByThread.get(scope.thread.threadId);
      if (threadEvidence === undefined) {
        return yield* Effect.fail(error('Missing batched thread evidence'));
      }
      rowScopes.push({ ...scope, evidence: threadEvidence });
    }
    const facts = yield* readFacts(input.dbPath, rowScopes);
    const events = yield* queryWorkThreadEvents({
      dbPath: input.dbPath,
      threadIds: scopes.map(({ thread }) => thread.threadId),
    });
    const eventsByThread = new Map<string, WorkThreadEvent[]>();
    for (const event of events) {
      const group = eventsByThread.get(event.threadId) ?? [];
      group.push(event);
      eventsByThread.set(event.threadId, group);
    }
    const reads = rowScopes.map((scope, index) =>
      readRow(
        scope,
        eventsByThread.get(scope.thread.threadId) ?? [],
        facts,
        generatedAt,
        page.rows[index]?.lastActivityAt,
      ),
    );
    const runStates = yield* queryWorkFactRunStates(input);
    return {
      counts: yield* countWorkThreads(input),
      generatedAt,
      machineId: machine.id,
      nextCursor: page.nextCursor,
      projects: yield* queryWorkThreadProjects(input),
      rows: reads.map((read) => read.row),
      sources: sourcesOf(runStates.runs, reads, machine.id, runStates.skipped),
    };
  });

export const queryWorkThreadDetail = (input: {
  readonly dbPath: string;
  readonly threadId: string;
  readonly now?: Date;
}): Effect.Effect<WorkThreadDetailDataset | null, UsageStoreError> =>
  Effect.gen(function* () {
    const generatedAt = yield* nowOf(input.now);
    const thread = yield* queryWorkThreadById(input);
    if (thread === null) {
      return null;
    }
    const links = yield* queryWorkThreadLinks({ dbPath: input.dbPath, threadIds: [thread.threadId] });
    const events = yield* queryWorkThreadEvents(input);
    const evidence = yield* queryWorkThreadSessionEvidence({
      dbPath: input.dbPath,
      machineId: thread.machineId,
      links: links.filter((link) => link.detachedAt === null),
    });
    const scope = { thread, links, evidence };
    const facts = yield* readFacts(input.dbPath, [scope]);
    const read = readRow(scope, events, facts, generatedAt);
    const runStates = yield* queryWorkFactRunStates(input);
    const detachedLinks = links
      .filter((link) => link.detachedAt !== null)
      .sort(
        (left, right) =>
          (right.detachedAt ?? '').localeCompare(left.detachedAt ?? '') || right.linkId.localeCompare(left.linkId),
      );
    const omittedDetachedSources = new Set(
      detachedLinks.slice(WORK_THREAD_BOUNDS.maxLinksPerThread).map((link): WorkThreadSourceStatus['source'] => {
        if (link.kind === 'pull-request') {
          return 'github';
        }
        if (link.kind === 'jira-issue') {
          return 'jira';
        }
        return link.kind === 'session' ? 'sessions' : 'checkouts';
      }),
    );
    return {
      detachedLinks: detachedLinks.slice(0, WORK_THREAD_BOUNDS.maxLinksPerThread),
      episodes: read.episodes,
      events,
      factEvents: read.factEvents,
      generatedAt,
      row: read.row,
      sources: sourcesOf(runStates.runs, [read], thread.machineId, runStates.skipped).map((source) =>
        omittedDetachedSources.has(source.source)
          ? {
              ...source,
              state: source.state === 'ok' ? ('truncated' as const) : source.state,
              message: [source.message, 'Older detached links are omitted from this history.']
                .filter(Boolean)
                .join(' '),
            }
          : source,
      ),
    };
  });
