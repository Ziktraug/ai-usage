import {
  type CanonicalInstant,
  canonicalInstantFromDate,
  parseCanonicalInstant,
} from '@ai-usage/report-core/canonical-instant';
import type {
  CheckoutStatusObservation,
  JiraIssueObservation,
  PullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import {
  branchLinkKey,
  jiraIssueLinkKey,
  parseWorkThreadCommand,
  pullRequestLinkKey,
  sessionLinkKey,
  WORK_THREAD_BOUNDS,
  type WorkThread,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
  type WorkThreadEvent,
  type WorkThreadLink,
  type WorkThreadLinkInput,
} from '@ai-usage/report-core/work-thread';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadDetailDataset,
  type WorkThreadEpisode,
  type WorkThreadListQuery,
  type WorkThreadMarkers,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import type { WorkThreadServerPorts } from './work-threads.server';

export const WORK_THREADS_SYNTHETIC_LABEL = 'Synthetic demo';
export const WORK_THREADS_SYNTHETIC_NOW = parseCanonicalInstant('2026-10-24T11:00:00.000Z');
export const WORK_THREADS_SYNTHETIC_MACHINE = 'fixture-machine';
const MAX_SYNTHETIC_THREADS = 200;
/** Recorded answers kept for replay; the oldest go first, so refused retries cannot grow the process. */
const MAX_SYNTHETIC_RECEIPTS = 2000;
export const WORK_THREADS_FIXTURE_IDS = {
  payments: '12000000-0000-4000-8000-000000000001',
  tests: '12000000-0000-4000-8000-000000000002',
  badges: '12000000-0000-4000-8000-000000000003',
  analysis: '12000000-0000-4000-8000-000000000004',
  uploads: '12000000-0000-4000-8000-000000000005',
  review: '12000000-0000-4000-8000-000000000006',
  sessions: '12000000-0000-4000-8000-000000000007',
  done: '12000000-0000-4000-8000-000000000008',
} as const;

const at = (day: number, time = '09:00'): CanonicalInstant =>
  parseCanonicalInstant(`2026-10-${String(day).padStart(2, '0')}T${time}:00.000Z`);
const repository = 'synthetic/example-shop';
const host = 'github.example';
const machineId = WORK_THREADS_SYNTHETIC_MACHINE;
const syntheticSources: readonly WorkThreadSourceStatus[] = (['checkouts', 'github', 'jira', 'sessions'] as const).map(
  (source) => ({ lastRunAt: WORK_THREADS_SYNTHETIC_NOW, message: WORK_THREADS_SYNTHETIC_LABEL, source, state: 'ok' }),
);

interface FixtureRecord {
  events: WorkThreadEvent[];
  links: WorkThreadLink[];
  readonly markers: WorkThreadMarkers;
  thread: WorkThread;
}

const emptyMarkers = (): WorkThreadMarkers => ({ jiraIssues: [], local: [], pullRequests: [] });
const makeThread = (threadId: string, title: string, overrides: Partial<WorkThread> = {}): WorkThread => ({
  createdAt: at(19),
  doneAt: null,
  doneReason: null,
  followRevision: 1,
  followState: 'following',
  intent: 'change',
  machineId,
  note: null,
  objective: 'Synthetic demo: keep one task through its sessions and source updates.',
  origin: 'user',
  originKey: null,
  projectLabel: 'Example shop',
  threadId,
  title,
  updatedAt: WORK_THREADS_SYNTHETIC_NOW,
  waitingFor: null,
  waitingOn: null,
  ...overrides,
});

const makeEpisode = (
  id: string,
  title: string,
  day: number,
  overrides: Partial<WorkThreadEpisode> = {},
): WorkThreadEpisode => ({
  children: [],
  durationBasis: 'span',
  durationMs: 24 * 60_000,
  endedAt: at(day, '09:44'),
  firstPrompt: 'Synthetic demo: investigate the behavior and explain the next decision.',
  harness: 'claude',
  lastInstruction: 'Keep the change focused and describe what remains.',
  launchedBy: null,
  linkKey: sessionLinkKey({ harness: 'claude', machineId, sessionId: id }),
  machineId,
  origin: 'human',
  projectLabel: 'Example shop',
  question: null,
  result: 'Synthetic observation: the session ended; the task remains yours to follow.',
  resume: { kind: 'none', reason: 'Synthetic demo: this session does not exist in a local harness.' },
  running: false,
  sourceSessionId: id,
  startedAt: at(day, '09:20'),
  title,
  ...overrides,
});

const prMarker = (
  number: number,
  overrides: Partial<PullRequestObservation> = {},
): WorkThreadMarkers['pullRequests'][number] => {
  const observation: PullRequestObservation = {
    accountLabel: 'Synthetic demo',
    baseRef: 'main',
    checksRollup: 'success',
    draft: false,
    headRef: `fix/SHOP-${number}/follow-up`,
    host,
    machineId,
    mergedAt: null,
    number,
    observedAt: WORK_THREADS_SYNTHETIC_NOW,
    outcome: 'observed',
    outcomeMessage: null,
    repository,
    reviewDecision: 'REVIEW_REQUIRED',
    state: 'OPEN',
    title: `Synthetic pull request ${number}`,
    updatedAt: at(23),
    url: `https://${host}/${repository}/pull/${number}`,
    ...overrides,
  };
  return {
    key: pullRequestLinkKey(observation),
    latest: observation,
    latestSuccessful: observation,
    mergeable: 'mergeable',
    mergeStateStatus: 'CLEAN',
    role: 'author',
  };
};

const jiraMarker = (key: string, done = false): WorkThreadMarkers['jiraIssues'][number] => {
  const observation: JiraIssueObservation = {
    assigneeLabel: 'Synthetic operator',
    commentCount: 0,
    comments: [],
    key,
    machineId,
    observedAt: WORK_THREADS_SYNTHETIC_NOW,
    outcome: 'observed',
    outcomeMessage: null,
    parentKey: null,
    sprint: null,
    status: done ? 'Done' : 'In Progress',
    statusCategory: done ? 'done' : 'in-progress',
    summary: `Synthetic ticket ${key}`,
    updatedAt: at(23),
  };
  return { key: jiraIssueLinkKey({ key, site: 'synthetic' }), latest: observation, latestSuccessful: observation };
};

const localMarker = (branch: string, modifiedCount = 0): WorkThreadMarkers['local'][number] => {
  const observation: CheckoutStatusObservation = {
    ahead: 0,
    behind: 0,
    branch,
    checkoutPath: '/synthetic/example-shop',
    dirty: modifiedCount > 0,
    headSha: 'a'.repeat(40),
    lastCommitAt: at(23),
    machineId,
    modifiedCount,
    observedAt: WORK_THREADS_SYNTHETIC_NOW,
    outcome: 'observed',
    stagedCount: 0,
    untrackedCount: 0,
    upstream: `origin/${branch}`,
  };
  return {
    key: branchLinkKey({ host, ref: branch, repository }),
    latest: observation,
    latestSuccessful: observation,
    via: 'branch-link',
  };
};

const seedRecords = (): { readonly records: FixtureRecord[]; readonly episodes: WorkThreadEpisode[] } => {
  const child = makeEpisode('payment-tests', 'Check the retry invariant', 22, {
    harness: 'codex',
    launchedBy: { harness: 'claude', title: 'Add the duplicate payment guard' },
    linkKey: sessionLinkKey({ harness: 'codex', machineId, sessionId: 'payment-tests' }),
    origin: 'delegated',
  });
  const paymentEpisodes = [
    makeEpisode('payment-approaches', 'Compare retry approaches', 19),
    makeEpisode('payment-logs', 'Confirm the cause in the logs', 20),
    makeEpisode('payment-guard', 'Add the duplicate payment guard', 22, { children: [child] }),
    makeEpisode('payment-review', 'Respond to the review', 24, {
      harness: 'codex',
      linkKey: sessionLinkKey({ harness: 'codex', machineId, sessionId: 'payment-review' }),
      result: 'A proposal is ready. No additional change has been published.',
    }),
  ];
  const episodes: WorkThreadEpisode[] = [...paymentEpisodes, child];
  const record = (
    thread: WorkThread,
    markers = emptyMarkers(),
    linkedEpisodes: readonly WorkThreadEpisode[] = [],
  ): FixtureRecord => {
    const inputs: WorkThreadLinkInput[] = [
      ...markers.local.map(({ key }) => ({ key, kind: 'branch' as const })),
      ...markers.pullRequests.map(({ key }) => ({ key, kind: 'pull-request' as const })),
      ...markers.jiraIssues.map(({ key }) => ({ key, kind: 'jira-issue' as const })),
      ...linkedEpisodes.map(({ linkKey }) => ({ key: linkKey, kind: 'session' as const })),
    ];
    for (const episode of linkedEpisodes) {
      if (!episodes.some((item) => item.linkKey === episode.linkKey)) {
        episodes.push(episode);
      }
    }
    return {
      events: [
        {
          acknowledgedRemainders: [],
          at: thread.createdAt,
          eventId: crypto.randomUUID(),
          fromState: null,
          kind: 'created',
          linkKey: null,
          reason: 'Synthetic demo: task created.',
          threadId: thread.threadId,
          toState: thread.followState,
        },
      ],
      links: inputs.map((input) => ({
        ...input,
        createdAt: thread.createdAt,
        detachedAt: null,
        linkId: crypto.randomUUID(),
        provenance: 'user',
        threadId: thread.threadId,
      })),
      markers,
      thread,
    };
  };
  const records = [
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.payments, 'Prevent duplicate payments', {
        objective: 'A payment retry must never charge the same order twice.',
      }),
      {
        jiraIssues: [jiraMarker('SHOP-2085')],
        local: [localMarker('fix/SHOP-2085/payment-retry')],
        pullRequests: [prMarker(1487, { reviewDecision: 'CHANGES_REQUESTED' })],
      },
      [...paymentEpisodes, child],
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.tests, 'Bring the E2E tests up to date'),
      {
        jiraIssues: [],
        local: [localMarker('fix/SHOP-1740/e2e')],
        pullRequests: [
          { ...prMarker(1478, { checksRollup: 'failure' }), mergeable: 'conflicting', mergeStateStatus: 'DIRTY' },
        ],
      },
      [makeEpisode('refresh-tests', 'Inspect the failing browser tests', 19)],
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.badges, 'Clarify promotional badges', {
        followState: 'waiting',
        intent: 'analysis',
        waitingFor: 'A product answer on SHOP-1998',
        waitingOn: {
          kind: 'jira-update',
          linkKey: jiraIssueLinkKey({ key: 'SHOP-1998', site: 'synthetic' }),
          since: at(20),
        },
      }),
      { jiraIssues: [jiraMarker('SHOP-1998')], local: [], pullRequests: [] },
      [makeEpisode('badge-analysis', 'Clarify the promotion rules', 20)],
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.analysis, 'Understand a declined payment', {
        intent: 'analysis',
        objective: 'Explain why the payment was declined. No code change is needed.',
      }),
      emptyMarkers(),
      [
        makeEpisode('payment-analysis', 'Explain the payment refusal', 24, {
          result: 'The bank declined this card. The analysis is complete; no code change is needed.',
        }),
      ],
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.uploads, 'Fix file uploads'),
      {
        jiraIssues: [jiraMarker('SHOP-2086', true)],
        local: [localMarker('fix/SHOP-2086/uploads')],
        pullRequests: [prMarker(1479, { mergedAt: at(23), reviewDecision: 'APPROVED', state: 'MERGED' })],
      },
      [
        makeEpisode('upload-fix', 'Repair upload validation', 20),
        makeEpisode('upload-check', 'Check the file upload fix', 21),
      ],
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.review, 'Check cart rounding', {
        intent: 'review',
        objective: 'Review the rounding change before the author merges it.',
      }),
      { jiraIssues: [], local: [], pullRequests: [{ ...prMarker(1492), role: 'review-requested' }] },
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.sessions, 'Connect sessions to a task', {
        projectLabel: 'ai-usage',
        objective: 'Keep related sessions together without inferring links from timing.',
      }),
      { jiraIssues: [], local: [localMarker('feat/work-threads', 3)], pullRequests: [] },
      [
        makeEpisode('thread-implementation', 'Implement explicit session links', 24, {
          endedAt: null,
          durationBasis: 'unknown',
          durationMs: null,
          projectLabel: 'ai-usage',
          running: true,
        }),
      ],
    ),
    record(
      makeThread(WORK_THREADS_FIXTURE_IDS.done, 'Review the receipt wording', {
        doneAt: at(23),
        followState: 'done',
        intent: 'review',
        doneReason: 'The wording review is complete.',
      }),
      emptyMarkers(),
      [makeEpisode('receipt-review', 'Review receipt copy', 21)],
    ),
  ];
  // These identities belong to the existing synthetic served-session client used by /work/sessions.
  // Keeping them here lets the real picker query link that existing session into the same task.
  episodes.push(
    makeEpisode('campaign-root', 'Build report UI', 19, {
      harness: 'codex',
      linkKey: sessionLinkKey({ harness: 'codex', machineId, sessionId: 'campaign-root' }),
      projectLabel: 'ai-usage',
      startedAt: parseCanonicalInstant('2026-06-11T08:00:00.000Z'),
      endedAt: parseCanonicalInstant('2026-06-11T09:42:00.000Z'),
      durationMs: 102 * 60_000,
    }),
    makeEpisode('campaign-child', 'Review analytics model', 19, {
      harness: 'codex',
      linkKey: sessionLinkKey({ harness: 'codex', machineId, sessionId: 'campaign-child' }),
      origin: 'delegated',
      projectLabel: 'ai-usage',
      startedAt: parseCanonicalInstant('2026-06-10T18:15:00.000Z'),
      endedAt: parseCanonicalInstant('2026-06-10T18:44:00.000Z'),
      durationMs: 29 * 60_000,
    }),
    makeEpisode('opencode-classifier', 'Tune collector fixtures', 19, {
      harness: 'codex',
      linkKey: sessionLinkKey({ harness: 'codex', machineId, sessionId: 'opencode-classifier' }),
      origin: 'automated-review',
      projectLabel: 'ai-usage',
      startedAt: parseCanonicalInstant('2026-05-25T13:05:00.000Z'),
      endedAt: parseCanonicalInstant('2026-05-25T14:18:00.000Z'),
      durationMs: 73 * 60_000,
    }),
    makeEpisode('cursor-fixture', 'Explore report sketch', 19, {
      harness: 'cursor',
      machineId: 'fixture-machine-secondary',
      linkKey: sessionLinkKey({
        harness: 'cursor',
        machineId: 'fixture-machine-secondary',
        sessionId: 'cursor-fixture',
      }),
      origin: null,
      projectLabel: 'ai-usage',
      startedAt: parseCanonicalInstant('2026-04-12T09:20:00.000Z'),
      endedAt: parseCanonicalInstant('2026-04-12T10:05:00.000Z'),
      durationMs: 45 * 60_000,
    }),
    makeEpisode('claude-history-fallback', 'Recover Claude history', 19, {
      projectLabel: 'ai-usage',
      origin: null,
      startedAt: parseCanonicalInstant('2026-06-09T18:15:00.000Z'),
      endedAt: parseCanonicalInstant('2026-06-09T18:44:00.000Z'),
      durationMs: 29 * 60_000,
    }),
  );
  return { episodes, records };
};

