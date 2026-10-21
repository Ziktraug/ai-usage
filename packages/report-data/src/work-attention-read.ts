import path from 'node:path';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type ClaudeDesktopSessionObservation,
  WORK_ATTENTION_BOUNDS,
  type WorkAttentionCoverage,
  type WorkAttentionDataset,
  type WorkAttentionKind,
  type WorkFact,
  type WorkFactProvenance,
  type WorkRoot,
  type WorkRootChildren,
  type WorkRootDeclaration,
} from '@ai-usage/report-core/work-attention';
import { interpretWorkRoot } from '@ai-usage/report-core/work-attention-interpretation';
import {
  type ClaudeDesktopCollectionState,
  MAX_CLAUDE_DESKTOP_SESSION_READ,
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopSessions,
  querySessionRowsBySourceSessionIds,
  type ServedSessionRowIdentity,
  UsageStoreError,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

/**
 * The one bounded read of the Work attention dataset (ADR 0050), shared by the web procedure and
 * the chain test. It reads the Claude Desktop session family directly, folds children under their
 * roots, joins each root to the served Session row by `(machineId, 'claude', cliSessionId)`,
 * builds the facts, lets `interpretWorkRoot` name the attention, and ranks the roots.
 *
 * It never names a served report revision for its own data: the Desktop family lives outside the
 * revision (the join is the only place a revision is consulted, and its absence is reported in
 * `coverage.sessions` rather than failing the read).
 */

export const WORK_ATTENTION_DEFAULT_LIMIT = 100;
export const WORK_ATTENTION_DEFAULT_SINCE_DAYS = 30;
const MAX_SINCE_DAYS = 3650;
const MAX_JOINED_MACHINES = 16;
const DAY_MS = 86_400_000;
const WORK_HARNESS_KEY = 'claude';

const { maxChildrenTitles, maxFacts, maxRoots } = WORK_ATTENTION_BOUNDS;
const MAX_SIDE_SESSION_NOTE_FACTS = 5;

export interface QueryWorkAttentionInput {
  readonly dbPath: string;
  /** Roots returned at most; defaults to 100 and may not exceed `WORK_ATTENTION_BOUNDS.maxRoots`. */
  readonly limit?: number;
  readonly machineId?: string;
  readonly now?: Date;
  /** Roots whose family had no activity in this window are left out; defaults to 30 days. */
  readonly sinceDays?: number;
  readonly staleAfterMs?: number;
}

interface RootGroup {
  readonly children: readonly ClaudeDesktopSessionObservation[];
  /** `spawnedFrom` named a session that is not in the registry read. */
  readonly parentMissing: boolean;
  readonly root: ClaudeDesktopSessionObservation;
}

const ATTENTION_RANK: Record<WorkAttentionKind, number> = {
  'external-wait': 1,
  'human-request': 0,
  none: 3,
  'optional-lead': 2,
};

const invalidInput = (dbPath: string, message: string): UsageStoreError =>
  new UsageStoreError({
    message: `queryWorkAttention ${dbPath}: ${message}`,
    operation: 'queryWorkAttention',
    reason: 'invalid-input',
  });

const provenanceOf = (observation: ClaudeDesktopSessionObservation): WorkFactProvenance => ({
  coverage: observation.format === 'claude-desktop-session-v1' ? 'complete' : 'partial',
  machineId: observation.machineId,
  observedAt: observation.fileModifiedAt,
  source: 'claude-desktop',
});

const declarationOf = (observation: ClaudeDesktopSessionObservation): WorkRootDeclaration | null =>
  observation.turnSummary === null
    ? null
    : {
        at: observation.lastActivityAt,
        detail: observation.turnSummary.detail,
        needsAction: observation.turnSummary.needsAction,
        status: observation.turnSummary.status,
      };

/** Children fold into counts and a few titles; they never become roots. */
const childrenOf = (children: readonly ClaudeDesktopSessionObservation[]): WorkRootChildren => ({
  blocked: children.filter((child) => child.turnSummary?.status === 'blocked').length,
  completed: children.filter((child) => child.turnSummary?.status === 'completed').length,
  count: children.length,
  reviewReady: children.filter((child) => child.turnSummary?.status === 'review_ready').length,
  titles: children.slice(0, maxChildrenTitles).map((child) => child.title),
});

const pullRequestFacts = (observation: ClaudeDesktopSessionObservation): WorkFact[] =>
  observation.declaredPullRequests.map((pullRequest) => ({
    branch: pullRequest.branch,
    host: pullRequest.host,
    id: `${observation.desktopSessionId}:pr:${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`,
    kind: 'declared-pull-request',
    number: pullRequest.number,
    provenance: provenanceOf(observation),
    repository: pullRequest.repository,
    state: pullRequest.state,
    url: pullRequest.url,
  }));

/**
 * The facts a root carries, in the order they matter when the bound cuts: the declaration and
 * its reports first, then what the family declared about pull requests, then proposals, branches,
 * notes and spawn origin.
 */
const factsOf = (group: RootGroup): WorkFact[] => {
  const { root } = group;
  const provenance = provenanceOf(root);
  const facts: WorkFact[] = [];
  if (root.turnSummary !== null) {
    facts.push({
      declaredAt: root.lastActivityAt,
      desktopSessionId: root.desktopSessionId,
      detail: root.turnSummary.detail,
      id: `${root.desktopSessionId}:declared-turn`,
      kind: 'declared-turn',
      needsAction: root.turnSummary.needsAction,
      provenance,
      status: root.turnSummary.status,
    });
  }
  if (root.wrapUpDescription !== null) {
    facts.push({
      at: root.lastActivityAt,
      id: `${root.desktopSessionId}:wrap-up`,
      kind: 'wrap-up',
      provenance,
      text: root.wrapUpDescription,
    });
  }
  if (root.lastTurnReport !== null) {
    facts.push({
      at: root.lastActivityAt,
      id: `${root.desktopSessionId}:turn-report`,
      kind: 'turn-report',
      provenance,
      text: root.lastTurnReport,
    });
  }
  facts.push(...pullRequestFacts(root), ...group.children.flatMap(pullRequestFacts));
  for (const suggestion of root.openSuggestions) {
    facts.push({
      createdAt: suggestion.createdAt,
      id: `${root.desktopSessionId}:proposal:${suggestion.id}`,
      kind: 'proposal',
      provenance,
      resolution: 'open',
      suggestionId: suggestion.id,
      title: suggestion.title,
      tldr: suggestion.tldr,
    });
  }
  for (const [suggestionId, resolution] of Object.entries(root.resolvedSuggestions)) {
    facts.push({
      createdAt: null,
      id: `${root.desktopSessionId}:proposal:${suggestionId}`,
      kind: 'proposal',
      provenance,
      resolution,
      suggestionId,
      // The registry keeps only the id of a resolved proposal; its title is gone with it.
      title: suggestionId,
      tldr: null,
    });
  }
  for (const branch of root.writtenBranches) {
    facts.push({ branch, id: `${root.desktopSessionId}:branch:${branch}`, kind: 'written-branch', provenance });
  }
  for (const note of root.sideSessionNotes.slice(-MAX_SIDE_SESSION_NOTE_FACTS)) {
    facts.push({
      at: note.at,
      id: `${root.desktopSessionId}:note:${note.sessionId}:${note.at}`,
      kind: 'side-session-note',
      provenance,
      report: note.report,
      sessionId: note.sessionId,
      title: note.title,
    });
  }
  if (group.parentMissing && root.spawnedFrom !== null) {
    facts.push({
      desktopSessionId: root.spawnedFrom.sessionId,
      id: `${root.desktopSessionId}:spawned-from`,
      kind: 'spawned-from',
      provenance,
      taskId: root.spawnedFrom.taskId,
      title: root.spawnedFrom.title,
    });
  }
  return facts.slice(0, maxFacts);
};

const sessionKey = (observation: Pick<ClaudeDesktopSessionObservation, 'desktopSessionId' | 'machineId'>): string =>
  `${observation.machineId}\u0000${observation.desktopSessionId}`;

/**
 * Roots and their descendants, by `spawnedFrom`. The chain is followed to its top: a child of a
 * child folds under the same root as its parent, so a root's `children` are its whole family and
 * no session disappears between two levels. A parent must be a session of the same machine in
 * this read; the top of a chain whose parent is absent becomes a root flagged `parentMissing`,
 * because hiding it would hide a declaration and promoting it silently would claim a certainty
 * the registry does not give. A cycle (which the registry never writes) stops at the first
 * repeated session, which then stands as the root.
 */
const groupRoots = (observations: readonly ClaudeDesktopSessionObservation[]): RootGroup[] => {
  const byKey = new Map<string, ClaudeDesktopSessionObservation>();
  for (const observation of observations) {
    byKey.set(sessionKey(observation), observation);
  }
  const topOf = (
    observation: ClaudeDesktopSessionObservation,
  ): { readonly parentMissing: boolean; readonly top: ClaudeDesktopSessionObservation } => {
    const visited = new Set<string>([sessionKey(observation)]);
    let current = observation;
    for (;;) {
      if (current.spawnedFrom === null) {
        return { parentMissing: false, top: current };
      }
      const parent = byKey.get(
        sessionKey({ desktopSessionId: current.spawnedFrom.sessionId, machineId: current.machineId }),
      );
      if (parent === undefined) {
        return { parentMissing: true, top: current };
      }
      if (visited.has(sessionKey(parent))) {
        return { parentMissing: false, top: current };
      }
      visited.add(sessionKey(parent));
      current = parent;
    }
  };
  const groups = new Map<
    string,
    { children: ClaudeDesktopSessionObservation[]; parentMissing: boolean; root: ClaudeDesktopSessionObservation }
  >();
  for (const observation of observations) {
    const { parentMissing, top } = topOf(observation);
    const key = sessionKey(top);
    const group = groups.get(key) ?? { children: [], parentMissing, root: top };
    if (top !== observation) {
      group.children.push(observation);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
};

const latestActivity = (group: RootGroup): CanonicalInstant =>
  [group.root, ...group.children]
    .map((observation) => observation.lastActivityAt)
    .reduce((latest, current) => (current > latest ? current : latest));

const compareRoots = (left: WorkRoot, right: WorkRoot): number => {
  const rank = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention];
  if (rank !== 0) {
    return rank;
  }
  if (left.attention === 'human-request') {
    const leftAt = left.age.declaredAt ?? '';
    const rightAt = right.age.declaredAt ?? '';
    if (leftAt !== rightAt) {
      return leftAt < rightAt ? 1 : -1;
    }
  }
  const leftActivity = left.age.lastActivityAt ?? '';
  const rightActivity = right.age.lastActivityAt ?? '';
  if (leftActivity !== rightActivity) {
    return leftActivity < rightActivity ? 1 : -1;
  }
  return left.key.sourceSessionId < right.key.sourceSessionId ? -1 : 1;
};

/**
 * How a root finds the served Session it corresponds to. `revision` is `null` when no served
 * revision exists; then no root can say whether its transcript was collected and the dataset
 * reports the join as unavailable instead of flagging every root.
 */
export interface WorkAttentionSessionLookup {
  readonly find: (machineId: string, sourceSessionId: string) => ServedSessionRowIdentity | undefined;
  readonly revision: string | null;
}

export const NO_SERVED_REVISION: WorkAttentionSessionLookup = { find: () => undefined, revision: null };

const joinKey = (machineId: string, sourceSessionId: string): string => `${machineId}\u0000${sourceSessionId}`;

const joinSessions = (
  dbPath: string,
  observations: readonly ClaudeDesktopSessionObservation[],
): Effect.Effect<WorkAttentionSessionLookup, UsageStoreError> =>
  Effect.gen(function* () {
    const idsByMachine = new Map<string, Set<string>>();
    for (const observation of observations) {
      const ids = idsByMachine.get(observation.machineId) ?? new Set<string>();
      ids.add(observation.cliSessionId);
      idsByMachine.set(observation.machineId, ids);
    }
    if (idsByMachine.size > MAX_JOINED_MACHINES) {
      return yield* Effect.fail(invalidInput(dbPath, 'too many machines in one Work read; pass machineId'));
    }
    const byKey = new Map<string, ServedSessionRowIdentity>();
    let revision: string | null = null;
    for (const [machineId, ids] of idsByMachine) {
      const joined = yield* querySessionRowsBySourceSessionIds({
        dbPath,
        harnessKey: WORK_HARNESS_KEY,
        machineId,
        sourceSessionIds: [...ids],
      });
      revision = joined.revision;
      if (joined.revision === null) {
        return NO_SERVED_REVISION;
      }
      for (const row of joined.rows) {
        // The first served row for an identity wins; a transcript split across rows is one Session.
        if (!byKey.has(joinKey(machineId, row.sourceSessionId))) {
          byKey.set(joinKey(machineId, row.sourceSessionId), row);
        }
      }
    }
    return { find: (machineId, sourceSessionId) => byKey.get(joinKey(machineId, sourceSessionId)), revision };
  });

const buildRoot = (
  group: RootGroup,
  sessions: WorkAttentionSessionLookup,
  now: Date,
  staleAfterMs: number | undefined,
): WorkRoot => {
  const { root } = group;
  const facts = factsOf(group);
  const declared = declarationOf(root);
  const session = sessions.find(root.machineId, root.cliSessionId) ?? null;
  const { attention, interpretations } = interpretWorkRoot({
    coverage: {
      parentMissing: group.parentMissing,
      sessionJoined: sessions.revision === null ? null : session !== null,
      unsupportedReason: root.unsupportedReason,
    },
    declaration: declared,
    facts,
    now,
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  });
  const checkoutPath = root.worktreePath ?? root.cwd;
  return {
    age: {
      createdAt: root.createdAt,
      declaredAt: declared?.at ?? null,
      lastActivityAt: root.lastActivityAt,
      lastObservedAt: root.fileModifiedAt,
    },
    archived: root.archived,
    attention,
    children: childrenOf(group.children),
    declared,
    desktopSessionId: root.desktopSessionId,
    facts,
    interpretations,
    key: { harness: WORK_HARNESS_KEY, machineId: root.machineId, sourceSessionId: root.cliSessionId },
    project: {
      branch: root.branch,
      checkoutPath,
      // Without a served row the label is the checkout's directory name; `session: null` says so.
      label: session?.projectLabel ?? path.basename(root.cwd),
      worktreeName: root.worktreePath === null ? null : path.basename(root.worktreePath),
    },
    session: session === null ? null : { campaignKey: session.campaignKey, rowId: session.rowId },
    title: root.title,
    titleSource: root.titleSource,
  };
};

const desktopCoverage = (
  states: readonly ClaudeDesktopCollectionState[],
  refusedRows: number,
  readTruncated: boolean,
): WorkAttentionCoverage['desktopSessions'] => {
  let collectedAt: CanonicalInstant | null = null;
  const totals = { filesParsed: 0, filesSeen: 0, truncated: readTruncated, unsupported: 0 };
  for (const state of states) {
    const at = normalizeIsoTimestamp(state.collectedAt);
    if (at !== null && (collectedAt === null || at > collectedAt)) {
      collectedAt = at;
    }
    totals.filesParsed += state.completeness.filesParsed;
    totals.filesSeen += state.completeness.filesSeen;
    totals.unsupported += state.completeness.unsupported;
    totals.truncated ||= state.completeness.truncated;
  }
  return { collectedAt, ...totals, refusedRows };
};

export interface AssembleWorkAttentionInput {
  readonly collectionStates: readonly ClaudeDesktopCollectionState[];
  readonly limit?: number;
  readonly machineId?: string;
  readonly now?: Date;
  /** Re-validated observations of the family, any order; children fold under their roots here. */
  readonly observations: readonly ClaudeDesktopSessionObservation[];
  /** The store read stopped at its bound; the dataset then reports itself truncated. */
  readonly readTruncated?: boolean;
  /** Persisted rows the read refused on re-validation. */
  readonly refusedRows?: number;
  readonly sessions: WorkAttentionSessionLookup;
  readonly sinceDays?: number;
  readonly staleAfterMs?: number;
}

const boundsProblem = (input: Pick<AssembleWorkAttentionInput, 'limit' | 'now' | 'sinceDays'>): string | null => {
  const limit = input.limit ?? WORK_ATTENTION_DEFAULT_LIMIT;
  const sinceDays = input.sinceDays ?? WORK_ATTENTION_DEFAULT_SINCE_DAYS;
  if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= maxRoots)) {
    return `limit must be an integer between 1 and ${maxRoots}`;
  }
  if (!(Number.isSafeInteger(sinceDays) && sinceDays > 0 && sinceDays <= MAX_SINCE_DAYS)) {
    return `sinceDays must be an integer between 1 and ${MAX_SINCE_DAYS}`;
  }
  if (input.now !== undefined && normalizeIsoTimestamp(input.now.getTime()) === null) {
    return 'now must be a valid date';
  }
  return null;
};

