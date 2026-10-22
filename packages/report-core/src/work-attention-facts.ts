import path from 'node:path';
import { type CanonicalInstant, canonicalInstantEpochMs } from './canonical-instant';
import {
  type CheckoutStatusObservation,
  type ClaudeDesktopSessionObservation,
  describeCheckoutOutcome,
  describeCheckoutState,
  isCheckoutReadFailure,
  JIRA_ISSUE_KEY_PATTERN,
  type JiraIssueObservation,
  type PullRequestObservation,
  WORK_ATTENTION_BOUNDS,
  type WorkFact,
  type WorkInterpretation,
} from './work-attention';

/**
 * Pure interpretation of the external and local fact family (ADR 0051): turns stored
 * observations into `WorkFact`s with their provenance, and confronts those facts with time to
 * name what they do and do not establish. Nothing here is persisted; the read model calls it
 * with the facts it assembled for one root and merges the result with the declaration-based
 * interpretations.
 *
 * Every text names its date. A fact older than `freshMs` is never presented as current: it
 * yields a `coverage-gap` that says when the last observation happened and that the current
 * state is unknown. A failed observation never hides an older successful one; both facts can be
 * passed in and each is interpreted on its own.
 */

export type PullRequestFact = Extract<WorkFact, { readonly kind: 'pull-request' }>;
export type CheckoutStatusFact = Extract<WorkFact, { readonly kind: 'checkout-status' }>;

export const WORK_FACT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export const pullRequestFact = (observation: PullRequestObservation, factId: string): PullRequestFact => ({
  accountLabel: observation.accountLabel,
  checksRollup: observation.checksRollup,
  draft: observation.draft,
  host: observation.host,
  id: factId,
  kind: 'pull-request',
  mergedAt: observation.mergedAt,
  number: observation.number,
  outcome: observation.outcome,
  provenance: {
    coverage: observation.outcome === 'observed' ? 'complete' : 'partial',
    machineId: observation.machineId,
    observedAt: observation.observedAt,
    source: 'github',
  },
  repository: observation.repository,
  reviewDecision: observation.reviewDecision,
  state: observation.state,
  updatedAt: observation.updatedAt,
  url: observation.url,
});

export const checkoutStatusFact = (observation: CheckoutStatusObservation, factId: string): CheckoutStatusFact => ({
  ahead: observation.ahead,
  behind: observation.behind,
  branch: observation.branch,
  checkoutPath: observation.checkoutPath,
  dirty: observation.dirty,
  id: factId,
  kind: 'checkout-status',
  lastCommitAt: observation.lastCommitAt,
  modifiedCount: observation.modifiedCount,
  outcome: observation.outcome,
  provenance: {
    // A path that is gone, or not a repository, is completely observed: nothing more is there to read.
    coverage: isCheckoutReadFailure(observation.outcome) ? 'partial' : 'complete',
    machineId: observation.machineId,
    observedAt: observation.observedAt,
    source: 'local-checkout',
  },
  stagedCount: observation.stagedCount,
  untrackedCount: observation.untrackedCount,
});

export interface InterpretExternalFactsInput {
  readonly facts: readonly WorkFact[];
  /** How long an observation counts as current. Default 24 hours. */
  readonly freshMs?: number;
  readonly now: Date;
  /**
   * How many roots of the dataset share each checkout path (same machine as the facts). A count
   * above one is named in the local-changes statement: the changes seen there may belong to any
   * of those roots, not to this one.
   */
  readonly rootsPerCheckout?: ReadonlyMap<string, number>;
}

const { maxDetailText, maxInterpretations } = WORK_ATTENTION_BOUNDS;

const interpretation = (
  kind: WorkInterpretation['kind'],
  evidence: readonly string[],
  text: string,
  uncertainty: string,
): WorkInterpretation => ({
  evidence: [...evidence],
  kind,
  text: text.slice(0, maxDetailText),
  uncertainty: uncertainty.slice(0, maxDetailText),
});