const fail = (
  failure: Extract<WorkThreadCommandResult, { readonly ok: false }>['failure'],
  currentRevision: number | null,
  message: string,
): WorkThreadCommandResult => ({ currentRevision, failure, message, ok: false });

const result = (thread: WorkThread, applied = true): WorkThreadCommandResult => ({
  applied,
  followRevision: thread.followRevision,
  ok: true,
  threadId: thread.threadId,
});

/** No disk, harness or source API is consulted. Each instance owns its commands and fictional facts. */
export const createSyntheticWorkThreadStore = (
  options: {
    readonly now?: () => Date;
    readonly seed?: boolean;
    readonly sources?: readonly WorkThreadSourceStatus[];
  } = {},
): WorkThreadServerPorts => {
  const initial = options.seed === false ? { episodes: [], records: [] } : seedRecords();
  const records = new Map(initial.records.map((record) => [record.thread.threadId, record]));
  const episodes = new Map(initial.episodes.map((episode) => [episode.linkKey, episode]));
  const jiraFacts = new Map(
    initial.records.flatMap((record) => record.markers.jiraIssues.map((marker) => [marker.key, marker] as const)),
  );
  const localFacts = new Map(
    initial.records.flatMap((record) => record.markers.local.map((marker) => [marker.key, marker] as const)),
  );
  const pullRequestFacts = new Map(
    initial.records.flatMap((record) => record.markers.pullRequests.map((marker) => [marker.key, marker] as const)),
  );
  const commands = new Map<string, WorkThreadCommandResult>();
  const now = (): CanonicalInstant => canonicalInstantFromDate(options.now?.() ?? new Date(WORK_THREADS_SYNTHETIC_NOW));
  const sources = options.sources ?? syntheticSources;

  const activeLinks = (record: FixtureRecord): WorkThreadLink[] =>
    record.links.filter((link) => link.detachedAt === null);
  const linkedEpisodes = (record: FixtureRecord): WorkThreadEpisode[] => {
    const keys = new Set(
      activeLinks(record)
        .filter((link) => link.kind === 'session')
        .map((link) => link.key),
    );
    const visible = [...keys].flatMap((key) => {
      const episode = episodes.get(key);
      return episode ? [{ ...episode, children: episode.children.filter((child) => keys.has(child.linkKey)) }] : [];
    });
    const children = new Set(visible.flatMap((episode) => episode.children.map((child) => child.linkKey)));
    return visible.filter((episode) => !children.has(episode.linkKey));
  };
  const toRow = (record: FixtureRecord): WorkThreadRow => {
    const links = activeLinks(record);
    const sessionEpisodes = links.flatMap((link) => {
      const episode = link.kind === 'session' ? episodes.get(link.key) : undefined;
      return episode ? [episode] : [];
    });
    const marks = [
      ...sessionEpisodes.map((episode) => ({
        at: episode.startedAt,
        harness: episode.harness,
        kind: 'session' as const,
      })),
      ...record.events.map((event) => ({ at: event.at, harness: null, kind: 'event' as const })),
    ]
      .sort((left, right) => left.at.localeCompare(right.at))
      .slice(-WORK_THREAD_VIEW_BOUNDS.maxMarksPerRow);
    const markers: WorkThreadMarkers = {
      jiraIssues: links
        .filter((link) => link.kind === 'jira-issue')
        .map(
          ({ key }) =>
            jiraFacts.get(key) ?? {
              key,
              latest: null,
              latestSuccessful: null,
            },
        ),
      local: links
        .filter((link) => link.kind === 'branch')
        .map(
          ({ key }) =>
            localFacts.get(key) ?? {
              key,
              latest: null,
              latestSuccessful: null,
              via: 'branch-link',
            },
        ),
      pullRequests: links
        .filter((link) => link.kind === 'pull-request')
        .map(
          ({ key }) =>
            pullRequestFacts.get(key) ?? {
              key,
              latest: null,
              latestSuccessful: null,
              mergeable: null,
              mergeStateStatus: null,
              role: null,
            },
        ),
    };
    const doneAt = record.thread.doneAt;
    const newer =
      doneAt === null
        ? []
        : [
            ...marks.map((mark) => mark.at),
            ...[...markers.jiraIssues, ...markers.local, ...markers.pullRequests].flatMap((marker) =>
              marker.latest === null ? [] : [marker.latest.observedAt],
            ),
          ]
            .filter((instant) => instant > doneAt)
            .sort();
    const latestAt = newer.at(-1);
    return {
      afterDone: latestAt ? { count: newer.length, latestAt } : null,
      lastActivityAt: marks.at(-1)?.at ?? record.thread.updatedAt,
      links,
      markers,
      marks,
      runningSessions: sessionEpisodes.filter((episode) => episode.running === true).length,
      sessionCount: sessionEpisodes.length,
      thread: record.thread,
    };
  };
  const appendEvent = (
    record: FixtureRecord,
    event: Partial<WorkThreadEvent> & Pick<WorkThreadEvent, 'kind'>,
  ): void => {
    record.events.push({
      acknowledgedRemainders: [],
      at: now(),
      eventId: crypto.randomUUID(),
      fromState: null,
      linkKey: null,
      reason: null,
      threadId: record.thread.threadId,
      toState: null,
      ...event,
    });
    record.thread = { ...record.thread, updatedAt: now() };
  };
  const addLink = (record: FixtureRecord, input: WorkThreadLinkInput): boolean => {
    if (activeLinks(record).some((link) => link.kind === input.kind && link.key === input.key)) {
      return false;
    }
    // Explicit reattachment creates a new association; the old detached link remains in history.
    record.links.push({
      key: input.key,
      kind: input.kind,
      createdAt: now(),
      detachedAt: null,
      linkId: crypto.randomUUID(),
      provenance: 'user',
      threadId: record.thread.threadId,
    });
    appendEvent(record, { kind: 'link-added', linkKey: input.key });
    return true;
  };
  const apply = (command: WorkThreadCommand): WorkThreadCommandResult => {
    if (command.op === 'create') {
      // Seeded and Done tasks count too. Receipt replay happens before applying a new command.
      if (records.size >= MAX_SYNTHETIC_THREADS) {
        return fail(
          'invalid-transition',
          null,
          `Synthetic demo has reached its limit of ${MAX_SYNTHETIC_THREADS} tasks. Restart the demo to create more.`,
        );
      }
      const thread = makeThread(crypto.randomUUID(), command.title, {
        createdAt: now(),
        updatedAt: now(),
        intent: command.intent,
        objective: command.objective,
        projectLabel: command.projectLabel,
      });
      const record: FixtureRecord = { events: [], links: [], markers: emptyMarkers(), thread };
      appendEvent(record, { kind: 'created', toState: 'following' });
      for (const link of command.links) {
        addLink(record, link);
      }
      records.set(thread.threadId, record);
      return result(record.thread);
    }
    const record = records.get(command.threadId);
    if (!record) {
      return fail('not-found', null, 'This task could not be found.');
    }
    const revision = record.thread.followRevision;
    switch (command.op) {
      case 'set-follow-state': {
        if (command.expectedRevision !== revision) {
          return fail(
            'revision-conflict',
            revision,
            'This task changed in another tab. Reload it before trying again.',
          );
        }
        if (command.to === record.thread.followState) {
          return fail('invalid-transition', revision, 'This task already has that follow state.');
        }
        if (record.thread.followState === 'done' && command.to !== 'following') {
          return fail('invalid-transition', revision, 'Reopen this task before marking it as waiting.');
        }
        if (command.waitingOn !== null) {
          const kind = command.waitingOn.kind === 'pull-request-review' ? 'pull-request' : 'jira-issue';
          if (!activeLinks(record).some((link) => link.kind === kind && link.key === command.waitingOn?.linkKey)) {
            return fail('invalid-link', revision, 'The waiting source must be linked to this task.');
          }
        }
        const fromState = record.thread.followState;
        record.thread = {
          ...record.thread,
          doneAt: command.to === 'done' ? now() : null,
          doneReason: command.to === 'done' ? command.reason : null,
          followRevision: revision + 1,
          followState: command.to,
          waitingFor: command.to === 'waiting' ? command.waitingFor : null,
          waitingOn: command.to === 'waiting' ? command.waitingOn : null,
        };
        appendEvent(record, {
          acknowledgedRemainders: command.acknowledgedRemainders,
          fromState,
          kind: 'follow-state',
          reason: command.reason,
          toState: command.to,
        });
        return result(record.thread);
      }
      case 'link': {
        const existing = activeLinks(record).some((link) => link.kind === command.kind && link.key === command.key);
        if (!existing && activeLinks(record).length >= WORK_THREAD_BOUNDS.maxLinksPerThread) {
          return fail('invalid-link', revision, 'This task has reached its linked source limit.');
        }
        return result(record.thread, addLink(record, command));
      }
      case 'detach-link': {
        const link = record.links.find((candidate) => candidate.linkId === command.linkId);
        if (!link) {
          return fail('invalid-link', revision, 'This source is not linked to the task.');
        }
        if (link.detachedAt !== null) {
          return result(record.thread, false);
        }
        record.links = record.links.map((candidate) =>
          candidate.linkId === link.linkId ? { ...candidate, detachedAt: now() } : candidate,
        );
        appendEvent(record, { kind: 'link-detached', linkKey: link.key });
        return result(record.thread);
      }
      case 'set-note': {
        const changed = record.thread.note !== command.note;
        if (changed) {
          record.thread = { ...record.thread, note: command.note };
          appendEvent(record, { kind: 'note', reason: command.note });
        }
        return result(record.thread, changed);
      }
      case 'rename': {
        const changed = record.thread.title !== command.title;
        if (changed) {
          record.thread = { ...record.thread, title: command.title };
          appendEvent(record, { kind: 'renamed', reason: command.title });
        }
        return result(record.thread, changed);
      }
      default: {
        const unsupported: never = command;
        throw new TypeError(`Unsupported task command: ${String(unsupported)}`);
      }
    }
  };
  const matches = (record: FixtureRecord, query: WorkThreadListQuery): boolean => {
    if (query.project !== null && record.thread.projectLabel !== query.project) {
      return false;
    }
    const searchable = [
      record.thread.title,
      record.thread.objective,
      ...activeLinks(record).map((link) => link.key),
      ...activeLinks(record).map((link) => episodes.get(link.key)?.title),
    ]
      .join(' ')
      .toLocaleLowerCase('en');
    return query.search === null || searchable.includes(query.search.trim().toLocaleLowerCase('en'));
  };
  return {
    executeCommand: (input) => {
      const command = parseWorkThreadCommand(input);
      if (!command) {
        return Promise.reject(new TypeError('The task command is invalid.'));
      }
      const previous = commands.get(command.commandId);
      if (previous) {
        return Promise.resolve(structuredClone(previous.ok ? { ...previous, applied: false } : previous));
      }
      const outcome = apply(command);
      commands.set(command.commandId, structuredClone(outcome));
      if (commands.size > MAX_SYNTHETIC_RECEIPTS) {
        const oldest = commands.keys().next().value;
        if (oldest !== undefined) {
          commands.delete(oldest);
        }
      }
      return Promise.resolve(structuredClone(outcome));
    },
    readDetail: (threadId) => {
      const record = records.get(threadId);
      const data: WorkThreadDetailDataset | null = record
        ? {
            // Keep association history in the store; the wire projection has the frozen link bound.
            detachedLinks: record.links
              .filter((link) => link.detachedAt !== null)
              .slice(-WORK_THREAD_BOUNDS.maxLinksPerThread),
            episodes: linkedEpisodes(record).slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodes),
            events: record.events.slice(-WORK_THREAD_BOUNDS.maxEventsPerThread),
            generatedAt: now(),
            row: toRow(record),
            sources,
          }
        : null;
      return Promise.resolve(structuredClone(data));
    },
    readList: (query) => {
      const matching = [...records.values()].filter((record) => matches(record, query));
      const counts = {
        done: matching.filter((record) => record.thread.followState === 'done').length,
        open: matching.filter((record) => record.thread.followState !== 'done').length,
      };
      const rows = matching
        .filter((record) =>
          query.tab === 'done' ? record.thread.followState === 'done' : record.thread.followState !== 'done',
        )
        .sort((left, right) => left.thread.threadId.localeCompare(right.thread.threadId));
      const fingerprint = JSON.stringify([query.project, query.search, query.tab]);
      let offset = 0;
      if (query.cursor !== null) {
        const [position, scope] = query.cursor.split(':');
        offset = Number(position);
        if (!Number.isSafeInteger(offset) || offset < 0 || scope !== encodeURIComponent(fingerprint)) {
          return Promise.reject(new TypeError('The task list cursor is invalid for these filters.'));
        }
      }
      const limit = Math.max(1, Math.min(query.limit, WORK_THREAD_VIEW_BOUNDS.maxPageSize));
      const next = offset + limit;
      return Promise.resolve(
        structuredClone({
          counts,
          generatedAt: now(),
          machineId,
          nextCursor: next < rows.length ? `${next}:${encodeURIComponent(fingerprint)}` : null,
          projects: [
            ...new Set(
              [...records.values()].flatMap((record) =>
                record.thread.projectLabel === null ? [] : [record.thread.projectLabel],
              ),
            ),
          ]
            .sort()
            .slice(0, WORK_THREAD_VIEW_BOUNDS.maxProjects),
          rows: rows.slice(offset, next).map(toRow),
          sources,
        }),
      );
    },
  };
};

const processStores = new Map<'demo' | 'e2e', WorkThreadServerPorts>();
/** Shared within this server process so browser tabs observe the same revisions; never persisted. */
export const getSyntheticWorkThreadPorts = (mode: 'demo' | 'e2e'): WorkThreadServerPorts => {
  let store = processStores.get(mode);
  if (!store) {
    store = createSyntheticWorkThreadStore();
    processStores.set(mode, store);
  }
  return store;
};
