import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A synthetic Claude Desktop session registry, in the attested `local_<uuid>.json` shape
 * (`<registry>/<account>/<org>/local_*.json`, millisecond epochs, `postTurnSummary`,
 * `spawnedFrom`, `backgroundTaskSuggestions`, `prs`, `sideSessionNotes`). Every id, title and
 * path is invented; paths stay under the fixture home; a proposal's `prompt` carries a sentinel
 * so consumers can prove it never leaves the collector.
 *
 * Ages are relative to a fixed epoch so a seeded home collects the same observations on every
 * run, and file mtimes are pinned to `lastActivityAt + 1 min` so a re-import is `unchanged`.
 */

export type ClaudeDesktopSessionsFixtureVariant = 'minimal' | 'representative';

export const CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL = 'PRIVATE_DESKTOP_PROMPT_SENTINEL_117';
export const CLAUDE_DESKTOP_FIXTURE_DEFAULT_EPOCH = new Date('2026-10-20T12:00:00.000Z');
/** A spawn origin no registry file carries: its child must surface as a root with a coverage gap. */
export const CLAUDE_DESKTOP_FIXTURE_MISSING_PARENT_ID = 'local_fixture-missing-parent';

export interface SeededClaudeDesktopSessionIds {
  /** Completed long ago and archived; listed in `archived-sessions.idx`. */
  readonly archivedRoot: string | null;
  /** Two children of `blockedRoot`, one review-ready and one completed. */
  readonly blockedChildren: readonly string[];
  /** Blocked with a `needs_action`; the one session whose `cliSessionId` has a seeded transcript. */
  readonly blockedRoot: string;
  /** Completed with an OPEN declared pull request and written branches. */
  readonly completedRoot: string;
  /** Blocked asking to push; its child declared a MERGED pull request *before* the declaration. */
  readonly mergedBeforeRoot: string | null;
  /** Completed; its `cliSessionId` has no transcript anywhere. */
  readonly noTranscriptRoot: string | null;
  /** A child whose `spawnedFrom` names a session the registry does not contain. */
  readonly orphanChild: string | null;
  /** Completed with open proposals and resolved ones (`started_notified`, `dismissed`). */
  readonly proposalRoot: string | null;
  readonly reviewReadyRoot: string | null;
  /** The child of `satisfiedRoot` that declared the pull request the root asked for. */
  readonly satisfiedChild: string | null;
  /** Blocked asking to open a pull request, which `satisfiedChild` later declared OPEN. */
  readonly satisfiedRoot: string | null;
  /** Blocked 40 days before the epoch. */
  readonly staleRoot: string | null;
  /** Required identity present, `postTurnSummary.status_category` unknown. */
  readonly unsupported: string;
}

export interface SeededClaudeDesktopSessions {
  readonly childCount: number;
  readonly cliSessionIds: {
    readonly blockedRoot: string;
    readonly noTranscriptRoot: string | null;
  };
  readonly epoch: string;
  readonly ids: SeededClaudeDesktopSessionIds;
  readonly registryDirectory: string;
  readonly rootCount: number;
  readonly variant: ClaudeDesktopSessionsFixtureVariant;
}

export interface ClaudeDesktopSessionsFixtureOptions {
  /** The transcript id the seeded Claude home carries; `blockedRoot` joins to it. */
  readonly cliSessionIdWithTranscript: string;
  readonly epoch?: Date;
  readonly home: string;
  /** The seeded repository checkout; every `cwd` is this path or a worktree under it. */
  readonly repository: string;
  readonly variant: ClaudeDesktopSessionsFixtureVariant;
}

type TurnStatus = 'blocked' | 'completed' | 'review_ready';

interface DeclaredPullRequestSpec {
  readonly number: number;
  readonly state: 'MERGED' | 'OPEN';
}

interface SessionSpec {
  readonly ageHours: number;
  readonly archived?: boolean;
  readonly children?: readonly SessionSpec[];
  readonly cliSessionId?: string;
  readonly id: string;
  readonly needsAction?: string;
  readonly notes?: number;
  readonly openSuggestions?: number;
  readonly pair: 0 | 1;
  readonly pullRequests?: readonly DeclaredPullRequestSpec[];
  readonly resolvedSuggestions?: Record<string, 'dismissed' | 'started_notified'>;
  readonly sideSession?: boolean;
  readonly spawnedFromId?: string;
  readonly status?: TurnStatus;
  readonly title: string;
  readonly unsupportedShape?: boolean;
  readonly worktree?: boolean;
  readonly wrapUp?: boolean;
  readonly writtenBranches?: readonly string[];
}

const HOUR_MS = 3_600_000;
const DETAIL_BY_STATUS: Record<TurnStatus, string> = {
  blocked: 'Stopped at a question the fixture cannot answer alone.',
  completed: 'Finished the requested change.',
  review_ready: 'The change is ready for a review.',
};
const DAY_HOURS = 24;
const PAIRS = [
  { account: 'account-fixture-0001', organization: 'org-fixture-0001' },
  { account: 'account-fixture-0002', organization: 'org-fixture-0002' },
] as const;

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
    { ageHours: 15, id: id('enquete-1'), pair: 1, status: 'completed', title: 'Enquête' },
    { ageHours: 26, id: id('enquete-2'), pair: 0, status: 'completed', title: 'Enquête' },
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