const pullRequestLabel = (fact: PullRequestFact): string => `${fact.repository}#${String(fact.number)}`;

const ownerOf = (repository: string): string => repository.split('/')[0] ?? repository;

const staleUncertainty = (observedAt: string): string => `last observation ${observedAt}; current state unknown`;

const interpretPullRequest = (fact: PullRequestFact, stale: boolean): WorkInterpretation | null => {
  const label = pullRequestLabel(fact);
  const { observedAt } = fact.provenance;
  if (fact.outcome === 'unauthenticated') {
    const action =
      fact.accountLabel === null
        ? `sign in gh for ${fact.host}`
        : `configure github.accounts for ${ownerOf(fact.repository)} (gh login ${fact.accountLabel} has no usable token)`;
    return interpretation(
      'coverage-gap',
      [fact.id],
      `GitHub rejected the read of ${label} as unauthenticated at ${observedAt}.`,
      `Action: ${action}. Until then the pull request state is unknown.`,
    );
  }
  if (fact.outcome !== 'observed') {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `${label} could not be read from GitHub at ${observedAt} (${fact.outcome}).`,
      'The pull request state is unknown from this observation; an earlier successful one, if any, is the last known state.',
    );
  }
  if (fact.state === 'MERGED') {
    // A merge is final, so a stale merged observation still establishes the merge.
    return interpretation(
      'pull-request-merged',
      [fact.id],
      `${label} merged at ${fact.updatedAt ?? observedAt}; merge does not prove deployment.`,
      'Merge is final; what happened after it (deploy, release, revert) is unobserved.',
    );
  }
  if (stale) {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `${label} was ${fact.state ?? 'in an unknown state'} when last observed at ${observedAt}; nothing fresher.`,
      staleUncertainty(observedAt),
    );
  }
  if (fact.state === 'OPEN' && fact.draft === false && fact.reviewDecision !== 'APPROVED') {
    return interpretation(
      'external-review-pending',
      [fact.id],
      `${label} is open and awaiting review (${fact.reviewDecision ?? 'no review decision'}; checks ${fact.checksRollup ?? 'unknown'}) as of ${observedAt}.`,
      `Observed ${observedAt} via GitHub; a review or merge since then is not visible until the next observation.`,
    );
  }
  return null;
};

const interpretCheckout = (
  fact: CheckoutStatusFact,
  stale: boolean,
  sharedRoots: number,
): WorkInterpretation | null => {
  const label = path.basename(fact.checkoutPath) || fact.checkoutPath;
  const { observedAt } = fact.provenance;
  if (isCheckoutReadFailure(fact.outcome)) {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `Checkout ${label} could not be read at ${observedAt}: ${describeCheckoutOutcome(fact.outcome)}.`,
      'Local changes, if any, are unknown from this observation.',
    );
  }
  if (fact.outcome !== 'observed') {
    // Removed since the session, or never a repository: the fact says so; there is no gap to name.
    return null;
  }
  if (fact.dirty !== true) {
    return null;
  }
  if (stale) {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `Checkout ${label} had uncommitted changes when last observed at ${observedAt}; nothing fresher.`,
      staleUncertainty(observedAt),
    );
  }
  const shared = sharedRoots > 1 ? ` Checkout shared by ${String(sharedRoots)} roots.` : '';
  return interpretation(
    'local-changes-unvalidated',
    [fact.id],
    `${describeCheckoutState(fact)}, observed at ${observedAt} on ${fact.branch ?? 'a detached HEAD'} in ${label}; since when is unknown; validation and delivery unobserved.${shared}`,
    `The first dirty observation does not date the changes; whether they were tested, committed or pushed elsewhere is not visible.${sharedRoots > 1 ? ' The changes may belong to any of the roots sharing this checkout.' : ''}`,
  );
};

/**
 * Interprets the pull request and checkout facts of one root, in fact order, capped at the
 * contract's interpretation bound. Facts of other kinds are ignored here.
 */
