/**
 * A synthetic Claude Desktop session registry, in the attested `local_<uuid>.json` shape
 * (`<registry>/<account>/<org>/local_*.json`, millisecond epochs, `postTurnSummary`,
 * `spawnedFrom`, `backgroundTaskSuggestions`, `prs`, `sideSessionNotes`), produced as documents
 * so that a file-based seed (`@ai-usage/local-machine/testing/harness-home`) and an in-memory
 * composition (the web e2e fixture) describe exactly the same sessions. Every id, title and path
 * is invented; paths stay under the fixture home; a proposal's `prompt` carries a sentinel so
 * consumers can prove it never leaves the normalizer.
 *
 * Ages are relative to a fixed epoch so the same input yields the same documents on every run,
 * and each document names a modification time (`lastActivityAt + 1 min`) for the file seed to pin.
 */

export type ClaudeDesktopSessionsFixtureVariant = 'minimal' | 'representative';

export const CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL = 'PRIVATE_DESKTOP_PROMPT_SENTINEL_117';
export const CLAUDE_DESKTOP_FIXTURE_DEFAULT_EPOCH = new Date('2026-10-20T12:00:00.000Z');
/** A spawn origin no registry file carries: its child must surface as a root with a coverage gap. */
export const CLAUDE_DESKTOP_FIXTURE_MISSING_PARENT_ID = 'local_fixture-missing-parent';
export const CLAUDE_DESKTOP_FIXTURE_PAIRS = [
  { account: 'account-fixture-0001', organization: 'org-fixture-0001' },
  { account: 'account-fixture-0002', organization: 'org-fixture-0002' },
] as const;

export interface SeededClaudeDesktopSessionIds {
  /**
   * ADR 0056 scenarios (representative only): `answeredRoot` asked Q1, received a message, then
   * asked Q2 (its earlier sweep is in `history`); `repliedRoot` received a message after its
   * question and kept its summary while working (one earlier sweep); `unrelatedPullRequestRoot`
   * asks something no pull request answers while a child that predates the question lists one;
   * `laterOfferRoot` carries a proposal offered before a later message, an expired one and the
   * last offer; `handledRoot` was followed by a session started from it and completed;
   * `continuedRoot` by one started from it that is still review-ready.
   */
  readonly answeredRoot: string | null;
  /** Completed long ago and archived; listed in `archived-sessions.idx`. */
  readonly archivedRoot: string | null;
  /** Two children of `blockedRoot`, one review-ready and one completed. */
  readonly blockedChildren: readonly string[];
  /** Blocked with a `needs_action`; the one session whose `cliSessionId` has a seeded transcript. */
  readonly blockedRoot: string;
  /** Completed with an OPEN declared pull request and written branches. */
  readonly completedRoot: string;
  readonly continuedRoot: string | null;
  readonly handledRoot: string | null;
  readonly laterOfferRoot: string | null;
  /** Blocked asking to push; its child declared, from a worktree of its own, a MERGED pull request *before* the declaration. */
  readonly mergedBeforeRoot: string | null;
  /** Completed; its `cliSessionId` has no transcript anywhere. */
  readonly noTranscriptRoot: string | null;
  /** A child whose `spawnedFrom` names a session the registry does not contain. */
  readonly orphanChild: string | null;
  /** Completed with open proposals and resolved ones (`started_notified`, `dismissed`). */
  readonly proposalRoot: string | null;
  readonly repliedRoot: string | null;
  readonly reviewReadyRoot: string | null;
  /** The child of `satisfiedRoot` that declared, from a worktree of its own, the pull request the root asked for. */
  readonly satisfiedChild: string | null;
  /** Blocked asking to open a pull request, which `satisfiedChild` later declared OPEN. */
  readonly satisfiedRoot: string | null;
  /** Blocked 40 days before the epoch. */
  readonly staleRoot: string | null;
  readonly unrelatedPullRequestRoot: string | null;
  /** Required identity present, `postTurnSummary.status_category` unknown. */
  readonly unsupported: string;
}