const registryFile = (
  spec: FlatSpec,
  input: { readonly epochMs: number; readonly repository: string },
  ordinal: number,
): Record<string, unknown> => {
  const lastActivityAt = input.epochMs - spec.ageHours * HOUR_MS;
  const createdAt = lastActivityAt - 2 * HOUR_MS;
  const cliSessionId = spec.cliSessionId ?? `cli-fixture-${spec.id.slice('local_fixture-'.length)}`;
  const worktreeName = 'checkout-3';
  const worktreePath = join(input.repository, '.claude', 'worktrees', worktreeName);
  const summarizesUuid = `assistant-${ordinal}`;
  const status: TurnStatus = spec.status ?? 'completed';
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
    gitAnchors: [{ commonDir: join(input.repository, '.git'), gitRoot: input.repository, trustedAt: createdAt }],
    interruptedAwaitingPerson: null,
    isArchived: spec.archived === true,
    lastActivityAt,
    lastAssistantUuid: summarizesUuid,
    lastFocusedAt: lastActivityAt,
    lastSpawnRootDetected: false,
    model: ordinal % 3 === 0 ? 'claude-fixture-large' : 'claude-fixture-model',
    originCwd: input.repository,
    permissionMode: 'auto',
    ...(spec.unsupportedShape
      ? { postTurnSummary: { status_category: 'waiting_for_person', status_detail: detail } }
      : {
          postTurnSummary: {
            needs_action: spec.needsAction ?? '',
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
            createdAt: lastActivityAt - (index + 1) * HOUR_MS,
            expiresAt: lastActivityAt + DAY_HOURS * HOUR_MS,
            id: `task_fixture_open_${ordinal}_${index + 1}`,
            prompt: CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
            title: `Fixture: proposal ${index + 1}`,
            tldr: `Short synopsis of fixture proposal ${index + 1}.`,
            useWorktree: index === 0,
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

export const seedClaudeDesktopSessions = async (
  options: ClaudeDesktopSessionsFixtureOptions,
): Promise<SeededClaudeDesktopSessions> => {
  const epoch = options.epoch ?? CLAUDE_DESKTOP_FIXTURE_DEFAULT_EPOCH;
  const epochMs = epoch.getTime();
  const registryDirectory = join(options.home, '.config', 'Claude', 'claude-code-sessions');
  const specs =
    options.variant === 'minimal'
      ? minimalSpecs(options.cliSessionIdWithTranscript)
      : representativeSpecs(options.cliSessionIdWithTranscript);
  const flat = flatten(specs);
  const archivedByPair = new Map<number, string[]>();
  for (const pair of PAIRS.keys()) {
    const directory = join(registryDirectory, PAIRS[pair]!.account, PAIRS[pair]!.organization);
    await mkdir(join(directory, 'backlog'), { recursive: true });
    await writeFile(join(directory, 'backlog', 'tasks.json'), JSON.stringify({ items: [], version: 1 }));
    await writeFile(join(directory, 'scheduled-tasks.json'), JSON.stringify({ tasks: [] }));
    archivedByPair.set(pair, []);
  }
  for (const [ordinal, spec] of flat.entries()) {
    const pair = PAIRS[spec.pair];
    const directory = join(registryDirectory, pair.account, pair.organization);
    const filePath = join(directory, `${spec.id}.json`);
    const file = registryFile(spec, { epochMs, repository: options.repository }, ordinal + 1);
    await writeFile(filePath, JSON.stringify(file));
    const modifiedAt = new Date((file.lastActivityAt as number) + 60_000);
    await utimes(filePath, modifiedAt, modifiedAt);
    if (spec.archived) {
      archivedByPair.get(spec.pair)?.push(spec.id);
    }
  }
  for (const [pair, archived] of archivedByPair) {
    const directory = join(registryDirectory, PAIRS[pair]!.account, PAIRS[pair]!.organization);
    await writeFile(join(directory, 'archived-sessions.idx'), JSON.stringify({ archived, v: 1 }));
  }
  if (options.variant === 'representative') {
    const directory = join(registryDirectory, PAIRS[0].account, PAIRS[0].organization);
    await writeFile(join(directory, 'deleted_local_fixture-gone.json'), JSON.stringify({ sessionId: 'gone' }));
  }

  const has = (name: string): string | null => (flat.some((spec) => spec.id === id(name)) ? id(name) : null);
  // A child whose parent the registry does not contain is a root to every reader of this fixture.
  const knownIds = new Set(flat.map((spec) => spec.id));
  const rootCount = flat.filter((spec) => spec.parentId === null || !knownIds.has(spec.parentId)).length;
  return {
    childCount: flat.length - rootCount,
    cliSessionIds: {
      blockedRoot: options.cliSessionIdWithTranscript,
      noTranscriptRoot: has('no-transcript-root') === null ? null : 'cli-fixture-missing-transcript',
    },
    epoch: epoch.toISOString(),
    ids: {
      archivedRoot: has('archived-root'),
      blockedChildren: [id('blocked-child-1'), id('blocked-child-2')],
      blockedRoot: id('blocked-root'),
      completedRoot: id('completed-root'),
      mergedBeforeRoot: has('merged-before-root'),
      noTranscriptRoot: has('no-transcript-root'),
      orphanChild: has('orphan-child'),
      proposalRoot: has('proposal-root'),
      reviewReadyRoot: has('review-ready-root'),
      satisfiedChild: has('satisfied-child'),
      satisfiedRoot: has('satisfied-root'),
      staleRoot: has('stale-root'),
      unsupported: id('unsupported'),
    },
    registryDirectory,
    rootCount,
    variant: options.variant,
  };
};
