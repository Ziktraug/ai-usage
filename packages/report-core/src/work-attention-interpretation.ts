import type { CanonicalInstant } from './canonical-instant';
import { normalizeIsoTimestamp } from './provider-status';
import {
  WORK_ATTENTION_BOUNDS,
  type WorkAttentionKind,
  type WorkFact,
  type WorkInterpretation,
  type WorkRootDeclaration,
} from './work-attention';

/**
 * The confrontation of one root's declaration with the facts gathered around it (CONTEXT.md:
 * Interpretation). Pure and synchronous: the read model assembles declaration, facts and
 * coverage, this function names what they add up to and how sure it is. Nothing here is
 * persisted; a changed rule re-reads the same facts differently on the next request.
 *
 * The external and local fact family (`pull-request`, `checkout-status`) is interpreted by
 * `work-attention-facts.ts`; the read model merges both results. The one rule here that reads an
 * observed pull request is the reconsideration of a request, because that confrontation needs the
 * declaration. A `pull-request` fact reaches this function only when the read model attached it
 * to the root, which it does for the pull requests the session family declared and for nothing
 * else (never by branch or by proximity).
 *
 * A request is never closed by this function. A later pull request can at most mark the root
 * `reconsidered`: the attention stays `human-request`, the question stays the operator's, and the
 * interpretation says which pull request may be the answer and why that is not proof.
 */

export const WORK_ATTENTION_STALE_AFTER_MS = 7 * 86_400_000;

export interface WorkRootCoverageInput {
  /** `spawnedFrom` named a session the registry does not contain; this root may be someone's child. */
  readonly parentMissing: boolean;
  /**
   * Whether the collected Session row for this root's transcript was found. `null` means the
   * join could not be consulted (no served revision), which is a dataset-level gap, not this root's.
   */
  readonly sessionJoined: boolean | null;
  /** Non-null when the Desktop file had a shape this reader does not support. */
  readonly unsupportedReason: string | null;
}

export interface InterpretWorkRootInput {
  readonly coverage: WorkRootCoverageInput;
  readonly declaration: WorkRootDeclaration | null;
  readonly facts: readonly WorkFact[];
  readonly now: CanonicalInstant | Date | string;
  /** Age past which a declaration is reported as stale; defaults to seven days. */
  readonly staleAfterMs?: number;
}

export interface WorkRootInterpretationResult {
  readonly attention: WorkAttentionKind;
  readonly interpretations: readonly WorkInterpretation[];
  /** A later pull request may have answered the request; `attention` is unchanged by it. */
  readonly reconsidered: boolean;
}

/**
 * The explicit vocabulary that lets a later pull request be read as a possible answer to a
 * request. Deliberately narrow: a `needs_action` that says "yes?" or "which option?" never
 * matches, so a later pull request cannot be attached to a question it did not answer.
 */
const PULL_REQUEST_VOCABULARY =
  /\b(?:prs?|pull[ -]requests?|push(?:ed|es|ing)?|commit(?:s|ted|ting)?|merg(?:e|ed|es|ing))\b/iu;

const ANSWERING_DECLARED_STATES = new Set(['OPEN', 'MERGED']);

const { maxInterpretations } = WORK_ATTENTION_BOUNDS;
const MAX_LISTED_PULL_REQUESTS = 3;

const instantOf = (value: CanonicalInstant | Date | string): CanonicalInstant | null =>
  value instanceof Date ? normalizeIsoTimestamp(value.getTime()) : normalizeIsoTimestamp(value);

/** The question a blocked declaration asks, or `null` when it asks nothing the product can relay. */
const requestedAction = (declaration: WorkRootDeclaration | null): string | null =>
  declaration !== null &&
  declaration.status === 'blocked' &&
  declaration.needsAction !== null &&
  declaration.needsAction.trim().length > 0
    ? declaration.needsAction
    : null;

const asksForPullRequest = (needsAction: string): boolean => PULL_REQUEST_VOCABULARY.test(needsAction);

type DeclaredPullRequestFact = Extract<WorkFact, { kind: 'declared-pull-request' }>;
type ObservedPullRequestFact = Extract<WorkFact, { kind: 'pull-request' }>;
type PullRequestLinkFact = DeclaredPullRequestFact | ObservedPullRequestFact;