export const interpretExternalFacts = (input: InterpretExternalFactsInput): WorkInterpretation[] => {
  const freshMs = input.freshMs ?? WORK_FACT_FRESHNESS_MS;
  const horizon = input.now.getTime() - freshMs;
  const interpretations: WorkInterpretation[] = [];
  for (const fact of input.facts) {
    if (fact.kind !== 'pull-request' && fact.kind !== 'checkout-status') {
      continue;
    }
    const stale = canonicalInstantEpochMs(fact.provenance.observedAt) < horizon;
    const result =
      fact.kind === 'pull-request'
        ? interpretPullRequest(fact, stale)
        : interpretCheckout(fact, stale, input.rootsPerCheckout?.get(fact.checkoutPath) ?? 1);
    if (result !== null) {
      interpretations.push(result);
    }
    if (interpretations.length >= maxInterpretations) {
      break;
    }
  }
  return interpretations;
};

// ---------------------------------------------------------------------------------------------
// Jira issues (ADR 0054): explicit keys only, read through the operator's `acli` session
// ---------------------------------------------------------------------------------------------

export type JiraIssueFact = Extract<WorkFact, { readonly kind: 'jira-issue' }>;

/** `<PROJECT>-0` is the local convention for "no ticket"; it never names an issue. */
const isPlaceholderJiraKey = (key: string): boolean => Number(key.slice(key.lastIndexOf('-') + 1)) === 0;

/**
 * The Jira keys one branch name writes explicitly: every `/`-separated segment that is a whole
 * issue key. The typed-prefix convention (`feat/XLB-2090/slug`, `fix/…`, `chore/…`, `hotfix/…`,
 * `release/…`) is the common case of that rule; a number alone (`pr/user/123`), a key embedded
 * in prose, or anything outside the branch name is never a link.
 */
export const jiraKeysInBranch = (branch: string): readonly string[] => {
  const keys: string[] = [];
  for (const segment of branch.split('/')) {
    if (JIRA_ISSUE_KEY_PATTERN.test(segment) && !isPlaceholderJiraKey(segment) && !keys.includes(segment)) {
      keys.push(segment);
    }
  }
  return keys;
};

/**
 * The Jira keys a Desktop session linked explicitly, each once, in the order first written:
 * `writtenBranches[]`, then its own `branch` and `sourceBranch`, then the branches of the pull
 * requests it declared. The title, the working directory and the transcript are never consulted.
 */
