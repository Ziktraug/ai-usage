import { type CanonicalInstant, canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import {
  CLAUDE_DESKTOP_FIXTURE_PAIRS,
  claudeDesktopFixtureRegistry,
  type SeededClaudeDesktopSessionIds,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type {
  CheckoutStatusObservation,
  ClaudeDesktopCollectionCompleteness,
  ClaudeDesktopSessionObservation,
  ClaudeDesktopTurnDeclaration,
  JiraIssueObservation,
  PullRequestObservation,
  WorkAttentionDataset,
} from '@ai-usage/report-core/work-attention';
import {
  advanceClaudeDesktopDeclarationHistory,
  parseClaudeDesktopSessionFile,
} from '@ai-usage/report-core/work-attention-native';
import {
  assembleWorkAttention,
  NO_SERVED_REVISION,
  WORK_UNDECLARED_HARNESS,
  type WorkAttentionExternalFacts,
  type WorkHarnessSessions,
} from '@ai-usage/report-data/work-attention-read';
import type { ServedHarnessSessionMember } from '@ai-usage/usage-store/reader';
import type { WorkAttentionInput } from '@ai-usage/web-contract/work';
import type { WorkAttentionServerResult } from './work-attention.server';

/**
 * The e2e composition of `work.attention`: the representative seeded registry, normalized by the
 * same parser the collector runs and assembled by the same read model live mode runs, held in
 * memory for the process. The web app may not import the collector or the store writer (package
 * boundaries), so the only link live mode has and this one lacks is the SQLite round trip; every
 * clamp, fold, attachment, interpretation and ranking is the production code.
 *
 * The external and local facts are synthetic observations shaped as the engine's producers store
 * them, chosen so the fixture shows each confrontation the Work view renders: a pull request
 * awaiting review, one merged after the request that asked for it, a checkout with uncommitted
 * changes, a pull request GitHub refused to read with an older successful read behind it, and
 * three Jira tickets (ADR 0054): a reply that arrived after the family's last activity, a ticket
 * still To Do beside a merged pull request, and a read Jira refused with an older success.
 *
 * Codex sessions (ADR 0059) arrive as the served families `queryRecentServedHarnessSessions`
 * returns, shaped by hand because the web app may not run the collector: a root in the seeded
 * repository with a delegated child and an automated review, a session in the shared dirty
 * worktree, and a delegated session whose parent was never collected. None of them declares a
 * wait; the production path (`work-production.spec.ts`) carries real seeded rollouts.
 */

/** The id the other e2e fixtures use for the current machine, so a machine filter matches. */
export const WORK_ATTENTION_E2E_MACHINE_ID = 'e2e-current-machine';
/** Fixed clock: the seeded ages (one hour to forty days) are relative to it. */
export const WORK_ATTENTION_E2E_NOW = new Date('2026-10-20T12:00:00.000Z');
const E2E_HOME = '/e2e/home';
/** The seeded repository checkout; every registry `cwd` is this path or a worktree under it. */
export const WORK_ATTENTION_E2E_REPOSITORY = `${E2E_HOME}/work/fixture`;
/** The worktree the blocked root and the routine worktree sessions share. */
export const WORK_ATTENTION_E2E_WORKTREE = `${WORK_ATTENTION_E2E_REPOSITORY}/.claude/worktrees/checkout-3`;
const E2E_TRANSCRIPT_ID = 'claude-fixture-025';
const E2E_REPOSITORY_SLUG = 'fixture/ai-usage';
/** The ticket on which a reply arrived after the review-ready family's last activity. */
export const WORK_ATTENTION_E2E_JIRA_REPLY_KEY = 'XLB-2090';
/** The ticket still To Do while the merged-before family's pull request is merged. */
export const WORK_ATTENTION_E2E_JIRA_TODO_KEY = 'XLB-2101';
/** The ticket Jira refused to read, with an older successful read behind it. */
export const WORK_ATTENTION_E2E_JIRA_UNREADABLE_KEY = 'XLB-1998';
/** The served revision the e2e Codex families are said to come from. */
export const WORK_ATTENTION_E2E_CODEX_REVISION = 'e2e-codex-revision';
export const WORK_ATTENTION_E2E_CODEX_ROOT_TITLE = 'Fixture Codex: refactor the collector';
export const WORK_ATTENTION_E2E_CODEX_WORKTREE_TITLE = 'Fixture Codex: checkout 3 follow-up';
export const WORK_ATTENTION_E2E_CODEX_ORPHAN_TITLE = 'Fixture Codex: orphaned delegate';

interface E2EWorkAttentionSource {
  /** The recent served Codex families, as the store read returns them. */
  readonly codexSessions: WorkHarnessSessions;
  readonly completeness: ClaudeDesktopCollectionCompleteness;
  /** The declaration history the store would have recorded over the earlier sweeps and the last one. */
  readonly declarations: readonly ClaudeDesktopTurnDeclaration[];
  readonly externalFacts: WorkAttentionExternalFacts;
  readonly observations: readonly ClaudeDesktopSessionObservation[];
}

let source: E2EWorkAttentionSource | undefined;

const hoursBefore = (hours: number): CanonicalInstant =>
  canonicalInstantFromDate(new Date(WORK_ATTENTION_E2E_NOW.getTime() - hours * 3_600_000));

/**
 * The seeded registry is shared with other fixtures and writes no Jira key in a branch name, so
 * the explicit links the Jira facts need are added here, on the parsed observations, the way a
 * session would have written them (ADR 0054: a whole branch segment, never a title). The
 * review-ready root and the proposal root each write one branch; the merged-before family's
 * child names its ticket in the branch of the pull request it declared.
 */
const withJiraLinks = (
  observation: ClaudeDesktopSessionObservation,
  ids: SeededClaudeDesktopSessionIds,
): ClaudeDesktopSessionObservation => {
  if (observation.desktopSessionId === ids.reviewReadyRoot) {
    return {
      ...observation,
      writtenBranches: [...observation.writtenBranches, `feat/${WORK_ATTENTION_E2E_JIRA_REPLY_KEY}/store-migration`],
    };
  }
  if (observation.desktopSessionId === ids.proposalRoot) {
    return {
      ...observation,
      writtenBranches: [...observation.writtenBranches, `feat/${WORK_ATTENTION_E2E_JIRA_UNREADABLE_KEY}/proposals`],
    };
  }
  if (observation.declaredPullRequests.some((pullRequest) => pullRequest.number === 90)) {
    return {
      ...observation,
      declaredPullRequests: observation.declaredPullRequests.map((pullRequest) =>
        pullRequest.number === 90
          ? { ...pullRequest, branch: `fix/${WORK_ATTENTION_E2E_JIRA_TODO_KEY}/earlier-merged-fix` }
          : pullRequest,
      ),
    };
  }
  return observation;
};

const jiraObservation = (key: string, overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation => ({
  assigneeLabel: 'Fixture assignee',
  commentCount: 0,
  comments: [],
  key,
  machineId: WORK_ATTENTION_E2E_MACHINE_ID,
  observedAt: hoursBefore(1),
  outcome: 'observed',
  outcomeMessage: null,
  parentKey: null,
  sprint: 'Fixture sprint',
  status: 'In Progress',
  statusCategory: 'in-progress',
  summary: `Fixture ticket ${key}`,
  updatedAt: hoursBefore(6),
  ...overrides,
});

const pullRequestObservation = (
  number: number,
  overrides: Partial<PullRequestObservation> = {},
): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'fixture-main',
  checksRollup: 'pending',
  draft: false,
  headRef: `fixture/pr-${String(number)}`,
  host: 'github.com',
  machineId: WORK_ATTENTION_E2E_MACHINE_ID,
  mergedAt: null,
  number,
  observedAt: hoursBefore(2),
  outcome: 'observed',
  outcomeMessage: null,
  repository: E2E_REPOSITORY_SLUG,
  reviewDecision: null,
  state: 'OPEN',
  title: `Fixture pull request ${String(number)}`,
  updatedAt: hoursBefore(3),
  url: `https://github.com/${E2E_REPOSITORY_SLUG}/pull/${String(number)}`,
  ...overrides,
});

/**
 * Pull request 118 (declared by the completed root) is open and awaiting review as of two hours
 * ago. Pull request 90 (declared merged by a child long before its root asked to merge it) was
 * merged two hours ago as GitHub shows it, after the request. Pull request 117 (declared by the
 * satisfied root's child) could not be read half an hour ago for lack of credentials; the last
 * successful read, a day ago, showed it open. The shared worktree had uncommitted changes forty
 * minutes ago. On Jira, XLB-2090 received a reply six hours ago, after the review-ready family's
 * last activity (eleven hours ago); XLB-2101 is still To Do while pull request 90 is merged;
 * XLB-1998 could not be read half an hour ago for lack of credentials, and its last successful
 * read, a day ago, showed it in progress. Pull request 131, listed by the settings root's child
 * (which predates the question), merged five hours ago and answers nothing: the question asks for
 * no pull request. All three producers ran.
 */
const buildExternalFacts = (): WorkAttentionExternalFacts => {
  const awaitingReview = pullRequestObservation(118);
  const merged = pullRequestObservation(90, {
    checksRollup: 'success',
    mergedAt: hoursBefore(2),
    observedAt: hoursBefore(1),
    reviewDecision: 'APPROVED',
    state: 'MERGED',
    updatedAt: hoursBefore(2),
  });
  // Listed by a child that predates the settings question; merged after it, it still answers nothing.
  const unrelatedMerged = pullRequestObservation(131, {
    checksRollup: 'success',
    mergedAt: hoursBefore(5),
    observedAt: hoursBefore(1),
    reviewDecision: 'APPROVED',
    state: 'MERGED',
    updatedAt: hoursBefore(5),
  });
  const lastRead = pullRequestObservation(117, { observedAt: hoursBefore(26), updatedAt: hoursBefore(27) });
  const unreadable = pullRequestObservation(117, {
    baseRef: null,
    checksRollup: null,
    draft: null,
    headRef: null,
    observedAt: hoursBefore(0.5),
    outcome: 'unauthenticated',
    outcomeMessage: 'gh exited 4',
    state: null,
    title: null,
    updatedAt: null,
    url: null,
  });
  const dirtyWorktree: CheckoutStatusObservation = {
    ahead: 1,
    behind: 0,
    branch: 'fixture/checkout-3',
    checkoutPath: WORK_ATTENTION_E2E_WORKTREE,
    dirty: true,
    headSha: 'e'.repeat(40),
    lastCommitAt: hoursBefore(5),
    machineId: WORK_ATTENTION_E2E_MACHINE_ID,
    modifiedCount: 2,
    observedAt: hoursBefore(40 / 60),
    outcome: 'observed',
    stagedCount: 0,
    untrackedCount: 1,
    upstream: null,
  };
  const replied = jiraObservation(WORK_ATTENTION_E2E_JIRA_REPLY_KEY, {
    commentCount: 2,
    comments: [
      {
        authorLabel: 'Fixture reviewer',
        createdAt: hoursBefore(6),
        excerpt: 'Fixture reply: can this land before the migration window closes?',
        id: '2',
      },
      { authorLabel: 'Fixture assignee', createdAt: hoursBefore(30), excerpt: 'Fixture: picking this up.', id: '1' },
    ],
  });
  const stillTodo = jiraObservation(WORK_ATTENTION_E2E_JIRA_TODO_KEY, {
    status: 'To Do',
    statusCategory: 'todo',
    updatedAt: hoursBefore(50),
  });
  const lastJiraRead = jiraObservation(WORK_ATTENTION_E2E_JIRA_UNREADABLE_KEY, { observedAt: hoursBefore(26) });
  const unreadableJira = jiraObservation(WORK_ATTENTION_E2E_JIRA_UNREADABLE_KEY, {
    assigneeLabel: null,
    observedAt: hoursBefore(0.5),
    outcome: 'unauthenticated',
    outcomeMessage: 'Jira rejected the credentials (HTTP 401); sign in to Jira (acli jira auth login)',
    sprint: null,
    status: null,
    statusCategory: null,
    summary: null,
    updatedAt: null,
  });
  return {
    checkouts: [{ latest: dirtyWorktree, latestObserved: dirtyWorktree }],
    jiraIssues: [
      { latest: replied, latestObserved: replied },
      { latest: stillTodo, latestObserved: stillTodo },
      { latest: unreadableJira, latestObserved: lastJiraRead },
    ],
    pullRequests: [
      { latest: awaitingReview, latestObserved: awaitingReview },
      { latest: merged, latestObserved: merged },
      { latest: unrelatedMerged, latestObserved: unrelatedMerged },
      { latest: unreadable, latestObserved: lastRead },
    ],
    runStates: [
      {
        disabled: false,
        failed: 1,
        machineId: WORK_ATTENTION_E2E_MACHINE_ID,
        message: null,
        observed: 4,
        ranAt: hoursBefore(0.5),
        sourceId: 'github.pull-requests',
      },
      {
        disabled: false,
        failed: 0,
        machineId: WORK_ATTENTION_E2E_MACHINE_ID,
        message: null,
        observed: 1,
        ranAt: hoursBefore(40 / 60),
        sourceId: 'checkouts.status',
      },
      {
        disabled: false,
        failed: 1,
        machineId: WORK_ATTENTION_E2E_MACHINE_ID,
        message: null,
        observed: 2,
        ranAt: hoursBefore(0.5),
        sourceId: 'jira.issues',
      },
    ],
  };
};

const codexMember = (spec: {
  readonly activeHoursAgo: number;
  readonly branch?: string;
  readonly campaignRoot?: boolean;
  readonly checkoutPath?: string;
  readonly id: string;
  readonly origin: 'classifier' | 'human' | 'subagent';
  readonly parent?: string;
  readonly title: string;
}): ServedHarnessSessionMember => {
  const checkoutPath = spec.checkoutPath ?? WORK_ATTENTION_E2E_REPOSITORY;
  return {
    activeAt: WORK_ATTENTION_E2E_NOW.getTime() - spec.activeHoursAgo * 3_600_000,
    branch: spec.branch ?? null,
    campaignRoot: spec.campaignRoot ?? false,
    checkoutPath,
    machineId: WORK_ATTENTION_E2E_MACHINE_ID,
    origin: spec.origin,
    parentSourceSessionId: spec.parent ?? null,
    projectLabel: checkoutPath.split('/').at(-1) ?? checkoutPath,
    rowId: `e2e-codex-row-${spec.id}`,
    sourceSessionId: spec.id,
    startedAt: hoursBefore(spec.activeHoursAgo + 1),
    title: spec.title,
  };
};

const codexFamily = (members: readonly ServedHarnessSessionMember[]) => {
  const [root] = members;
  if (root === undefined) {
    throw new Error('An e2e Codex family needs a root.');
  }
  return {
    campaignKey: `${WORK_ATTENTION_E2E_MACHINE_ID}:codex:${root.sourceSessionId}`,
    lastActiveAt: Math.max(...members.map((member) => member.activeAt ?? 0)),
    memberCount: members.length,
    members,
  };
};

const buildCodexSessions = (): WorkHarnessSessions => {
  const families = [
    codexFamily([
      codexMember({
        activeHoursAgo: 3,
        branch: 'fixture/main',
        campaignRoot: true,
        id: 'codex-e2e-root',
        origin: 'human',
        title: WORK_ATTENTION_E2E_CODEX_ROOT_TITLE,
      }),
      codexMember({
        activeHoursAgo: 2,
        id: 'codex-e2e-child',
        origin: 'subagent',
        parent: 'codex-e2e-root',
        title: 'Fixture Codex: delegated slice',
      }),
      codexMember({
        activeHoursAgo: 2.5,
        id: 'codex-e2e-review',
        origin: 'classifier',
        title: 'Fixture Codex: review',
      }),
    ]),
    // In the shared dirty worktree: the checkout fact attaches by its exact path, no wait follows.
    codexFamily([
      codexMember({
        activeHoursAgo: 1.5,
        branch: 'fixture/checkout-3',
        campaignRoot: true,
        checkoutPath: WORK_ATTENTION_E2E_WORKTREE,
        id: 'codex-e2e-worktree',
        origin: 'human',
        title: WORK_ATTENTION_E2E_CODEX_WORKTREE_TITLE,
      }),
    ]),
    codexFamily([
      codexMember({
        activeHoursAgo: 5,
        campaignRoot: true,
        id: 'codex-e2e-orphan',
        origin: 'subagent',
        parent: 'codex-e2e-gone',
        title: WORK_ATTENTION_E2E_CODEX_ORPHAN_TITLE,
      }),
    ]),
  ];
  return {
    families,
    familiesInWindow: families.length,
    generatedAt: hoursBefore(0.25),
    harness: WORK_UNDECLARED_HARNESS,
    refusedRows: 0,
    revision: WORK_ATTENTION_E2E_CODEX_REVISION,
  };
};

const buildSource = (): E2EWorkAttentionSource => {
  const registry = claudeDesktopFixtureRegistry({
    cliSessionIdWithTranscript: E2E_TRANSCRIPT_ID,
    epoch: WORK_ATTENTION_E2E_NOW,
    repository: WORK_ATTENTION_E2E_REPOSITORY,
    variant: 'representative',
  });
  const observedAt = WORK_ATTENTION_E2E_NOW.toISOString();
  const parseContext = (entry: (typeof registry.documents)[number], sweptAt: string) => ({
    accountDirectory: entry.account,
    fileModifiedAt: entry.modifiedAt.toISOString(),
    machineId: WORK_ATTENTION_E2E_MACHINE_ID,
    observedAt: sweptAt,
    organizationDirectory: entry.organization,
    relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
  });
  // The sweeps the engine would have made before: each earlier file state, seen a minute after it
  // was written, advances the history exactly as the store import does (ADR 0056).
  let declarations: readonly ClaudeDesktopTurnDeclaration[] = [];
  const advance = (observation: ClaudeDesktopSessionObservation): void => {
    const others = declarations.filter((row) => row.desktopSessionId !== observation.desktopSessionId);
    declarations = [...others, ...advanceClaudeDesktopDeclarationHistory(declarations, observation)];
  };
  for (const entry of registry.history) {
    const earlier = parseClaudeDesktopSessionFile(entry.document, parseContext(entry, entry.modifiedAt.toISOString()));
    if (earlier.kind !== 'observation') {
      throw new Error(`The e2e Desktop history file ${entry.fileName} does not parse.`);
    }
    advance(earlier.observation);
  }
  const observations: ClaudeDesktopSessionObservation[] = [];
  const completeness = { filesParsed: 0, filesSeen: 0, rejected: 0, truncated: false, unsupported: 0 };
  for (const entry of registry.documents) {
    completeness.filesSeen += 1;
    const pairIndex = CLAUDE_DESKTOP_FIXTURE_PAIRS.findIndex((pair) => pair.account === entry.account);
    const result = parseClaudeDesktopSessionFile(entry.document, parseContext(entry, observedAt));
    if (result.kind === 'observation') {
      completeness.filesParsed += 1;
      advance(result.observation);
      observations.push(withJiraLinks(result.observation, registry.ids));
    } else if (result.kind === 'unsupported') {
      completeness.unsupported += 1;
      if (result.observation !== null) {
        observations.push(result.observation);
      }
    } else {
      completeness.rejected += 1;
    }
    if (pairIndex < 0) {
      throw new Error('The e2e Desktop registry names an account outside its pairs.');
    }
  }
  return {
    codexSessions: buildCodexSessions(),
    completeness,
    declarations,
    externalFacts: buildExternalFacts(),
    observations,
  };
};

const getSource = (): E2EWorkAttentionSource => {
  source ??= buildSource();
  return source;
};

export const readE2EWorkAttention = (request: WorkAttentionInput): Promise<WorkAttentionServerResult> => {
  const { codexSessions, completeness, declarations, externalFacts, observations } = getSource();
  const data: WorkAttentionDataset = assembleWorkAttention({
    collectionStates: [
      { collectedAt: WORK_ATTENTION_E2E_NOW.toISOString(), completeness, machineId: WORK_ATTENTION_E2E_MACHINE_ID },
    ],
    declarations,
    externalFacts,
    harnessSessions: codexSessions,
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.machineId === undefined || request.machineId === null ? {} : { machineId: request.machineId }),
    now: WORK_ATTENTION_E2E_NOW,
    observations,
    sessions: NO_SERVED_REVISION,
  });
  return Promise.resolve({ data, ok: true });
};