export interface ClaudeDesktopFixtureDocument {
  readonly account: string;
  /** The registry file content, exactly as Claude Desktop would write it. */
  readonly document: Readonly<Record<string, unknown>>;
  readonly fileName: string;
  /** The file modification time the seed pins: `lastActivityAt + 1 min`. */
  readonly modifiedAt: Date;
  readonly organization: string;
  readonly sessionId: string;
}

export interface ClaudeDesktopFixtureRegistry {
  /** Session ids per account/organization pair, for `archived-sessions.idx`. */
  readonly archivedByPair: readonly (readonly string[])[];
  readonly childCount: number;
  readonly cliSessionIds: {
    readonly blockedRoot: string;
    readonly noTranscriptRoot: string | null;
  };
  readonly documents: readonly ClaudeDesktopFixtureDocument[];
  readonly epoch: string;
  /**
   * Earlier states of some registry files, oldest first, as a sweep before the epoch saw them:
   * the file Claude Desktop had written then, before it rewrote it into its `documents` state.
   * A consumer that records declaration history replays them before `documents`; a single sweep
   * (the file seed) only ever sees `documents`.
   */
  readonly history: readonly ClaudeDesktopFixtureDocument[];
  readonly ids: SeededClaudeDesktopSessionIds;
  readonly rootCount: number;
  readonly variant: ClaudeDesktopSessionsFixtureVariant;
}

export interface ClaudeDesktopFixtureOptions {
  /** The transcript id the seeded Claude home carries; `blockedRoot` joins to it. */
  readonly cliSessionIdWithTranscript: string;
  readonly epoch?: Date;
  /** The seeded repository checkout; every `cwd` is this path or a worktree under it. */
  readonly repository: string;
  readonly variant: ClaudeDesktopSessionsFixtureVariant;
}

type TurnStatus = 'blocked' | 'completed' | 'review_ready';

interface DeclaredPullRequestSpec {
  readonly number: number;
  readonly state: 'MERGED' | 'OPEN';
}

interface ProposalSpec {
  readonly createdHoursAgo: number;
  /** Claude Desktop sets an expiry seven days after the offer on current files. */
  readonly expiresHoursAgo: number;
  readonly title: string;
}

/** An earlier state of the same file: the turn it declared then, and the latest message at that time. */
interface EarlierTurnSpec {
  readonly ageHours: number;
  readonly frameHoursAgo: number;
  readonly needsAction?: string;
  /** `true` keeps the final summary (same turn, the session went on working); else an earlier turn. */
  readonly sameTurn?: boolean;
  readonly status: TurnStatus;
}

interface SessionSpec {
  readonly ageHours: number;
  readonly archived?: boolean;
  readonly children?: readonly SessionSpec[];
  readonly cliSessionId?: string;
  /** Defaults to two hours before the last activity. */
  readonly createdHoursAgo?: number;
  readonly earlierTurns?: readonly EarlierTurnSpec[];
  /** `latestUserFrameAt`; defaults to ten minutes before the last activity (the message the turn answered). */
  readonly frameHoursAgo?: number;
  readonly id: string;
  readonly needsAction?: string;
  readonly notes?: number;
  readonly openSuggestions?: number;
  readonly pair: 0 | 1;
  readonly proposals?: readonly ProposalSpec[];
  readonly pullRequests?: readonly DeclaredPullRequestSpec[];
  readonly resolvedSuggestions?: Record<string, 'dismissed' | 'started_notified'>;
  readonly sideSession?: boolean;
  readonly spawnedFromId?: string;
  readonly status?: TurnStatus;
  readonly title: string;
  readonly unsupportedShape?: boolean;
  /** `true` sits the session in the shared `checkout-3` worktree; a string names a worktree of its own. */
  readonly worktree?: boolean | string;
  readonly wrapUp?: boolean;
  readonly writtenBranches?: readonly string[];
}

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
const DETAIL_BY_STATUS: Record<TurnStatus, string> = {
  blocked: 'Stopped at a question the fixture cannot answer alone.',
  completed: 'Finished the requested change.',
  review_ready: 'The change is ready for a review.',
};

const id = (name: string): string => `local_fixture-${name}`;