const sameLink = (left: PullRequestLinkFact, right: PullRequestLinkFact): boolean =>
  left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
  left.repository.trim() === right.repository.trim() &&
  left.number === right.number;

/**
 * Pull requests a child session declared open or merged, listed at or after the request. "After"
 * reads the child's own last activity, never the registry file's modification time: the desktop
 * app rewrites a session file without any activity in it. The root's own `prs[]` never counts:
 * the desktop app fills it from the checkout branch, so it mirrors where the session sits, not
 * what answered its question; the read model also leaves out a child's listing that mirrors the
 * root's checkout.
 */
const childDeclaredPullRequests = (
  facts: readonly WorkFact[],
  declaredAt: CanonicalInstant,
): DeclaredPullRequestFact[] =>
  facts.filter(
    (fact): fact is DeclaredPullRequestFact =>
      fact.kind === 'declared-pull-request' &&
      fact.declaredBy === 'child' &&
      ANSWERING_DECLARED_STATES.has(fact.state.toUpperCase()) &&
      fact.lastActivityAt >= declaredAt,
  );

/**
 * GitHub observations that may be the answer: a pull request merged at or after the request, or
 * one open (not a draft) and changed at or after it when a child session also declared it after
 * the request. An open pull request merely updated after the question is a hint, not an answer,
 * and yields nothing here.
 */
const answeringObservedPullRequests = (
  facts: readonly WorkFact[],
  declaredAt: CanonicalInstant,
  childDeclared: readonly DeclaredPullRequestFact[],
): ObservedPullRequestFact[] =>
  facts.filter(
    (fact): fact is ObservedPullRequestFact =>
      fact.kind === 'pull-request' &&
      fact.outcome === 'observed' &&
      fact.provenance.observedAt >= declaredAt &&
      ((fact.state === 'MERGED' && fact.mergedAt !== null && fact.mergedAt >= declaredAt) ||
        (fact.state === 'OPEN' &&
          fact.draft !== true &&
          fact.updatedAt !== null &&
          fact.updatedAt >= declaredAt &&
          childDeclared.some((declared) => sameLink(declared, fact)))),
  );

const pullRequestEvidence = (fact: PullRequestLinkFact): string =>
  fact.kind === 'declared-pull-request'
    ? `${fact.repository}#${fact.number} (${fact.state.toUpperCase()}) listed by a child session (last active at ${fact.lastActivityAt})`
    : `${fact.repository}#${fact.number} (${fact.state ?? 'unknown'}${
        fact.state === 'MERGED' && fact.mergedAt !== null ? `, merged at ${fact.mergedAt}` : ''
      }) observed on GitHub at ${fact.provenance.observedAt}`;

/** The text names a few pull requests; the evidence carries them all. */
const listEvidence = (facts: readonly PullRequestLinkFact[]): string => {
  const parts = facts.slice(0, MAX_LISTED_PULL_REQUESTS).map(pullRequestEvidence);
  const more = facts.length - parts.length;
  return `${parts.join('; ')}${more > 0 ? ` and ${more} more` : ''}`;
};

const possiblyAnsweredElsewhere = (
  declared: readonly DeclaredPullRequestFact[],
  observed: readonly ObservedPullRequestFact[],
): WorkInterpretation => ({
  evidence: [...declared, ...observed].map((fact) => fact.id),
  kind: 'request-satisfied-elsewhere',
  text: `Possibly answered elsewhere: ${listEvidence([...declared, ...observed])}, after the question.`,
  uncertainty: 'This does not prove it is the same work; the question stays yours until you confirm.',
});