/**
 * The pure assembly: groups, joins, interprets, ranks and bounds, from observations already in
 * hand. `queryWorkAttention` feeds it from the store; the web e2e composition feeds it from the
 * seeded registry parsed in memory, so both cross the same code. Throws `RangeError` on bounds
 * outside the contract.
 */
export const assembleWorkAttention = (input: AssembleWorkAttentionInput): WorkAttentionDataset => {
  const problem = boundsProblem(input);
  if (problem !== null) {
    throw new RangeError(`assembleWorkAttention: ${problem}`);
  }
  const limit = input.limit ?? WORK_ATTENTION_DEFAULT_LIMIT;
  const sinceDays = input.sinceDays ?? WORK_ATTENTION_DEFAULT_SINCE_DAYS;
  const now = input.now ?? new Date();
  const generatedAt = normalizeIsoTimestamp(now.getTime());
  if (generatedAt === null) {
    throw new RangeError('assembleWorkAttention: now must be a valid date');
  }
  const since = new Date(now.getTime() - sinceDays * DAY_MS).toISOString();
  const observations =
    input.machineId === undefined
      ? input.observations
      : input.observations.filter((observation) => observation.machineId === input.machineId);
  const groups = groupRoots(observations).filter((group) => latestActivity(group) >= since);
  const roots = groups.map((group) => buildRoot(group, input.sessions, now, input.staleAfterMs)).sort(compareRoots);
  const joined = roots.filter((root) => root.session !== null).length;
  const readTruncated = input.readTruncated ?? false;
  return {
    coverage: {
      checkouts: { failed: 0, lastRunAt: null, observed: 0 },
      desktopSessions: desktopCoverage(input.collectionStates, input.refusedRows ?? 0, readTruncated),
      pullRequests: { disabled: true, failed: 0, lastRunAt: null, observed: 0 },
      sessions: {
        joined,
        revision: input.sessions.revision,
        unmatched: input.sessions.revision === null ? 0 : roots.length - joined,
      },
    },
    generatedAt,
    machineId: input.machineId ?? null,
    roots: roots.slice(0, limit),
    totalRoots: roots.length,
    truncated: roots.length > limit || readTruncated,
  };
};