const minimalSpecs = (cliSessionIdWithTranscript: string): readonly SessionSpec[] => [
  {
    ageHours: 1,
    children: [
      {
        ageHours: 0.5,
        id: id('blocked-child-1'),
        pair: 0,
        sideSession: true,
        status: 'review_ready',
        title: 'Enquête',
      },
      { ageHours: 0.75, id: id('blocked-child-2'), pair: 0, status: 'completed', title: 'Fixture: child two' },
    ],
    cliSessionId: cliSessionIdWithTranscript,
    id: id('blocked-root'),
    needsAction: 'Confirm whether the fixture should keep checkout 3 or delete it.',
    notes: 2,
    pair: 0,
    status: 'blocked',
    title: 'Fixture: investigate checkout 3',
    worktree: true,
    wrapUp: true,
    writtenBranches: ['fixture/checkout-3'],
  },
  {
    ageHours: 8,
    id: id('completed-root'),
    pair: 1,
    pullRequests: [{ number: 118, state: 'OPEN' }],
    status: 'completed',
    title: 'Fixture: ship the collector',
    writtenBranches: ['fixture/collector', 'fixture/collector-docs'],
  },
  { ageHours: 7, id: id('unsupported'), pair: 0, title: 'Fixture: unknown shape', unsupportedShape: true },
];

