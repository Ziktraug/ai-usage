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
  type WorkThread,
  type WorkThreadEvent,
  type WorkThreadLink,
} from '@ai-usage/report-core/work-thread';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadDetailDataset,
  type WorkThreadEpisode,
  type WorkThreadFact,
  type WorkThreadListDataset,
  type WorkThreadListQuery,
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
): WorkThreadEpisode | null => {
  const { member, desktop, harness } = session;
  const startedAt = desktop?.createdAt ?? normalizeIsoTimestamp(member.startedAt);
  if (startedAt === null) {
    return null;
  }
  const endedAt =
    desktop?.lastActivityAt ??
    (member.activeAt === null ? null : normalizeIsoTimestamp(new Date(member.activeAt).toISOString()));
  const durationMs =
    endedAt !== null && Date.parse(endedAt) >= Date.parse(startedAt)
      ? Date.parse(endedAt) - Date.parse(startedAt)
      : null;
  let origin: WorkThreadEpisode['origin'] = null;
  if (member.origin === 'human') {
    origin = 'human';
  } else if (member.origin === 'subagent' || member.origin === 'delegated') {
    origin = 'delegated';
  } else if (member.origin === 'classifier' || member.origin === 'automated-review') {
    origin = 'automated-review';
  }
  return {
    children: [],
    durationBasis: durationMs === null ? 'unknown' : 'span',
    durationMs,
    endedAt,
    firstPrompt: text(session.firstPrompt),
    harness,
    lastInstruction: null,
    launchedBy:
      parent === undefined
        ? null
        : { harness: parent.harness, title: text(parent.desktop?.title ?? parent.member.title) },
    linkKey: keyOf(session),
    machineId: member.machineId,
    origin,
    projectLabel: text(member.projectLabel),
    question: text(desktop?.turnSummary?.needsAction ?? desktop?.turnSummary?.detail),
    result: text(desktop?.lastTurnReport),
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
    title: text(desktop?.title ?? member.title),
  };
};

