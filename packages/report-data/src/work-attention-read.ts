import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type CheckoutStatusObservation,
  type ClaudeDesktopSessionObservation,
  type ClaudeDesktopTurnDeclaration,
  type JiraIssueObservation,
  type PullRequestObservation,
  WORK_ATTENTION_BOUNDS,
  type WorkAttentionCoverage,
  type WorkAttentionDataset,
  type WorkAttentionKind,
  type WorkFact,
  type WorkFactProvenance,
  type WorkInterpretation,
  type WorkRoot,
  type WorkRootChildren,
  type WorkRootDeclaration,
} from '@ai-usage/report-core/work-attention';
import {
  checkoutStatusFact,
  explicitJiraKeys,
  interpretExternalFacts,
  interpretJiraFacts,
  type JiraKeyActivity,
  jiraIssueFact,
  pullRequestFact,
} from '@ai-usage/report-core/work-attention-facts';
import {
  interpretWorkRoot,
  type WorkEarlierDeclaration,
  type WorkLinkedSession,
  type WorkRootHarnessInput,
} from '@ai-usage/report-core/work-attention-interpretation';
import { claudeDesktopDeclarationKey } from '@ai-usage/report-core/work-attention-native';
import {
  type ClaudeDesktopCollectionState,
  countClaudeDesktopSessions,
  MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER,
  MAX_CLAUDE_DESKTOP_SESSION_READ,
  MAX_WORK_FACT_QUERY_LIMIT,
  MAX_WORK_SESSION_JOIN_IDS,
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopSessions,
  queryClaudeDesktopTurnDeclarations,
  queryCodexWorkObservations,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryRecentServedHarnessSessions,
  querySessionRowsBySourceSessionIds,
  queryWorkFactRunStates,
  type ServedHarnessSessionFamily,
  type ServedSessionRowIdentity,
  UsageStoreError,
  type WorkFactRunState,
  type WorkSessionReadScope,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import {
  harnessFamilyCheckoutPaths,
  harnessSessionRoot,
  WORK_UNDECLARED_HARNESS,
  type WorkHarnessSessions,
} from './work-attention-read-harness';

export { WORK_UNDECLARED_HARNESS, type WorkHarnessSessions } from './work-attention-read-harness';

/**
 * The one bounded read of the Work attention dataset (ADR 0050, ADR 0051), shared by the web
 * procedure and the chain test. It reads the Claude Desktop session family directly, folds
 * children under their roots, joins each root to the served Session row by
 * `(machineId, 'claude', cliSessionId)`, attaches the external and local facts the family
 * explicitly named, lets the two pure interpreters name the attention, and ranks the roots.
 *
 * Attachment is exact and declared, never inferred:
 *
 * - a `pull-request` observation joins a root when a member of its family (root or child)
 *   declared that pull request (`host`, `repository`, `number`), on the same machine; a branch
 *   name or a nearby date never links one. A child's own listing is a fact of the family only
 *   when it does not mirror the root's checkout (`childDeclaredPullRequestFacts`);
 * - a `checkout-status` observation joins a root when `worktreePath ?? cwd` of a family member
 *   is that path, on the same machine; several roots may share one checkout and each then
 *   receives the fact with the sharing named in its interpretation;
 * - a `jira-issue` observation joins a root when a member of its family wrote that key as a
 *   whole segment of a branch name (`explicitJiraKeys`, ADR 0054), on the same machine; a key in
 *   a title or a path never links one, and the same number on another project is another key.
 *   A reply counts as arrived only after the latest activity on the key across every family
 *   that wrote it, and only the family last active on the key is asked to answer it;
 * - when the latest observation failed and an older successful one exists, both are attached:
 *   the dated state stays the last known one and the failure stays visible.
 *
 * It never names a served report revision for the Desktop data: the Desktop family and the fact
 * tables live outside the revision (the Session join consults one, and its absence is reported in
 * `coverage.sessions` rather than failing the read).
 *
 * Codex declares no turn status, so its sessions come from the served revision itself (ADR 0059):
 * the recent served campaigns of `codex`, one root each, attention `not-observable`, attached to
 * checkout observations by exact path only and never folded under a Desktop root
 * (`work-attention-read-harness.ts`). They rank after every Desktop root, so the page limit cuts
 * them first and never hides a Desktop root to make room for them.
 */

export const WORK_ATTENTION_DEFAULT_LIMIT = 100;
export const WORK_ATTENTION_DEFAULT_SINCE_DAYS = 30;
const MAX_SINCE_DAYS = 3650;
const MAX_JOINED_MACHINES = 16;
const DAY_MS = 86_400_000;
const WORK_HARNESS_KEY = 'claude';

const { maxChildrenTitles, maxFacts, maxInterpretations, maxRoots } = WORK_ATTENTION_BOUNDS;
const MAX_SIDE_SESSION_NOTE_FACTS = 5;

export interface QueryWorkAttentionInput {
  readonly dbPath: string;
  /** Roots returned at most; defaults to 100 and may not exceed `WORK_ATTENTION_BOUNDS.maxRoots`. */
  readonly limit?: number;
  readonly machineId?: string;
  readonly now?: Date;
  /** Applied by store readers before each bounded page; parents remain linked by native identity. */
  readonly scope?: WorkSessionReadScope;
  /**
   * Roots whose family had no activity in this window are left out unless their attention is a
   * human request or an external wait (a question stays a question at any age); defaults to 30 days.
   */
  readonly sinceDays?: number;
  readonly staleAfterMs?: number;
}

interface RootGroup {
  readonly children: readonly ClaudeDesktopSessionObservation[];
  /** `spawnedFrom` named a session that is not in the registry read. */
  readonly parentMissing: boolean;
  readonly root: ClaudeDesktopSessionObservation;
}

/** One identity's latest observation and, when that one failed, the latest successful one. */
export interface LatestWorkObservation<Observation> {
  readonly latest: Observation;
  readonly latestObserved: Observation | null;
}

/** The external and local fact family as the store readers return it, in any order. */
export interface WorkAttentionExternalFacts {
  readonly checkouts: readonly LatestWorkObservation<CheckoutStatusObservation>[];
  readonly jiraIssues: readonly LatestWorkObservation<JiraIssueObservation>[];
  readonly pullRequests: readonly LatestWorkObservation<PullRequestObservation>[];
  readonly runStates: readonly WorkFactRunState[];
}

export const NO_EXTERNAL_FACTS: WorkAttentionExternalFacts = {
  checkouts: [],
  jiraIssues: [],
  pullRequests: [],
  runStates: [],
};

const ATTENTION_RANK: Record<WorkAttentionKind, number> = {
  'external-wait': 1,
  'human-request': 0,
  none: 3,
  'not-observable': 4,
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

/** The declaration histories the store recorded (ADR 0056), per session. */
type DeclarationHistory = ReadonlyMap<string, readonly ClaudeDesktopTurnDeclaration[]>;

const NO_DECLARATIONS: readonly ClaudeDesktopTurnDeclaration[] = [];

const sessionKey = (observation: Pick<ClaudeDesktopSessionObservation, 'desktopSessionId' | 'machineId'>): string =>
  `${observation.machineId}\u0000${observation.desktopSessionId}`;

const indexDeclarationHistory = (declarations: readonly ClaudeDesktopTurnDeclaration[]): DeclarationHistory => {
  const index = new Map<string, ClaudeDesktopTurnDeclaration[]>();
  for (const declaration of declarations) {
    const key = sessionKey(declaration);
    index.set(key, [...(index.get(key) ?? []), declaration]);
  }
  for (const rows of index.values()) {
    rows.sort((left, right) => (left.declaredAt < right.declaredAt ? -1 : 1));
  }
  return index;
};

const historyOf = (history: DeclarationHistory, observation: ClaudeDesktopSessionObservation) =>
  history.get(sessionKey(observation)) ?? NO_DECLARATIONS;

/**
 * The declaration a session makes now, dated by the first sweep that saw it when the store
 * recorded its history; otherwise by the session's last activity, as a single sweep can only do.
 */
const declarationOf = (
  observation: ClaudeDesktopSessionObservation,
  history: DeclarationHistory,
): WorkRootDeclaration | null => {
  const summary = observation.turnSummary;
  if (summary === null) {
    return null;
  }
  const key = claudeDesktopDeclarationKey(summary);
  const recorded = historyOf(history, observation).find(
    (row) => row.declarationKey === key && row.supersededAt === null,
  );
  return {
    at: recorded?.declaredAt ?? observation.lastActivityAt,
    detail: summary.detail,
    needsAction: summary.needsAction,
    status: summary.status,
  };
};

const isRequestDeclaration = (status: ClaudeDesktopTurnDeclaration['status'], needsAction: string | null): boolean =>
  status === 'review_ready' || (status === 'blocked' && needsAction !== null && needsAction.trim().length > 0);

/** Earlier declarations restated per root; the store keeps more, the view needs the latest few. */
const MAX_EARLIER_DECLARATION_FACTS = 3;

/**
 * The root's requests a later turn replaced, as `declared-turn` facts (dated by the session, first
 * observed by the sweep that recorded them) and the inputs the interpreter confronts them with.
 */
const earlierDeclarationsOf = (
  root: ClaudeDesktopSessionObservation,
  history: DeclarationHistory,
): { readonly facts: WorkFact[]; readonly inputs: WorkEarlierDeclaration[] } => {
  const facts: WorkFact[] = [];
  const inputs: WorkEarlierDeclaration[] = [];
  const replaced = historyOf(history, root)
    .filter((row) => row.supersededAt !== null && isRequestDeclaration(row.status, row.needsAction))
    .slice(-MAX_EARLIER_DECLARATION_FACTS);
  for (const row of replaced) {
    if (row.supersededAt === null) {
      continue;
    }
    const factId = `${root.desktopSessionId}:declared-turn:${pathDigest(row.declarationKey)}`;
    facts.push({
      declaredAt: row.declaredAt,
      desktopSessionId: root.desktopSessionId,
      detail: row.detail,
      id: factId,
      kind: 'declared-turn',
      needsAction: row.needsAction,
      provenance: {
        coverage: 'complete',
        machineId: row.machineId,
        observedAt: row.firstObservedAt,
        source: 'claude-desktop',
      },
      status: row.status,
    });
    inputs.push({
      declaredAt: row.declaredAt,
      factId,
      needsAction: row.needsAction,
      repliedAt: row.repliedAt,
      status: row.status,
      supersededAt: row.supersededAt,
    });
  }
  return { facts, inputs };
};

/** The current declaration of another session, as a fact a root may cite as evidence. */
const linkedDeclarationFact = (
  session: ClaudeDesktopSessionObservation,
  declaration: WorkRootDeclaration,
): WorkFact => ({
  declaredAt: declaration.at,
  desktopSessionId: session.desktopSessionId,
  detail: declaration.detail,
  id: `${session.desktopSessionId}:declared-turn`,
  kind: 'declared-turn',
  needsAction: declaration.needsAction,
  provenance: provenanceOf(session),
  status: declaration.status,
});

const noteFactId = (root: ClaudeDesktopSessionObservation, note: { readonly at: string; readonly sessionId: string }) =>
  `${root.desktopSessionId}:note:${note.sessionId}:${note.at}`;

/**
 * The sessions the harness links to a root (ADR 0056), each once: started from it (`spawnedFrom`
 * names the root, dated by the session's creation) or reporting to it (its latest side-session
 * note in the root's file). A session linked both ways is read by the link dated after the
 * request when there is one, the spawn first. Only the links dated after the request are
 * returned, with their declarations as facts the root may cite: an older link says nothing about
 * a later question.
 */
const linkedSessionsOf = (
  group: RootGroup,
  askedAt: CanonicalInstant | null,
  sessions: ReadonlyMap<string, ClaudeDesktopSessionObservation>,
  history: DeclarationHistory,
): { readonly facts: WorkFact[]; readonly inputs: WorkLinkedSession[] } => {
  const facts: WorkFact[] = [];
  const inputs: WorkLinkedSession[] = [];
  if (askedAt === null) {
    return { facts, inputs };
  }
  const { root } = group;
  const latestNotes = new Map<
    string,
    { readonly at: CanonicalInstant; readonly sessionId: string; readonly title: string }
  >();
  for (const note of root.sideSessionNotes) {
    const known = latestNotes.get(note.sessionId);
    if (known === undefined || note.at > known.at) {
      latestNotes.set(note.sessionId, note);
    }
  }
  const candidates = new Map<string, ClaudeDesktopSessionObservation | null>();
  for (const child of group.children) {
    if (child.spawnedFrom?.sessionId === root.desktopSessionId) {
      candidates.set(child.desktopSessionId, child);
    }
  }
  for (const sessionId of latestNotes.keys()) {
    if (!candidates.has(sessionId)) {
      candidates.set(
        sessionId,
        sessions.get(sessionKey({ desktopSessionId: sessionId, machineId: root.machineId })) ?? null,
      );
    }
  }
  const linkAfter = (
    session: ClaudeDesktopSessionObservation | null,
    note: { readonly at: CanonicalInstant; readonly sessionId: string } | undefined,
    after: CanonicalInstant,
  ): Pick<WorkLinkedSession, 'link' | 'linkedAt' | 'linkFactId'> | null => {
    if (session !== null && session.spawnedFrom?.sessionId === root.desktopSessionId && session.createdAt > after) {
      return { link: 'spawned-from', linkedAt: session.createdAt, linkFactId: null };
    }
    if (note !== undefined && note.at > after) {
      return { link: 'side-session-note', linkedAt: note.at, linkFactId: noteFactId(root, note) };
    }
    return null;
  };
  for (const [sessionId, session] of candidates) {
    const note = latestNotes.get(sessionId);
    const link = linkAfter(session, note, askedAt);
    if (link === null) {
      continue;
    }
    const declared = session === null ? null : declarationOf(session, history);
    if (session !== null && declared !== null) {
      facts.push(linkedDeclarationFact(session, declared));
    }
    inputs.push({
      ...link,
      declaration:
        session === null || declared === null
          ? null
          : { at: declared.at, factId: `${session.desktopSessionId}:declared-turn`, status: declared.status },
      desktopSessionId: sessionId,
      title: session?.title ?? note?.title ?? sessionId,
    });
  }
  return { facts, inputs };
};

/** The root's harness context for the interpreter: what Claude Desktop recorded around its declaration. */
const harnessContextOf = (
  group: RootGroup,
  earlier: readonly WorkEarlierDeclaration[],
  linked: readonly WorkLinkedSession[],
): WorkRootHarnessInput => ({
  archived: group.root.archived,
  earlierDeclarations: earlier,
  // The whole family's activity: a child busy yesterday keeps an old question among the current ones.
  familyLastActivityAt: latestActivity(group),
  latestUserFrameAt: group.root.latestUserFrameAt,
  linkedSessions: linked,
  openProposals: group.root.openSuggestions.map((suggestion) => ({
    createdAt: suggestion.createdAt,
    expiresAt: suggestion.expiresAt,
    factId: `${group.root.desktopSessionId}:proposal:${suggestion.id}`,
    title: suggestion.title,
  })),
});

/** Children fold into counts and a few titles; they never become roots. */
const childrenOf = (children: readonly ClaudeDesktopSessionObservation[]): WorkRootChildren => ({
  blocked: children.filter((child) => child.turnSummary?.status === 'blocked').length,
  completed: children.filter((child) => child.turnSummary?.status === 'completed').length,
  count: children.length,
  reviewReady: children.filter((child) => child.turnSummary?.status === 'review_ready').length,
  titles: children.slice(0, maxChildrenTitles).map((child) => child.title),
});

const declaredPullRequestFacts = (
  observation: ClaudeDesktopSessionObservation,
  declaredBy: 'root' | 'child',
): WorkFact[] =>
  observation.declaredPullRequests.map((pullRequest) => ({
    branch: pullRequest.branch,
    declaredBy,
    host: pullRequest.host,
    id: `${observation.desktopSessionId}:pr:${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`,
    kind: 'declared-pull-request',
    lastActivityAt: observation.lastActivityAt,
    number: pullRequest.number,
    provenance: provenanceOf(observation),
    repository: pullRequest.repository,
    state: pullRequest.state,
    url: pullRequest.url,
  }));

// ---------------------------------------------------------------------------------------------
// External and local facts: exact attachment by declared link and by checkout path
// ---------------------------------------------------------------------------------------------

/** The identity the GitHub producer stores: host case-folded, repository as written. */
const pullRequestKey = (machineId: string, host: string, repository: string, number: number): string =>
  JSON.stringify([machineId, host.trim().toLowerCase(), repository.trim(), number]);

const checkoutKey = (machineId: string, checkoutPath: string): string => JSON.stringify([machineId, checkoutPath]);

const checkoutPathOf = (observation: ClaudeDesktopSessionObservation): string =>
  observation.worktreePath ?? observation.cwd;

/** The distinct checkouts a family worked in: the root's and every child's `worktreePath ?? cwd`. */
const familyCheckoutPaths = (group: RootGroup): string[] => [
  ...new Set([group.root, ...group.children].map(checkoutPathOf)),
];

/** The distinct pull requests a family declared, in family order, each once. */
const familyPullRequestLinks = (
  group: RootGroup,
): { readonly host: string; readonly number: number; readonly repository: string }[] => {
  const seen = new Set<string>();
  const links: { readonly host: string; readonly number: number; readonly repository: string }[] = [];
  for (const member of [group.root, ...group.children]) {
    for (const pullRequest of member.declaredPullRequests) {
      const key = pullRequestKey(member.machineId, pullRequest.host, pullRequest.repository, pullRequest.number);
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ host: pullRequest.host, number: pullRequest.number, repository: pullRequest.repository });
      }
    }
  }
  return links;
};