export const explicitJiraKeys = (
  session: Pick<
    ClaudeDesktopSessionObservation,
    'branch' | 'declaredPullRequests' | 'sourceBranch' | 'writtenBranches'
  >,
): readonly string[] => {
  const branches = [
    ...session.writtenBranches,
    ...(session.branch === null ? [] : [session.branch]),
    ...(session.sourceBranch === null ? [] : [session.sourceBranch]),
    ...session.declaredPullRequests.flatMap((pullRequest) => (pullRequest.branch === null ? [] : [pullRequest.branch])),
  ];
  const keys: string[] = [];
  for (const branch of branches) {
    for (const key of jiraKeysInBranch(branch)) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
};

/**
 * The fact one observation yields for one root. `newCommentsSince` counts the kept comments
 * created after `keyLastActivityAt` (at most the ten the observation holds): the latest activity
 * on the key across every family that wrote it, which the read model computes, or the family's
 * own when it is the only one. It is `null` when the read failed, because the failure says
 * nothing about the comments.
 */
export const jiraIssueFact = (
  observation: JiraIssueObservation,
  factId: string,
  keyLastActivityAt: CanonicalInstant,
): JiraIssueFact => {
  const newestCommentAt = observation.comments.reduce<CanonicalInstant | null>(
    (newest, comment) => (newest === null || comment.createdAt > newest ? comment.createdAt : newest),
    null,
  );
  return {
    commentCount: observation.commentCount,
    id: factId,
    key: observation.key,
    kind: 'jira-issue',
    newCommentsSince:
      observation.outcome === 'observed'
        ? observation.comments.filter((comment) => comment.createdAt > keyLastActivityAt).length
        : null,
    newestCommentAt,
    outcome: observation.outcome,
    provenance: {
      coverage: observation.outcome === 'observed' ? 'complete' : 'partial',
      machineId: observation.machineId,
      observedAt: observation.observedAt,
      source: 'jira',
    },
    status: observation.status,
    statusCategory: observation.statusCategory,
    updatedAt: observation.updatedAt,
    url: null,
  };
};

/** The latest activity on one Jira key across the families that wrote it, and which family it was. */
export interface JiraKeyActivity {
  readonly lastActivityAt: CanonicalInstant;
  /** The title of the root whose family was last active on the key. */
  readonly latestFamilyTitle: string;
}

export interface InterpretJiraFactsInput {
  /** The root's facts: the Jira facts to interpret and the pull request facts they are confronted with. */
  readonly facts: readonly WorkFact[];
  /** The latest `lastActivityAt` of the root and its children. */
  readonly familyLastActivityAt: CanonicalInstant;
  /** How long an observation counts as current. Default 24 hours. */
  readonly freshMs?: number;
  /**
   * Per key, the latest activity across every family that wrote it (same machine). A key absent
   * here was written by this family alone. Only the family whose activity is that latest one is
   * asked to answer a reply; the others are told where the reply is carried.
   */
  readonly keyActivity?: ReadonlyMap<string, JiraKeyActivity>;
  readonly now: Date;
}

const DELIVERED_PULL_REQUEST_STATES = new Set(['OPEN', 'MERGED']);

interface PullRequestStanding {
  readonly at: CanonicalInstant;
  readonly label: string;
  readonly source: string;
  readonly state: string;
}

/** The pull request a Jira status is confronted with: GitHub's observation first, else the session's declaration. */
const pullRequestStanding = (facts: readonly WorkFact[]): PullRequestStanding | null => {
  for (const fact of facts) {
    if (
      fact.kind === 'pull-request' &&
      fact.outcome === 'observed' &&
      fact.state !== null &&
      DELIVERED_PULL_REQUEST_STATES.has(fact.state)
    ) {
      return {
        at: fact.updatedAt ?? fact.provenance.observedAt,
        label: pullRequestLabel(fact),
        source: 'GitHub',
        state: fact.state,
      };
    }
  }
  for (const fact of facts) {
    if (fact.kind === 'declared-pull-request' && DELIVERED_PULL_REQUEST_STATES.has(fact.state.toUpperCase())) {
      return {
        at: fact.provenance.observedAt,
        label: `${fact.repository}#${String(fact.number)}`,
        source: 'the session declared',
        state: fact.state.toUpperCase(),
      };
    }
  }
  return null;
};

const JIRA_FAILURE_UNCERTAINTY =
  'The ticket state is unknown from this observation; an earlier successful read, if any, is the last known state.';

const interpretJiraFailure = (fact: JiraIssueFact): WorkInterpretation => {
  const { observedAt } = fact.provenance;
  if (fact.outcome === 'unauthenticated') {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `Jira rejected the read of ${fact.key} as unauthenticated at ${observedAt}.`,
      'Action: sign in to Jira (acli jira auth login). Until then the ticket state is unknown; an earlier successful read, if any, is the last known state.',
    );
  }
  if (fact.outcome === 'disabled') {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `${fact.key} could not be read at ${observedAt}: the Atlassian CLI (acli) is not installed.`,
      JIRA_FAILURE_UNCERTAINTY,
    );
  }
  return interpretation(
    'coverage-gap',
    [fact.id],
    `${fact.key} could not be read from Jira at ${observedAt} (${fact.outcome}).`,
    JIRA_FAILURE_UNCERTAINTY,
  );
};