export const interpretWorkRoot = (input: InterpretWorkRootInput): WorkRootInterpretationResult => {
  const now = instantOf(input.now);
  if (now === null) {
    throw new RangeError('interpretWorkRoot requires a valid `now` instant');
  }
  const staleAfterMs = input.staleAfterMs ?? WORK_ATTENTION_STALE_AFTER_MS;
  if (!(Number.isSafeInteger(staleAfterMs) && staleAfterMs > 0)) {
    throw new RangeError('interpretWorkRoot requires a positive `staleAfterMs`');
  }
  const interpretations: WorkInterpretation[] = [];
  let attention: WorkAttentionKind = 'none';
  let reconsidered = false;
  const { declaration } = input;
  const declaredTurnEvidence = input.facts.filter((fact) => fact.kind === 'declared-turn').map((fact) => fact.id);

  const needsAction = requestedAction(declaration);
  if (declaration !== null && needsAction !== null) {
    attention = 'human-request';
    const asksPullRequest = asksForPullRequest(needsAction);
    const declared = asksPullRequest ? childDeclaredPullRequests(input.facts, declaration.at) : [];
    const observed = asksPullRequest ? answeringObservedPullRequests(input.facts, declaration.at, declared) : [];
    reconsidered = declared.length + observed.length > 0;
    interpretations.push({
      evidence: declaredTurnEvidence,
      kind: 'request-open',
      text: `The session stopped on a question: ${needsAction}`,
      uncertainty: reconsidered
        ? 'This is the session’s own last declaration; a later pull request may be the answer, but nothing confirms it.'
        : 'This is the session’s own last declaration; nothing observed since says it was answered.',
    });
    if (reconsidered) {
      interpretations.push(possiblyAnsweredElsewhere(declared, observed));
    }
  } else if (declaration !== null && declaration.status === 'review_ready') {
    attention = 'human-request';
    interpretations.push({
      evidence: declaredTurnEvidence,
      kind: 'review-ready',
      text: 'The session declared its change ready for a review.',
      uncertainty: 'Declared by the session; no review outcome has been observed.',
    });
  }

  const openProposals = input.facts.filter((fact) => fact.kind === 'proposal' && fact.resolution === 'open');
  if (openProposals.length > 0) {
    if (attention === 'none') {
      attention = 'optional-lead';
    }
    interpretations.push({
      evidence: openProposals.map((fact) => fact.id),
      kind: 'proposal-open',
      text: `${openProposals.length === 1 ? 'One proposal is' : `${openProposals.length} proposals are`} open and unanswered.`,
      uncertainty: 'Proposals are the session’s suggestions, not tasks; nothing says they are still wanted.',
    });
  }
  const resolvedProposals = input.facts.filter((fact) => fact.kind === 'proposal' && fact.resolution !== 'open');
  if (resolvedProposals.length > 0) {
    const dismissed = resolvedProposals.filter((fact) => fact.kind === 'proposal' && fact.resolution === 'dismissed');
    const started = resolvedProposals.length - dismissed.length;
    interpretations.push({
      evidence: resolvedProposals.map((fact) => fact.id),
      kind: 'proposal-resolved',
      text: [
        started > 0 ? `${started} proposal${started === 1 ? '' : 's'} started` : null,
        dismissed.length > 0 ? `${dismissed.length} proposal${dismissed.length === 1 ? '' : 's'} dismissed` : null,
      ]
        .filter((part) => part !== null)
        .join(', '),
      uncertainty:
        dismissed.length > 0
          ? '“dismissed” is an observed state; the reason is not recorded. “started” says a proposal was launched, not that it finished.'
          : '“started” says a proposal was launched, not that it finished.',
    });
  }

  if (declaration !== null && Date.parse(now) - Date.parse(declaration.at) > staleAfterMs) {
    interpretations.push({
      evidence: declaredTurnEvidence,
      kind: 'declared-status-stale',
      text: `The last declaration dates from ${declaration.at.slice(0, 10)}.`,
      uncertainty:
        'A declaration this old may no longer describe the session; it is kept because nothing newer replaced it.',
    });
  }

  if (input.coverage.unsupportedReason !== null) {
    interpretations.push({
      evidence: [],
      kind: 'coverage-gap',
      text: `The Desktop registry file has a shape this reader does not support: ${input.coverage.unsupportedReason}`,
      uncertainty: 'Only the session’s identity and dates are known; its declaration, if any, was not read.',
    });
  }
  if (input.coverage.sessionJoined === false) {
    interpretations.push({
      evidence: [],
      kind: 'coverage-gap',
      text: 'No collected Session matches this transcript id in the current report.',
      uncertainty:
        'The transcript may not have been collected yet, may have been purged, or may belong to another machine.',
    });
  }
  if (input.coverage.parentMissing) {
    interpretations.push({
      evidence: input.facts.filter((fact) => fact.kind === 'spawned-from').map((fact) => fact.id),
      kind: 'coverage-gap',
      text: 'Spawned from a session the registry does not contain; shown as a root for lack of its parent.',
      uncertainty: 'The parent may have been deleted or may live under another account; this root may be a child.',
    });
  }

  return { attention, interpretations: interpretations.slice(0, maxInterpretations), reconsidered };
};