export const queryWorkAttention = (
  input: QueryWorkAttentionInput,
): Effect.Effect<WorkAttentionDataset, UsageStoreError> =>
  Effect.gen(function* () {
    const problem = boundsProblem(input);
    if (problem !== null) {
      return yield* Effect.fail(invalidInput(input.dbPath, problem));
    }
    const machineFilter = input.machineId === undefined ? {} : { machineId: input.machineId };
    // The whole bounded family, most recent first, so a child outside the window still folds
    // under its root and is never mistaken for an orphan.
    const read = yield* queryClaudeDesktopSessions({
      dbPath: input.dbPath,
      limit: MAX_CLAUDE_DESKTOP_SESSION_READ,
      ...machineFilter,
    });
    const states = yield* queryClaudeDesktopCollectionState({ dbPath: input.dbPath, ...machineFilter });
    const sessions = yield* joinSessions(input.dbPath, read.observations);
    return assembleWorkAttention({
      collectionStates: states.states,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...machineFilter,
      ...(input.now === undefined ? {} : { now: input.now }),
      observations: read.observations,
      readTruncated: read.truncated,
      refusedRows: read.skipped,
      sessions,
      ...(input.sinceDays === undefined ? {} : { sinceDays: input.sinceDays }),
      ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
    });
  });