const representativeSpecs = (cliSessionIdWithTranscript: string): readonly SessionSpec[] => {
  const filler: SessionSpec[] = Array.from({ length: 11 }, (_value, index) => {
    const ordinal = index + 1;
    const pair: 0 | 1 = ordinal % 2 === 0 ? 1 : 0;
    const ageHours = 20 + ordinal * 3 * DAY_HOURS;
    const children: SessionSpec[] =
      ordinal <= 3
        ? Array.from({ length: 3 }, (_child, childIndex) => ({
            ageHours: ageHours - 1 - childIndex,
            id: id(`routine-${ordinal}-child-${childIndex + 1}`),
            pair,
            sideSession: childIndex === 0,
            status: childIndex === 1 ? 'blocked' : 'completed',
            title: `Fixture: routine ${ordinal} child ${childIndex + 1}`,
          }))
        : [];
    return {
      ageHours,
      children,
      id: id(`routine-${ordinal}`),
      pair,
      ...(ordinal % 4 === 0 ? { resolvedSuggestions: { [`task_routine_${ordinal}`]: 'started_notified' } } : {}),
      status: ordinal % 5 === 0 ? 'blocked' : 'completed',
      ...(ordinal % 5 === 0 ? { needsAction: `Answer routine question ${ordinal}.` } : {}),
      title: `Fixture: routine session ${ordinal}`,
      worktree: ordinal % 3 === 0,
    };
  });
  return [
    ...minimalSpecs(cliSessionIdWithTranscript),
    {
      ageHours: 5,
      children: [
        {
          ageHours: 3,
          id: id('satisfied-child'),
          pair: 1,
          pullRequests: [{ number: 117, state: 'OPEN' }],
          status: 'completed',
          title: 'Fixture: open the collector pull request',
          // In a worktree of its own: a listing from the root's checkout would only mirror it.
          worktree: 'collector-pr',
          writtenBranches: ['fixture/collector-pr'],
        },
      ],
      id: id('satisfied-root'),
      needsAction: 'Open the pull request for the collector branch and push it.',
      pair: 1,
      status: 'blocked',
      title: 'Fixture: collector branch awaiting a pull request',
    },
    {
      ageHours: 6,
      children: [
        {
          ageHours: 30,
          id: id('merged-before-child'),
          pair: 0,
          pullRequests: [{ number: 90, state: 'MERGED' }],
          status: 'completed',
          title: 'Fixture: earlier merged fix',
          // In a worktree of its own, so the listing is the child's and only its timing rules it out.
          worktree: 'earlier-fix',
        },
      ],
      id: id('merged-before-root'),
      needsAction: 'Push the fix and merge it.',
      pair: 0,
      status: 'blocked',
      title: 'Fixture: push the merged fix',
    },
    {
      ageHours: 10,
      children: [{ ageHours: 9, id: id('proposal-child'), pair: 1, status: 'completed', title: 'Enquête' }],
      id: id('proposal-root'),
      openSuggestions: 2,
      pair: 1,
      resolvedSuggestions: { task_fixture_done: 'started_notified', task_fixture_gone: 'dismissed' },
      status: 'completed',
      title: 'Fixture: proposals pending',
    },
    {
      ageHours: 12,
      children: [
        {
          ageHours: 11,
          id: id('review-child-1'),
          pair: 0,
          sideSession: true,
          status: 'completed',
          title: 'Fixture: review child 1',
        },
        { ageHours: 11.5, id: id('review-child-2'), pair: 0, status: 'review_ready', title: 'Fixture: review child 2' },
      ],
      id: id('review-ready-root'),
      pair: 0,
      status: 'review_ready',
      title: 'Fixture: review the store migration',
    },
    {
      ageHours: 40 * DAY_HOURS,
      id: id('stale-root'),
      needsAction: 'Answer the stale question.',
      pair: 1,
      status: 'blocked',
      title: 'Fixture: stale declaration',
    },
    {
      ageHours: 20 * DAY_HOURS,
      archived: true,
      id: id('archived-root'),
      pair: 0,
      status: 'completed',
      title: 'Fixture: archived investigation',
    },
    {
      ageHours: 2,
      cliSessionId: 'cli-fixture-missing-transcript',
      id: id('no-transcript-root'),
      pair: 1,
      status: 'completed',
      title: 'Fixture: no transcript',
    },
    {
      ageHours: 4,
      id: id('orphan-child'),
      pair: 0,
      spawnedFromId: CLAUDE_DESKTOP_FIXTURE_MISSING_PARENT_ID,
      status: 'review_ready',
      title: 'Fixture: orphan child',
    },
    // A child of a child: it must fold under the blocked root, not vanish between two levels.
    {
      ageHours: 0.6,
      id: id('blocked-grandchild-1'),
      pair: 0,
      spawnedFromId: id('blocked-child-1'),
      status: 'completed',
      title: 'Fixture: grandchild of checkout 3',
    },
    { ageHours: 15, id: id('enquete-1'), pair: 1, status: 'completed', title: 'Enquête' },
    { ageHours: 26, id: id('enquete-2'), pair: 0, status: 'completed', title: 'Enquête' },
    // ADR 0056: what Claude Desktop recorded after a request.
    // Q1, a message at 4 h, then Q2: the earlier file state carries Q1 (in `history`).
    {
      ageHours: 3,
      earlierTurns: [
        { ageHours: 5, frameHoursAgo: 5.5, needsAction: 'Keep the compact layout or the airy one?', status: 'blocked' },
      ],
      frameHoursAgo: 4,
      id: id('answered-root'),
      needsAction: 'Delete the superseded layout branch now?',
      pair: 1,
      status: 'blocked',
      title: 'Fixture: settle the layout',
    },
    // A message at 2 h after the question of 2.5 h; the session works on, its summary unchanged.
    {
      ageHours: 1.5,
      earlierTurns: [{ ageHours: 2.5, frameHoursAgo: 2.75, sameTurn: true, status: 'blocked' }],
      frameHoursAgo: 2,
      id: id('replied-root'),
      needsAction: 'Rename the export column to “cost (approx.)”?',
      pair: 0,
      status: 'blocked',
      title: 'Fixture: export column wording',
    },
    // A question no pull request answers; a child that predates it lists one afterwards.
    {
      ageHours: 9,
      children: [
        {
          ageHours: 8,
          createdHoursAgo: 10,
          id: id('unrelated-pr-child'),
          pair: 0,
          pullRequests: [{ number: 131, state: 'OPEN' }],
          status: 'completed',
          title: 'Fixture: tidy the settings copy',
          worktree: 'settings-copy',
        },
      ],
      id: id('unrelated-pr-root'),
      needsAction: 'Keep the “Sources” label or rename it “Inputs”?',
      pair: 0,
      status: 'blocked',
      title: 'Fixture: settings panel naming',
    },
    // One offer made before a later message, one expired, and the last offer.
    {
      ageHours: 4,
      frameHoursAgo: 4.5,
      id: id('later-offer-root'),
      pair: 1,
      proposals: [
        { createdHoursAgo: 6, expiresHoursAgo: -162, title: 'Fixture: offer before your message' },
        { createdHoursAgo: 200, expiresHoursAgo: 32, title: 'Fixture: expired offer' },
        { createdHoursAgo: 4.05, expiresHoursAgo: -164, title: 'Fixture: latest offer' },
      ],
      status: 'completed',
      title: 'Fixture: follow-ups after the import',
    },
    // A session started from the root after its question, and completed: handled there.
    {
      ageHours: 8,
      children: [
        {
          ageHours: 6,
          createdHoursAgo: 7.5,
          id: id('handled-child'),
          pair: 1,
          sideSession: true,
          status: 'completed',
          title: 'Fixture: fix the flaky export test',
          worktree: 'flaky-export',
        },
      ],
      id: id('handled-root'),
      needsAction: 'Fix the flaky export test before the release, or skip it?',
      pair: 1,
      status: 'blocked',
      title: 'Fixture: release checklist',
    },
    // A session started from the root after its question, still review-ready: to reconsider.
    {
      ageHours: 7,
      children: [
        {
          ageHours: 5.5,
          createdHoursAgo: 6.5,
          id: id('continued-child'),
          pair: 0,
          sideSession: true,
          status: 'review_ready',
          title: 'Fixture: toolbar icon study',
          worktree: 'toolbar-icons',
        },
      ],
      id: id('continued-root'),
      needsAction: 'Which icon set should the toolbar use?',
      pair: 0,
      status: 'blocked',
      title: 'Fixture: toolbar refresh',
    },
    ...filler,
  ];
};