/** The identity the Jira producer stores: the key as Jira writes it, per observing machine. */
const jiraIssueKey = (machineId: string, key: string): string => JSON.stringify([machineId, key]);

/** The distinct Jira keys a family wrote in branch names, in family order, each once. */
const familyJiraKeys = (group: RootGroup): string[] => {
  const keys: string[] = [];
  for (const member of [group.root, ...group.children]) {
    for (const key of explicitJiraKeys(member)) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
};

const latestActivity = (group: RootGroup): CanonicalInstant =>
  [group.root, ...group.children]
    .map((observation) => observation.lastActivityAt)
    .reduce((latest, current) => (current > latest ? current : latest));

/** Per machine, per Jira key: the latest activity among every family that wrote the key, and whose it was. */
type JiraKeyActivityIndex = ReadonlyMap<string, ReadonlyMap<string, JiraKeyActivity>>;

/**
 * Computed over every family of the read, hidden or not: a family the activity window leaves out
 * may still be the one that last relayed a key, and a reply older than that activity is not new.
 */
const indexJiraKeyActivity = (groups: readonly RootGroup[]): JiraKeyActivityIndex => {
  const index = new Map<string, Map<string, JiraKeyActivity>>();
  for (const group of groups) {
    const perMachine = index.get(group.root.machineId) ?? new Map<string, JiraKeyActivity>();
    const lastActivityAt = latestActivity(group);
    for (const key of familyJiraKeys(group)) {
      const known = perMachine.get(key);
      if (known === undefined || lastActivityAt > known.lastActivityAt) {
        perMachine.set(key, { lastActivityAt, latestFamilyTitle: group.root.title });
      }
    }
    index.set(group.root.machineId, perMachine);
  }
  return index;
};

interface ExternalFactIndex {
  readonly checkouts: ReadonlyMap<string, LatestWorkObservation<CheckoutStatusObservation>>;
  readonly jiraIssues: ReadonlyMap<string, LatestWorkObservation<JiraIssueObservation>>;
  readonly jiraKeyActivity: JiraKeyActivityIndex;
  readonly pullRequests: ReadonlyMap<string, LatestWorkObservation<PullRequestObservation>>;
  /** Per machine, how many roots of the dataset have that checkout path in their family. */
  readonly rootsPerCheckout: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

const indexExternalFacts = (
  facts: WorkAttentionExternalFacts,
  groups: readonly RootGroup[],
  jiraKeyActivity: JiraKeyActivityIndex,
  harnessFamilies: readonly ServedHarnessSessionFamily[],
): ExternalFactIndex => {
  const pullRequests = new Map<string, LatestWorkObservation<PullRequestObservation>>();
  for (const item of facts.pullRequests) {
    const { latest } = item;
    pullRequests.set(pullRequestKey(latest.machineId, latest.host, latest.repository, latest.number), item);
  }
  const checkouts = new Map<string, LatestWorkObservation<CheckoutStatusObservation>>();
  for (const item of facts.checkouts) {
    checkouts.set(checkoutKey(item.latest.machineId, item.latest.checkoutPath), item);
  }
  const jiraIssues = new Map<string, LatestWorkObservation<JiraIssueObservation>>();
  for (const item of facts.jiraIssues) {
    jiraIssues.set(jiraIssueKey(item.latest.machineId, item.latest.key), item);
  }
  const rootsPerCheckout = new Map<string, Map<string, number>>();
  for (const group of groups) {
    const perMachine = rootsPerCheckout.get(group.root.machineId) ?? new Map<string, number>();
    for (const checkoutPath of familyCheckoutPaths(group)) {
      perMachine.set(checkoutPath, (perMachine.get(checkoutPath) ?? 0) + 1);
    }
    rootsPerCheckout.set(group.root.machineId, perMachine);
  }
  // A harness root in the same checkout is a root sharing it: its changes may be the ones seen there.
  for (const family of harnessFamilies) {
    const machineId = family.members[0]?.machineId;
    if (machineId === undefined) {
      continue;
    }
    const perMachine = rootsPerCheckout.get(machineId) ?? new Map<string, number>();
    for (const checkoutPath of harnessFamilyCheckoutPaths(family)) {
      perMachine.set(checkoutPath, (perMachine.get(checkoutPath) ?? 0) + 1);
    }
    rootsPerCheckout.set(machineId, perMachine);
  }
  return { checkouts, jiraIssues, jiraKeyActivity, pullRequests, rootsPerCheckout };
};

/**
 * The observations one identity contributes: the latest one, preceded by the latest successful
 * one when the latest failed. The dated state is then still the last known one and the failure
 * is visible beside it, as the store keeps them.
 */
const observationsOf = <Observation extends { readonly outcome: string }>(
  item: LatestWorkObservation<Observation>,
): Observation[] =>
  item.latest.outcome !== 'observed' && item.latestObserved !== null
    ? [item.latestObserved, item.latest]
    : [item.latest];

/** Keeps fact ids within the identifier bound whatever the checkout path's length. */
const pathDigest = (checkoutPath: string): string =>
  createHash('sha256').update(checkoutPath).digest('hex').slice(0, 16);

const externalFactsOf = (group: RootGroup, index: ExternalFactIndex): WorkFact[] => {
  const { root } = group;
  const facts: WorkFact[] = [];
  for (const link of familyPullRequestLinks(group)) {
    const item = index.pullRequests.get(pullRequestKey(root.machineId, link.host, link.repository, link.number));
    if (item === undefined) {
      continue;
    }
    for (const observation of observationsOf(item)) {
      facts.push(
        pullRequestFact(
          observation,
          `${root.desktopSessionId}:gh:${observation.host}/${observation.repository}#${observation.number}@${observation.observedAt}`,
        ),
      );
    }
  }
  for (const checkoutPath of familyCheckoutPaths(group)) {
    const item = index.checkouts.get(checkoutKey(root.machineId, checkoutPath));
    if (item === undefined) {
      continue;
    }
    for (const observation of observationsOf(item)) {
      facts.push(
        checkoutStatusFact(
          observation,
          `${root.desktopSessionId}:checkout:${pathDigest(observation.checkoutPath)}@${observation.observedAt}`,
        ),
      );
    }
  }
  const familyLastActivityAt = latestActivity(group);
  const keyActivity = index.jiraKeyActivity.get(root.machineId);
  for (const key of familyJiraKeys(group)) {
    const item = index.jiraIssues.get(jiraIssueKey(root.machineId, key));
    if (item === undefined) {
      continue;
    }
    for (const observation of observationsOf(item)) {
      facts.push(
        jiraIssueFact(
          observation,
          `${root.desktopSessionId}:jira:${observation.key}@${observation.observedAt}`,
          keyActivity?.get(key)?.lastActivityAt ?? familyLastActivityAt,
        ),
      );
    }
  }
  return facts;
};

/**
 * The checkout observations a harness family's recorded working directories name, by exact path on
 * the root's machine (ADR 0059). The only external fact such a root carries: the harness declares
 * no pull request and its branch never links one.
 */
const harnessCheckoutFacts = (
  family: ServedHarnessSessionFamily,
  harness: string,
  index: ExternalFactIndex,
): WorkFact[] => {
  const root = family.members[0];
  if (root === undefined) {
    return [];
  }
  const owner = `${harness}:${pathDigest(root.sourceSessionId)}`;
  const facts: WorkFact[] = [];
  for (const checkoutPath of harnessFamilyCheckoutPaths(family)) {
    const item = index.checkouts.get(checkoutKey(root.machineId, checkoutPath));
    if (item === undefined) {
      continue;
    }
    for (const observation of observationsOf(item)) {
      facts.push(
        checkoutStatusFact(
          observation,
          `${owner}:checkout:${pathDigest(observation.checkoutPath)}@${observation.observedAt}`,
        ),
      );
    }
  }
  return facts;
};

/**
 * A child's declared pull requests, less the ones that only mirror the root's own checkout: the
 * desktop app fills `prs[]` from the branch of the checkout a session sits in, so a child in the
 * root's checkout (`worktreePath ?? cwd`) lists what the root lists, and a pull request the root
 * lists itself is the root's standing whoever repeats it. Neither is a later answer to the root's
 * question; the root's own `prs[]` stays listed as such and never answers either. GitHub is still
 * asked about every link the family declared (`familyPullRequestLinks`).
 */
const childDeclaredPullRequestFacts = (group: RootGroup): WorkFact[] => {
  const { root } = group;
  const rootCheckout = checkoutPathOf(root);
  const rootLinks = new Set(
    root.declaredPullRequests.map((pullRequest) =>
      pullRequestKey(root.machineId, pullRequest.host, pullRequest.repository, pullRequest.number),
    ),
  );
  return group.children.flatMap((child) =>
    checkoutPathOf(child) === rootCheckout
      ? []
      : declaredPullRequestFacts(child, 'child').filter(
          (fact) =>
            fact.kind === 'declared-pull-request' &&
            !rootLinks.has(pullRequestKey(child.machineId, fact.host, fact.repository, fact.number)),
        ),
  );
};

/**
 * The facts a root carries, in the order they read: the declaration and its reports first, then
 * what the family declared about pull requests and what GitHub and the disk showed, then
 * proposals, branches, notes and spawn origin.
 */
const factsOf = (
  group: RootGroup,
  index: ExternalFactIndex,
  declared: WorkRootDeclaration | null,
  harness: {
    readonly citedNotes: ReadonlySet<string>;
    readonly earlier: readonly WorkFact[];
    readonly linked: readonly WorkFact[];
  },
): WorkFact[] => {
  const { root } = group;
  const provenance = provenanceOf(root);
  const facts: WorkFact[] = [];
  if (root.turnSummary !== null) {
    facts.push({
      declaredAt: declared?.at ?? root.lastActivityAt,
      desktopSessionId: root.desktopSessionId,
      detail: root.turnSummary.detail,
      id: `${root.desktopSessionId}:declared-turn`,
      kind: 'declared-turn',
      needsAction: root.turnSummary.needsAction,
      provenance,
      status: root.turnSummary.status,
    });
  }
  facts.push(...harness.earlier);
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
  facts.push(
    ...harness.linked,
    ...declaredPullRequestFacts(root, 'root'),
    ...childDeclaredPullRequestFacts(group),
    ...externalFactsOf(group, index),
  );
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
  // The latest notes, and any older one a linked session is cited by, so its evidence resolves.
  const recentNotes = root.sideSessionNotes.length - MAX_SIDE_SESSION_NOTE_FACTS;
  for (const [position, note] of root.sideSessionNotes.entries()) {
    if (position < recentNotes && !harness.citedNotes.has(noteFactId(root, note))) {
      continue;
    }
    facts.push({
      at: note.at,
      id: noteFactId(root, note),
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
  return facts;
};

/** When the bound cuts, the declaration survives first, then the external observations, then the rest. */
const factPriority = (fact: WorkFact): number => {
  if (fact.kind === 'declared-turn') {
    return 0;
  }
  return fact.kind === 'pull-request' || fact.kind === 'checkout-status' || fact.kind === 'jira-issue' ? 1 : 2;
};

const boundFacts = (facts: readonly WorkFact[]): { readonly cut: number; readonly facts: WorkFact[] } => {
  if (facts.length <= maxFacts) {
    return { cut: 0, facts: [...facts] };
  }
  const kept = new Set<WorkFact>();
  for (const tier of [0, 1, 2]) {
    for (const fact of facts) {
      if (kept.size >= maxFacts) {
        break;
      }
      if (factPriority(fact) === tier) {
        kept.add(fact);
      }
    }
  }
  // The kept facts stay in reading order.
  return { cut: facts.length - kept.size, facts: facts.filter((fact) => kept.has(fact)) };
};

const factsCutInterpretation = (cut: number): WorkInterpretation => ({
  evidence: [],
  kind: 'coverage-gap',
  text: `${String(cut)} fact${cut === 1 ? '' : 's'} beyond the bound of ${String(maxFacts)} ${cut === 1 ? 'is' : 'are'} not listed; the declaration and the external observations were kept first.`,
  uncertainty: 'The facts left out exist in the store; proposals, branches and notes are the first to be cut.',
});

/** Interpretations that name the declaration's own state; they lead the merged list. */
const DECLARATION_INTERPRETATION_KINDS = new Set<WorkInterpretation['kind']>([
  'request-open',
  'request-satisfied-elsewhere',
  'request-dormant',
  'review-ready',
]);

/**
 * The three interpreters meet here. Attention: a human request first, which a Jira reply that
 * arrived after the latest activity on its key also makes, on the family last active on that key
 * only (nothing on this machine shows it was read; an older family on the key is told where the
 * reply is carried and is not promoted); else an external wait when GitHub showed a pull request
 * awaiting someone else; else what the declaration interpreter said (an optional lead, or
 * nothing). The merged list leads with the declaration's own statement, then the external and
 * local statements, then the Jira statements, then proposals, staleness and coverage gaps.
 */
const mergeInterpretations = (
  declared: {
    readonly attention: WorkAttentionKind;
    readonly interpretations: readonly WorkInterpretation[];
    readonly reconsidered: boolean;
  },
  external: readonly WorkInterpretation[],
  jira: readonly WorkInterpretation[],
  factsCut: number,
): {
  readonly attention: WorkAttentionKind;
  readonly interpretations: WorkInterpretation[];
  readonly reconsidered: boolean;
} => {
  const leading = declared.interpretations.filter(({ kind }) => DECLARATION_INTERPRETATION_KINDS.has(kind));
  const trailing = declared.interpretations.filter(({ kind }) => !DECLARATION_INTERPRETATION_KINDS.has(kind));
  const cut = factsCut > 0 ? [factsCutInterpretation(factsCut)] : [];
  const interpretations = [...leading, ...cut, ...external, ...jira, ...trailing].slice(0, maxInterpretations);
  let attention: WorkAttentionKind = declared.attention;
  if (jira.some(({ kind }) => kind === 'jira-reply-arrived')) {
    attention = 'human-request';
  } else if (attention !== 'human-request' && external.some(({ kind }) => kind === 'external-review-pending')) {
    attention = 'external-wait';
  }
  return { attention, interpretations, reconsidered: declared.reconsidered };
};

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

/** The attentions the activity window never hides: a pending request keeps its root visible at any age. */
const PENDING_ATTENTIONS = new Set<WorkAttentionKind>(['human-request', 'external-wait']);

const compareRoots = (left: WorkRoot, right: WorkRoot): number => {
  const rank = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention];
  if (rank !== 0) {
    return rank;
  }
  if (left.attention === 'human-request') {
    // A request a later pull request may have answered ranks after the ones nothing reconsidered.
    if (left.reconsidered !== right.reconsidered) {
      return left.reconsidered ? 1 : -1;
    }
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
    for (const [machineId, machineIds] of idsByMachine) {
      // The join reads at most `MAX_WORK_SESSION_JOIN_IDS` ids at a time; a read that kept pending
      // sessions beyond its recency bound may name more, so it is asked in chunks.
      const ids = [...machineIds];
      for (let start = 0; start < ids.length; start += MAX_WORK_SESSION_JOIN_IDS) {
        const joined = yield* querySessionRowsBySourceSessionIds({
          dbPath,
          harnessKey: WORK_HARNESS_KEY,
          machineId,
          sourceSessionIds: ids.slice(start, start + MAX_WORK_SESSION_JOIN_IDS),
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
    }
    return { find: (machineId, sourceSessionId) => byKey.get(joinKey(machineId, sourceSessionId)), revision };
  });

/** What the read holds beside the groups: the recorded declaration histories and every session it read. */
interface ReadContext {
  readonly history: DeclarationHistory;
  readonly observations: ReadonlyMap<string, ClaudeDesktopSessionObservation>;
}

const buildRoot = (
  group: RootGroup,
  sessions: WorkAttentionSessionLookup,
  index: ExternalFactIndex,
  context: ReadContext,
  now: Date,
  staleAfterMs: number | undefined,
): WorkRoot => {
  const { root } = group;
  const declared = declarationOf(root, context.history);
  const earlier = earlierDeclarationsOf(root, context.history);
  const linked = linkedSessionsOf(group, declared?.at ?? null, context.observations, context.history);
  const { cut, facts } = boundFacts(
    factsOf(group, index, declared, {
      citedNotes: new Set(
        linked.inputs.flatMap((linkedSession) => (linkedSession.linkFactId === null ? [] : [linkedSession.linkFactId])),
      ),
      earlier: earlier.facts,
      linked: linked.facts,
    }),
  );
  const session = sessions.find(root.machineId, root.cliSessionId) ?? null;
  const declaredResult = interpretWorkRoot({
    coverage: {
      parentMissing: group.parentMissing,
      sessionJoined: sessions.revision === null ? null : session !== null,
      unsupportedReason: root.unsupportedReason,
    },
    declaration: declared,
    facts,
    harness: harnessContextOf(group, earlier.inputs, linked.inputs),
    now,
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  });
  const rootsPerCheckout = index.rootsPerCheckout.get(root.machineId);
  const external = interpretExternalFacts({
    facts,
    now,
    ...(rootsPerCheckout === undefined ? {} : { rootsPerCheckout }),
  });
  const keyActivity = index.jiraKeyActivity.get(root.machineId);
  const jira = interpretJiraFacts({
    facts,
    familyLastActivityAt: latestActivity(group),
    now,
    ...(keyActivity === undefined ? {} : { keyActivity }),
  });
  const { attention, interpretations, reconsidered } = mergeInterpretations(declaredResult, external, jira, cut);
  const checkoutPath = checkoutPathOf(root);
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
      // One rule for every root, joined or not: the project directory's name, from the origin
      // checkout for a worktree session, else the cwd. The served row labels a worktree session by
      // its worktree directory, so its label is carried apart and never replaces this one.
      label: path.basename(root.originCwd ?? root.cwd),
      servedLabel: session?.projectLabel ?? null,
      worktreeName: root.worktreePath === null ? null : path.basename(root.worktreePath),
    },
    reconsidered,
    session: session === null ? null : { campaignKey: session.campaignKey, rowId: session.rowId },
    title: root.title,
    titleSource: root.titleSource,
  };
};

const desktopCoverage = (
  states: readonly ClaudeDesktopCollectionState[],
  refusedRows: number,
  readTruncated: boolean,
  sessions: { readonly read: number; readonly stored: number },
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
  return { collectedAt, ...totals, refusedRows, sessionsRead: sessions.read, sessionsStored: sessions.stored };
};

/**
 * What the three fact producers last did, from their run states. No run yet means no date and
 * zero counts, not a disabled source: `disabled` is true only when the run itself said so, and
 * the Jira `reason` is that run's own message (`acli not installed`, `jira.enabled is false`).
 */
const factCoverage = (
  runStates: readonly WorkFactRunState[],
  machineId: string | undefined,
): Pick<WorkAttentionCoverage, 'checkouts' | 'jira' | 'pullRequests'> => {
  const runOf = (sourceId: WorkFactRunState['sourceId']): WorkFactRunState | null =>
    runStates.find((run) => run.sourceId === sourceId && (machineId === undefined || run.machineId === machineId)) ??
    null;
  const checkouts = runOf('checkouts.status');
  const pullRequests = runOf('github.pull-requests');
  const jira = runOf('jira.issues');
  return {
    checkouts: {
      failed: checkouts?.failed ?? 0,
      lastRunAt: checkouts?.ranAt ?? null,
      observed: checkouts?.observed ?? 0,
    },
    jira: {
      disabled: jira?.disabled ?? false,
      failed: jira?.failed ?? 0,
      lastRunAt: jira?.ranAt ?? null,
      observed: jira?.observed ?? 0,
      reason: jira?.disabled === true ? jira.message : null,
    },
    pullRequests: {
      disabled: pullRequests?.disabled ?? false,
      failed: pullRequests?.failed ?? 0,
      lastRunAt: pullRequests?.ranAt ?? null,
      observed: pullRequests?.observed ?? 0,
    },
  };
};

export interface AssembleWorkAttentionInput {
  readonly collectionStates: readonly ClaudeDesktopCollectionState[];
  /**
   * The declaration histories the store recorded for the sessions read (ADR 0056), any order. Absent
   * or empty, every declaration is dated by its session's last activity and no earlier one is read.
   */
  readonly declarations?: readonly ClaudeDesktopTurnDeclaration[];
  /** The latest pull request and checkout observations and the producers' run states. */
  readonly externalFacts: WorkAttentionExternalFacts;
  /**
   * The recent served families of a harness that declares no turn status (ADR 0059), as
   * `queryRecentServedHarnessSessions` read them for the activity window. Each becomes one root
   * whose attention is `not-observable`. Absent, no such harness was read.
   */
  readonly harnessSessions?: WorkHarnessSessions;
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
  /** Sessions stored for the read's machines; defaults to the observations given, a complete read. */
  readonly sessionsStored?: number;
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
 * The pure assembly: groups, joins, attaches, interprets, ranks and bounds, from observations
 * already in hand. `queryWorkAttention` feeds it from the store; the web e2e composition feeds it
 * from the seeded registry parsed in memory, so both cross the same code. Throws `RangeError` on
 * bounds outside the contract.
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
  const allGroups = groupRoots(observations);
  const context: ReadContext = {
    history: indexDeclarationHistory(input.declarations ?? []),
    observations: new Map(observations.map((observation) => [sessionKey(observation), observation])),
  };
  // The window applies after interpretation, never before it: an old root is hidden only when
  // nothing pending was read for it. Its attention does not depend on the checkout-sharing index,
  // so the older roots are classified against the full index and the kept ones rebuilt against
  // the index of the roots the dataset actually carries. The Jira key activity is read over every
  // family both times: a hidden family may be the one that last relayed a key.
  const jiraKeyActivity = indexJiraKeyActivity(allGroups);
  // Harness families were read for the window already; they share checkouts with Desktop roots.
  const harness = input.harnessSessions;
  const harnessInScope =
    harness === undefined
      ? []
      : harness.families.filter(
          (family) => input.machineId === undefined || family.members[0]?.machineId === input.machineId,
        );
  // Their own budget, the most recent first (the store's order): never more than `maxCodexRoots`.
  const harnessFamilies = harnessInScope.slice(0, WORK_ATTENTION_BOUNDS.maxCodexRoots);
  const fullIndex = indexExternalFacts(input.externalFacts, allGroups, jiraKeyActivity, harnessFamilies);
  const groups = allGroups.filter(
    (group) =>
      latestActivity(group) >= since ||
      PENDING_ATTENTIONS.has(buildRoot(group, input.sessions, fullIndex, context, now, input.staleAfterMs).attention),
  );
  const index = indexExternalFacts(input.externalFacts, groups, jiraKeyActivity, harnessFamilies);
  const desktopRoots = groups.map((group) => buildRoot(group, input.sessions, index, context, now, input.staleAfterMs));
  const harnessRoots =
    harness === undefined
      ? []
      : harnessFamilies.map((family) => {
          const machineId = family.members[0]?.machineId;
          const rootsPerCheckout = machineId === undefined ? undefined : index.rootsPerCheckout.get(machineId);
          return harnessSessionRoot({
            checkoutFacts: harnessCheckoutFacts(family, harness.harness, index),
            family,
            generatedAt: harness.generatedAt,
            harness: harness.harness,
            ...(harness.workObservations === undefined ? {} : { workObservations: harness.workObservations }),
            now,
            ...(rootsPerCheckout === undefined ? {} : { rootsPerCheckout }),
          });
        });
  const roots = [...desktopRoots, ...harnessRoots].sort(compareRoots);
  // The join covers the Desktop roots; a harness root is a served Session by construction.
  const joined = desktopRoots.filter((root) => root.session !== null).length;
  // Families of the window beyond the harness read bound are counted with the roots, never shown.
  const harnessUnread =
    harness === undefined
      ? 0
      : Math.max(harness.familiesInWindow - harness.families.length, 0) +
        harnessInScope.length -
        harnessFamilies.length;
  const readTruncated = input.readTruncated ?? false;
  return {
    coverage: {
      ...factCoverage(input.externalFacts.runStates, input.machineId),
      codexSessions: {
        campaignsInWindow: harnessFamilies.length + harnessUnread,
        campaignsRead: harnessFamilies.length,
      },
      desktopSessions: desktopCoverage(input.collectionStates, input.refusedRows ?? 0, readTruncated, {
        read: observations.length,
        stored: Math.max(input.sessionsStored ?? observations.length, observations.length),
      }),
      sessions: {
        joined,
        revision: input.sessions.revision ?? harness?.revision ?? null,
        unmatched: input.sessions.revision === null ? 0 : desktopRoots.length - joined,
      },
      window: { excludedRoots: allGroups.length - groups.length, sinceDays },
    },
    generatedAt,
    machineId: input.machineId ?? null,
    roots: roots.slice(0, limit),
    totalRoots: allGroups.length + harnessFamilies.length + harnessUnread,
    truncated: roots.length > limit || readTruncated || harnessUnread > 0,
  };
};

/** Reads one bounded page per chunk of keys; no keys, no read (an empty filter would mean "all"). */
const readInChunks = <Key, Item>(
  keys: readonly Key[],
  read: (chunk: readonly Key[]) => Effect.Effect<{ readonly items: readonly Item[] }, UsageStoreError>,
): Effect.Effect<Item[], UsageStoreError> =>
  Effect.gen(function* () {
    const items: Item[] = [];
    for (let start = 0; start < keys.length; start += MAX_WORK_FACT_QUERY_LIMIT) {
      const page = yield* read(keys.slice(start, start + MAX_WORK_FACT_QUERY_LIMIT));
      items.push(...page.items);
    }
    return items;
  });

/** The pull requests any session of the read declared, each once; the only links ever looked up. */
const declaredLinks = (
  observations: readonly ClaudeDesktopSessionObservation[],
): { readonly host: string; readonly number: number; readonly repository: string }[] => {
  const seen = new Set<string>();
  const links: { readonly host: string; readonly number: number; readonly repository: string }[] = [];
  for (const observation of observations) {
    for (const pullRequest of observation.declaredPullRequests) {
      const key = pullRequestKey('', pullRequest.host, pullRequest.repository, pullRequest.number);
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ host: pullRequest.host, number: pullRequest.number, repository: pullRequest.repository });
      }
    }
  }
  return links;
};

/** The Jira keys any session of the read wrote in a branch name, each once; the only keys ever looked up. */
const declaredJiraKeys = (observations: readonly ClaudeDesktopSessionObservation[]): string[] => [
  ...new Set(observations.flatMap((observation) => explicitJiraKeys(observation))),
];

const readExternalFacts = (
  input: QueryWorkAttentionInput,
  observations: readonly ClaudeDesktopSessionObservation[],
  harnessFamilies: readonly ServedHarnessSessionFamily[],
): Effect.Effect<WorkAttentionExternalFacts, UsageStoreError> =>
  Effect.gen(function* () {
    const machineFilter = input.machineId === undefined ? {} : { machineId: input.machineId };
    const paths = [
      ...new Set([...observations.map(checkoutPathOf), ...harnessFamilies.flatMap(harnessFamilyCheckoutPaths)]),
    ];
    const pullRequests = yield* readInChunks(declaredLinks(observations), (links) =>
      queryLatestPullRequestObservations({
        dbPath: input.dbPath,
        limit: MAX_WORK_FACT_QUERY_LIMIT,
        links,
        ...machineFilter,
      }),
    );
    const checkouts = yield* readInChunks(paths, (chunk) =>
      queryLatestCheckoutStatusObservations({
        dbPath: input.dbPath,
        limit: MAX_WORK_FACT_QUERY_LIMIT,
        paths: chunk,
        ...machineFilter,
      }),
    );
    const jiraIssues = yield* readInChunks(declaredJiraKeys(observations), (keys) =>
      queryLatestJiraIssueObservations({
        dbPath: input.dbPath,
        keys,
        limit: MAX_WORK_FACT_QUERY_LIMIT,
        ...machineFilter,
      }),
    );
    const { runs } = yield* queryWorkFactRunStates({ dbPath: input.dbPath });
    return { checkouts, jiraIssues, pullRequests, runStates: runs };
  });

/** Levels of `spawnedFrom` followed beyond the read to reach a root; the registry nests one or two. */
const MAX_PARENT_LOOKUPS = 8;

interface DesktopSessionRead {
  readonly observations: readonly ClaudeDesktopSessionObservation[];
  readonly skipped: number;
  /** Sessions were left unread: older than the recency page and asking nothing of the person. */
  readonly truncated: boolean;
}

/**
 * The bounded registry read. First the `MAX_CLAUDE_DESKTOP_SESSION_READ` most recently active
 * sessions, so a child outside the window still folds under its root. When more exist, the older
 * sessions that may carry a wait are read too (one more bounded page): a declaration that asks
 * something of the person, or a declared pull request an observation may show awaiting someone
 * else. A wait stays a wait at any age, and the recency bound must not hide it. A wait read only
 * from Jira (a reply on a key an older session wrote) is not selected by this page. Then the parents
 * the read names but does not hold are fetched by id, level by level, so a child is never shown
 * as an orphan only because its root is older than the page. What still escapes the read (older
 * sessions with nothing pending, pending ones beyond the second page) leaves `truncated` set.
 */
const readDesktopSessions = (
  dbPath: string,
  machineFilter: { readonly machineId?: string },
  scope?: WorkSessionReadScope,
): Effect.Effect<DesktopSessionRead, UsageStoreError> =>
  Effect.gen(function* () {
    const scopeFilter = scope === undefined ? {} : { scope };
    const recent = yield* queryClaudeDesktopSessions({
      dbPath,
      ...scopeFilter,
      limit: MAX_CLAUDE_DESKTOP_SESSION_READ,
      ...machineFilter,
    });
    const observations = [...recent.observations];
    let skipped = recent.skipped;
    let truncated = false;
    const oldest = recent.observations.at(-1)?.lastActivityAt;
    if (recent.truncated && oldest !== undefined) {
      const pending = yield* queryClaudeDesktopSessions({
        dbPath,
        limit: MAX_CLAUDE_DESKTOP_SESSION_READ,
        olderThanLastActivityAt: oldest,
        pendingOnly: true,
        ...scopeFilter,
        ...machineFilter,
      });
      observations.push(...pending.observations);
      skipped += pending.skipped;
      // Older sessions with nothing pending were not read, so the read is a selection either way.
      truncated = true;
    } else if (recent.truncated) {
      truncated = true;
    }
    const held = new Set(observations.map(sessionKey));
    for (let level = 0; level < MAX_PARENT_LOOKUPS; level++) {
      const missing = [
        ...new Set(
          observations.flatMap((observation) =>
            observation.spawnedFrom !== null &&
            !held.has(
              sessionKey({ desktopSessionId: observation.spawnedFrom.sessionId, machineId: observation.machineId }),
            )
              ? [observation.spawnedFrom.sessionId]
              : [],
          ),
        ),
      ].slice(0, MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER);
      if (missing.length === 0) {
        break;
      }
      const parents = yield* queryClaudeDesktopSessions({
        dbPath,
        desktopSessionIds: missing,
        limit: MAX_CLAUDE_DESKTOP_SESSION_READ,
        ...machineFilter,
      });
      const found = parents.observations.filter((parent) => !held.has(sessionKey(parent)));
      skipped += parents.skipped;
      if (found.length === 0) {
        // The parents named are not in the registry: their children stand as roots with a gap.
        break;
      }
      for (const parent of found) {
        held.add(sessionKey(parent));
        observations.push(parent);
      }
    }
    return { observations, skipped, truncated };
  });

/** The recorded declarations of every session read, in chunks of the store's id bound. */
const readDeclarationHistory = (
  dbPath: string,
  observations: readonly ClaudeDesktopSessionObservation[],
  machineFilter: { readonly machineId?: string },
): Effect.Effect<
  { readonly declarations: ClaudeDesktopTurnDeclaration[]; readonly skipped: number },
  UsageStoreError
> =>
  Effect.gen(function* () {
    const ids = [...new Set(observations.map((observation) => observation.desktopSessionId))];
    const declarations: ClaudeDesktopTurnDeclaration[] = [];
    let skipped = 0;
    for (let start = 0; start < ids.length; start += MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER) {
      const page = yield* queryClaudeDesktopTurnDeclarations({
        dbPath,
        desktopSessionIds: ids.slice(start, start + MAX_CLAUDE_DESKTOP_SESSION_ID_FILTER),
        ...machineFilter,
      });
      declarations.push(...page.declarations);
      skipped += page.skipped;
    }
    return { declarations, skipped };
  });

export const queryWorkAttention = (
  input: QueryWorkAttentionInput,
): Effect.Effect<WorkAttentionDataset, UsageStoreError> =>
  Effect.gen(function* () {
    const problem = boundsProblem(input);
    if (problem !== null) {
      return yield* Effect.fail(invalidInput(input.dbPath, problem));
    }
    const machineFilter = input.machineId === undefined ? {} : { machineId: input.machineId };
    // One reference instant for the harness window and the assembly, so both read the same window.
    const now = input.now ?? new Date();
    const sinceDays = input.sinceDays ?? WORK_ATTENTION_DEFAULT_SINCE_DAYS;
    const read = yield* readDesktopSessions(input.dbPath, machineFilter, input.scope);
    const states = yield* queryClaudeDesktopCollectionState({ dbPath: input.dbPath, ...machineFilter });
    const sessions = yield* joinSessions(input.dbPath, read.observations);
    const harnessRead = yield* queryRecentServedHarnessSessions({
      activeSince: now.getTime() - sinceDays * DAY_MS,
      dbPath: input.dbPath,
      harnessKey: WORK_UNDECLARED_HARNESS,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      // The Codex budget at most (ADR 0059): a family beyond it is counted, never shown.
      limit: Math.min(input.limit ?? WORK_ATTENTION_DEFAULT_LIMIT, WORK_ATTENTION_BOUNDS.maxCodexRoots),
      ...machineFilter,
    });
    const workIdentities = new Map<string, string[]>();
    for (const family of harnessRead.families) {
      for (const member of family.members) {
        const ids = workIdentities.get(member.machineId) ?? [];
        ids.push(member.sourceSessionId);
        workIdentities.set(member.machineId, ids);
      }
    }
    const workReads = yield* Effect.forEach([...workIdentities], ([machineId, sourceSessionIds]) =>
      queryCodexWorkObservations({ dbPath: input.dbPath, machineId, sourceSessionIds }),
    );
    const harnessSessions: WorkHarnessSessions = {
      ...harnessRead,
      harness: WORK_UNDECLARED_HARNESS,
      workObservations: workReads.flatMap((result) => result.observations),
      refusedRows: harnessRead.refusedRows + workReads.reduce((total, result) => total + result.skipped, 0),
    };
    const externalFacts = yield* readExternalFacts(input, read.observations, harnessSessions.families);
    const history = yield* readDeclarationHistory(input.dbPath, read.observations, machineFilter);
    const sessionsStored = yield* countClaudeDesktopSessions({
      dbPath: input.dbPath,
      ...machineFilter,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
    return assembleWorkAttention({
      collectionStates: states.states,
      declarations: history.declarations,
      externalFacts,
      harnessSessions,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...machineFilter,
      now,
      observations: read.observations,
      readTruncated: read.truncated,
      refusedRows: read.skipped + history.skipped,
      sessions,
      sessionsStored,
      ...(input.sinceDays === undefined ? {} : { sinceDays: input.sinceDays }),
      ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
    });
  });