const interpretJiraIssue = (
  fact: JiraIssueFact,
  input: InterpretJiraFactsInput,
  stale: boolean,
  pullRequest: PullRequestStanding | null,
): WorkInterpretation[] => {
  if (fact.outcome !== 'observed') {
    return [interpretJiraFailure(fact)];
  }
  const { observedAt } = fact.provenance;
  const results: WorkInterpretation[] = [];
  const arrived = fact.newCommentsSince ?? 0;
  const keyActivity = input.keyActivity?.get(fact.key);
  if (arrived > 0 && (keyActivity === undefined || input.familyLastActivityAt >= keyActivity.lastActivityAt)) {
    // A comment that arrived is final, so a stale observation still establishes the arrival.
    results.push(
      interpretation(
        'jira-reply-arrived',
        [fact.id],
        `${String(arrived)} comment${arrived === 1 ? '' : 's'} arrived on ${fact.key} after this session family's last activity (${input.familyLastActivityAt}); no resumption observed.`,
        `You may have read them in Jira; this view cannot tell. Newest comment ${fact.newestCommentAt ?? 'undated'}, observed ${observedAt}.`,
      ),
    );
  } else if (arrived > 0 && keyActivity !== undefined) {
    // A later family relayed the key: the reply is theirs to answer, and this root only says so.
    results.push(
      interpretation(
        'jira-reply-elsewhere',
        [fact.id],
        `${String(arrived)} comment${arrived === 1 ? '' : 's'} arrived on ${fact.key} after the latest activity on this key (${keyActivity.lastActivityAt}); the most recent family on this key is “${keyActivity.latestFamilyTitle}”, which carries the request.`,
        `This family last worked on ${fact.key} at ${input.familyLastActivityAt}; whether the reply concerns it is not known. Newest comment ${fact.newestCommentAt ?? 'undated'}, observed ${observedAt}.`,
      ),
    );
  }
  if (!stale && fact.statusCategory === 'todo' && pullRequest !== null) {
    results.push(
      interpretation(
        'jira-status-differs',
        [fact.id],
        `${fact.key} is still To Do (Jira status ${fact.status ?? 'To Do'}, observed ${observedAt}) while ${pullRequest.label} is ${pullRequest.state} (${pullRequest.source} ${pullRequest.at}); a different status is not automatically an error.`,
        'Whether the ticket should follow the pull request is a team convention this view does not know; both are dated reads, not current states.',
      ),
    );
  }
  if (stale && results.length === 0) {
    results.push(
      interpretation(
        'coverage-gap',
        [fact.id],
        `${fact.key} was ${fact.status ?? 'in an unknown status'} when last observed at ${observedAt}; nothing fresher.`,
        staleUncertainty(observedAt),
      ),
    );
  }
  return results;
};

/**
 * Interprets the Jira facts of one root, in fact order, capped at the contract's interpretation
 * bound. A reply that arrived after the latest activity on the key is named as a request only on
 * the family that was last active on that key, without claiming it was not read elsewhere; an
 * older family on the same key is told which family carries it (`jira-reply-elsewhere`), so a
 * ticket relayed from branch to branch never leaves a permanent request on every family that
 * once wrote it. A To Do ticket beside an open or merged pull request is named as a difference,
 * not as an error; a failed read names its cause and the exact action when there is one. Facts
 * of other kinds are consulted (pull requests) but never interpreted here.
 */
export const interpretJiraFacts = (input: InterpretJiraFactsInput): WorkInterpretation[] => {
  const freshMs = input.freshMs ?? WORK_FACT_FRESHNESS_MS;
  const horizon = input.now.getTime() - freshMs;
  const pullRequest = pullRequestStanding(input.facts);
  const interpretations: WorkInterpretation[] = [];
  for (const fact of input.facts) {
    if (fact.kind !== 'jira-issue') {
      continue;
    }
    const stale = canonicalInstantEpochMs(fact.provenance.observedAt) < horizon;
    interpretations.push(...interpretJiraIssue(fact, input, stale, pullRequest));
    if (interpretations.length >= maxInterpretations) {
      break;
    }
  }
  return interpretations.slice(0, maxInterpretations);
};