interface FlatSpec extends SessionSpec {
  readonly parentId: string | null;
}

const flatten = (specs: readonly SessionSpec[]): FlatSpec[] =>
  specs.flatMap((spec) => [
    { ...spec, parentId: spec.spawnedFromId ?? null },
    ...(spec.children ?? []).map((child) => ({ ...child, parentId: spec.id })),
  ]);

const MINUTE_MS = 60_000;
/** Ten minutes: the default gap between the message a turn answered and the turn's end. */
const DEFAULT_FRAME_LEAD_HOURS = 1 / 6;

/** An earlier state of a file names the turn it declared then; `null` is the final state. */
interface DocumentTurn {
  readonly index: number;
  readonly turn: EarlierTurnSpec;
}

const registryDocument = (
  spec: FlatSpec,
  input: { readonly epochMs: number; readonly repository: string },
  ordinal: number,
  earlier: DocumentTurn | null = null,
): Record<string, unknown> => {
  const lastActivityAt = input.epochMs - (earlier?.turn.ageHours ?? spec.ageHours) * HOUR_MS;
  const createdAt = input.epochMs - (spec.createdHoursAgo ?? spec.ageHours + 2) * HOUR_MS;
  const frameHoursAgo = earlier?.turn.frameHoursAgo ?? spec.frameHoursAgo ?? spec.ageHours + DEFAULT_FRAME_LEAD_HOURS;
  const earlierTurn = earlier !== null && earlier.turn.sameTurn !== true ? earlier.turn : null;
  const cliSessionId = spec.cliSessionId ?? `cli-fixture-${spec.id.slice('local_fixture-'.length)}`;
  const worktreeName = typeof spec.worktree === 'string' ? spec.worktree : 'checkout-3';
  const worktreePath = `${input.repository}/.claude/worktrees/${worktreeName}`;
  const summarizesUuid =
    earlierTurn === null || earlier === null
      ? `assistant-${ordinal}`
      : `assistant-${ordinal}-earlier-${earlier.index + 1}`;
  const status: TurnStatus = earlierTurn?.status ?? spec.status ?? 'completed';
  const needsAction = earlierTurn === null ? spec.needsAction : earlierTurn.needsAction;
  const detail = DETAIL_BY_STATUS[status];
  return {
    alwaysAllowedReasons: [],
    autoChosenInApp: true,
    autoModeServerFallbackPrompt: false,
    bridgeSessionIds: [],
    chromePermissionMode: 'default',
    classifierSummaryEnabled: true,
    cliSessionId,
    completedTurns: 3 + (ordinal % 4),
    createdAt,
    cwd: spec.worktree ? worktreePath : input.repository,
    effort: ordinal % 2 === 0 ? 'high' : 'medium',
    gitAnchors: [{ commonDir: `${input.repository}/.git`, gitRoot: input.repository, trustedAt: createdAt }],
    interruptedAwaitingPerson: null,
    isArchived: spec.archived === true,
    lastActivityAt,
    lastAssistantUuid: summarizesUuid,
    lastFocusedAt: lastActivityAt,
    lastSpawnRootDetected: false,
    latestUserFrameAt: input.epochMs - frameHoursAgo * HOUR_MS,
    model: ordinal % 3 === 0 ? 'claude-fixture-large' : 'claude-fixture-model',
    originCwd: input.repository,
    permissionMode: 'auto',
    ...(spec.unsupportedShape
      ? { postTurnSummary: { status_category: 'waiting_for_person', status_detail: detail } }
      : {
          postTurnSummary: {
            needs_action: needsAction ?? '',
            status_category: status,
            status_detail: detail,
            summarizes_uuid: summarizesUuid,
          },
          postTurnSummaryFor: summarizesUuid,
        }),
    promptAppendSnapshot: { text: CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL },
    remoteControlAutoEligible: false,
    remoteMcpServersConfig: [],
    reportFindingsCard: false,
    sessionId: spec.id,
    sessionPermissionUpdates: [],
    spawnSeed: { seed: ordinal },
    title: spec.title,
    titleSource: ordinal % 5 === 0 ? 'tool' : 'auto',
    toolSurfaceSnapshot: { tools: [CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL] },
    ...(spec.worktree
      ? { branch: `fixture/${worktreeName}`, sourceBranch: 'fixture-main', worktreeName, worktreePath }
      : {}),
    ...(spec.writtenBranches === undefined ? {} : { writtenBranches: spec.writtenBranches }),
    ...(spec.wrapUp
      ? {
          lastTurnReport: 'Report of the last fixture turn.',
          turnWrapUp: { description: 'Wrapped up with an open question.' },
        }
      : {}),
    ...(spec.parentId === null
      ? {}
      : {
          spawnedFrom: {
            sessionId: spec.parentId,
            ...(spec.sideSession === undefined ? {} : { sideSession: spec.sideSession }),
            taskId: `task_spawn_${ordinal}`,
            title: `Fixture spawn ${ordinal}`,
          },
        }),
    ...(spec.pullRequests === undefined
      ? {}
      : {
          prs: spec.pullRequests.map((pullRequest) => ({
            autoFix: false,
            baseRef: 'fixture-main',
            branch: `fixture/pr-${pullRequest.number}`,
            host: 'github.com',
            own: true,
            prNumber: pullRequest.number,
            provider: 'github',
            repo: 'fixture/ai-usage',
            state: pullRequest.state,
            url: `https://github.com/fixture/ai-usage/pull/${pullRequest.number}`,
          })),
        }),
    ...(spec.openSuggestions === undefined
      ? {}
      : {
          backgroundTaskSuggestions: Array.from({ length: spec.openSuggestions }, (_value, index) => ({
            // Offered at the end of the turn, after the message it answered.
            createdAt: lastActivityAt - (index + 1) * MINUTE_MS,
            expiresAt: lastActivityAt + DAY_HOURS * HOUR_MS,
            id: `task_fixture_open_${ordinal}_${index + 1}`,
            prompt: CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
            title: `Fixture: proposal ${index + 1}`,
            tldr: `Short synopsis of fixture proposal ${index + 1}.`,
            useWorktree: index === 0,
          })),
        }),
    ...(spec.proposals === undefined
      ? {}
      : {
          backgroundTaskSuggestions: spec.proposals.map((proposal, index) => ({
            context: 'Fixture context.',
            createdAt: input.epochMs - proposal.createdHoursAgo * HOUR_MS,
            expiresAt: input.epochMs - proposal.expiresHoursAgo * HOUR_MS,
            id: `task_fixture_offer_${ordinal}_${index + 1}`,
            prompt: CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
            title: proposal.title,
            tldr: `Short synopsis of ${proposal.title.toLowerCase()}.`,
            useWorktree: true,
          })),
        }),
    ...(spec.resolvedSuggestions === undefined ? {} : { resolvedBackgroundTaskSuggestions: spec.resolvedSuggestions }),
    ...(spec.notes === undefined
      ? {}
      : {
          sideSessionNotes: Array.from({ length: spec.notes }, (_value, index) => ({
            at: lastActivityAt - ((spec.notes ?? 0) - index) * 600_000,
            batch: 1,
            messageUuid: `note-${ordinal}-${index + 1}`,
            report: `Fixture child report ${index + 1}.`,
            sessionId: (spec.children ?? [])[index]?.id ?? id('unknown-child'),
            title: `Fixture child ${index + 1}`,
          })),
        }),
  };
};