const episodesOf = (
  evidence: WorkThreadSessionEvidence,
  links: readonly WorkThreadLink[],
): { episodes: WorkThreadEpisode[]; omitted: boolean } => {
  const linked = new Set(links.filter((link) => link.kind === 'session').map((link) => link.key));
  const sessions = new Map(evidence.sessions.map((session) => [keyOf(session), session]));
  const episodes = new Map<string, WorkThreadEpisode>();
  let omitted = false;
  for (const session of sessions.values()) {
    const parentKey = parentKeyOf(session);
    const episode = episodeOf(session, parentKey === null ? undefined : sessions.get(parentKey));
    if (episode === null) {
      omitted = true;
    } else {
      episodes.set(episode.linkKey, episode);
    }
  }
  const children = new Map<string, WorkThreadEpisode[]>();
  for (const [key, episode] of episodes) {
    const session = sessions.get(key);
    const parentKey = session === undefined ? null : parentKeyOf(session);
    if (parentKey !== null && parentKey !== key && linked.has(parentKey) && episodes.has(parentKey)) {
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
    if (!linked.has(episode.linkKey)) {
      return false;
    }
    const session = sessions.get(episode.linkKey);
    const parentKey = session === undefined ? null : parentKeyOf(session);
    return parentKey === null || parentKey === episode.linkKey || !linked.has(parentKey) || !episodes.has(parentKey);
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
    if (linked.has(episode.linkKey) && !rendered.has(episode.linkKey)) {
      omitted = true;
      const ancestors = new Set<string>();
      let candidate: string | null = episode.linkKey;
      while (candidate !== null && !ancestors.has(candidate)) {
        ancestors.add(candidate);
        const session = sessions.get(candidate);
        candidate = session === undefined ? null : parentKeyOf(session);
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
  readonly row: WorkThreadRow;
  readonly truncated: ReadonlySet<WorkThreadSourceStatus['source']>;
}

const identityOf = (machineId: string, key: string): string => JSON.stringify([machineId, key]);
const pullRequestIdentity = (value: Pick<PullRequestObservation, 'machineId' | 'host' | 'repository' | 'number'>) =>
  identityOf(value.machineId, `pr:${value.host.toLowerCase()}/${value.repository.toLowerCase()}#${value.number}`);
const checkoutPathsOf = (evidence: WorkThreadSessionEvidence) => {
  const paths = [
    ...evidence.branchCheckouts.map((entry) => ({ ...entry, via: 'branch-link' as const })),
    ...evidence.sessions.flatMap((session) => {
      const checkoutPath = session.desktop?.worktreePath ?? session.desktop?.cwd ?? session.member.checkoutPath;
      return checkoutPath === null
        ? []
        : [
            {
              checkoutPath,
              key: keyOf(session),
              machineId: session.member.machineId,
              via: 'session-checkout' as const,
            },
          ];
    }),
  ];
  return [
    ...new Map(
      paths.map((entry) => [JSON.stringify([entry.key, entry.machineId, entry.checkoutPath]), entry]),
    ).values(),
  ];
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
      for (const checkout of checkoutPathsOf(evidence)) {
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

const readRow = (
  { thread, links, evidence }: RowScope,
  events: readonly WorkThreadEvent[],
  factsRead: RowFacts,
  now: CanonicalInstant,
  storedActivity = thread.updatedAt,
): RowRead => {
  const active = links.filter((link) => link.detachedAt === null);
  const { episodes, omitted } = episodesOf(evidence, active);
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
  const local = checkoutPathsOf(evidence).map((checkout) => ({
    ...factOf(checkout.key, factsRead.checkouts.get(identityOf(checkout.machineId, checkout.checkoutPath))),
    via: checkout.via,
  }));
  const sessions = [...new Map(evidence.sessions.map((session) => [keyOf(session), session])).values()];
  const facts = [...pullRequests, ...jiraIssues, ...local];
  const factDates = new Map<string, CanonicalInstant>();
  for (const marker of facts) {
    for (const observation of [marker.latest, marker.latestSuccessful]) {
      if (observation !== null) {
        factDates.set(
          JSON.stringify([observation.machineId, observationKey(observation), observation.observedAt]),
          observation.observedAt,
        );
      }
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
  const start = Date.parse(now) - 8 * DAY_MS;
  const marks = [
    ...sessions.flatMap((session) => {
      const at = session.desktop?.createdAt ?? normalizeIsoTimestamp(session.member.startedAt);
      return at === null ? [] : [{ at, harness: session.harness, kind: 'session' as const }];
    }),
    ...events.map(({ at }) => ({ at, harness: null, kind: 'event' as const })),
  ]
    .filter(({ at }) => Date.parse(at) >= start && Date.parse(at) <= Date.parse(now))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow)
    .reverse();
  const latest = (instants: readonly CanonicalInstant[]): CanonicalInstant =>
    instants.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b));
  return {
    episodes,
    evidence,
    truncated,
    row: {
      afterDone: after.length === 0 ? null : { count: after.length, latestAt: latest(after) },
      lastActivityAt: latest([storedActivity, ...dates]),
      links: active,
      markers: { pullRequests, jiraIssues, local },
      marks,
      runningSessions: 0,
      sessionCount: sessions.length,
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
      return {
        source,
        state: runRowsSkipped ? 'unavailable' : 'never-run',
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
    } else if (reads.some((read) => read.truncated.has(source))) {
      state = 'truncated';
    } else if (run.failed > 0) {
      state = observations.some((item) => item?.outcome === 'unauthenticated') ? 'unauthenticated' : 'failed';
    }
    return { source, state, lastRunAt: run.ranAt, message: run.message };
  });
  const evidence = reads.find((read) => read.evidence.revision !== null)?.evidence;
  let sessionState: WorkThreadSourceStatus['state'] = evidence === undefined ? 'never-run' : 'ok';
  if (reads.some((read) => read.truncated.has('sessions'))) {
    sessionState = 'truncated';
  }
  sources.push({
    source: 'sessions',
    state: sessionState,
    lastRunAt: evidence?.generatedAt ?? null,
    message: reads.some((read) => read.truncated.has('sessions'))
      ? 'Some linked session evidence was unavailable or exceeded the read bounds.'
      : null,
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
    return {
      detachedLinks: links.filter((link) => link.detachedAt !== null),
      episodes: read.episodes,
      events,
      generatedAt,
      row: read.row,
      sources: sourcesOf(runStates.runs, [read], thread.machineId, runStates.skipped),
    };
  });