/** The registry as documents, in a stable order; nothing here touches a filesystem. */
export const claudeDesktopFixtureRegistry = (options: ClaudeDesktopFixtureOptions): ClaudeDesktopFixtureRegistry => {
  const epoch = options.epoch ?? CLAUDE_DESKTOP_FIXTURE_DEFAULT_EPOCH;
  const epochMs = epoch.getTime();
  const specs =
    options.variant === 'minimal'
      ? minimalSpecs(options.cliSessionIdWithTranscript)
      : representativeSpecs(options.cliSessionIdWithTranscript);
  const flat = flatten(specs);
  const archivedByPair: string[][] = CLAUDE_DESKTOP_FIXTURE_PAIRS.map(() => []);
  const documents = flat.map((spec, index): ClaudeDesktopFixtureDocument => {
    const pair = CLAUDE_DESKTOP_FIXTURE_PAIRS[spec.pair];
    const document = registryDocument(spec, { epochMs, repository: options.repository }, index + 1);
    if (spec.archived) {
      archivedByPair[spec.pair]?.push(spec.id);
    }
    return {
      account: pair.account,
      document,
      fileName: `${spec.id}.json`,
      modifiedAt: new Date((document.lastActivityAt as number) + 60_000),
      organization: pair.organization,
      sessionId: spec.id,
    };
  });
  const history = flat
    .flatMap((spec, index) =>
      (spec.earlierTurns ?? []).map((turn, turnIndex): ClaudeDesktopFixtureDocument => {
        const pair = CLAUDE_DESKTOP_FIXTURE_PAIRS[spec.pair];
        const document = registryDocument(spec, { epochMs, repository: options.repository }, index + 1, {
          index: turnIndex,
          turn,
        });
        return {
          account: pair.account,
          document,
          fileName: `${spec.id}.json`,
          modifiedAt: new Date((document.lastActivityAt as number) + 60_000),
          organization: pair.organization,
          sessionId: spec.id,
        };
      }),
    )
    .sort((left, right) => left.modifiedAt.getTime() - right.modifiedAt.getTime());
  const has = (name: string): string | null => (flat.some((spec) => spec.id === id(name)) ? id(name) : null);
  // A child whose parent the registry does not contain is a root to every reader of this fixture.
  const knownIds = new Set(flat.map((spec) => spec.id));
  const rootCount = flat.filter((spec) => spec.parentId === null || !knownIds.has(spec.parentId)).length;
  return {
    archivedByPair,
    childCount: flat.length - rootCount,
    cliSessionIds: {
      blockedRoot: options.cliSessionIdWithTranscript,
      noTranscriptRoot: has('no-transcript-root') === null ? null : 'cli-fixture-missing-transcript',
    },
    documents,
    epoch: epoch.toISOString(),
    history,
    ids: {
      answeredRoot: has('answered-root'),
      archivedRoot: has('archived-root'),
      blockedChildren: [id('blocked-child-1'), id('blocked-child-2')],
      blockedRoot: id('blocked-root'),
      completedRoot: id('completed-root'),
      continuedRoot: has('continued-root'),
      handledRoot: has('handled-root'),
      laterOfferRoot: has('later-offer-root'),
      mergedBeforeRoot: has('merged-before-root'),
      noTranscriptRoot: has('no-transcript-root'),
      orphanChild: has('orphan-child'),
      proposalRoot: has('proposal-root'),
      repliedRoot: has('replied-root'),
      reviewReadyRoot: has('review-ready-root'),
      satisfiedChild: has('satisfied-child'),
      satisfiedRoot: has('satisfied-root'),
      staleRoot: has('stale-root'),
      unrelatedPullRequestRoot: has('unrelated-pr-root'),
      unsupported: id('unsupported'),
    },
    rootCount,
    variant: options.variant,
  };
};
