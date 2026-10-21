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
 * `facts` already carries the shapes the next producers emit (`pull-request`, `checkout-status`),
 * so adding an observed pull request later means adding a rule, not a parameter.
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
}

/**
 * The explicit vocabulary that lets a declared pull request answer a request. Deliberately
 * narrow: a `needs_action` that says "yes?" or "which option?" never matches, so a later pull
 * request cannot silently close a question it did not answer.
 */
const PULL_REQUEST_VOCABULARY =
  /\b(?:prs?|pull[ -]requests?|push(?:ed|es|ing)?|commit(?:s|ted|ting)?|merg(?:e|ed|es|ing))\b/iu;

const SATISFYING_PULL_REQUEST_STATES = new Set(['OPEN', 'MERGED']);

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

/** Declared pull requests of the same session family, dated at or after the declaration. */
const satisfyingDeclaredPullRequests = (facts: readonly WorkFact[], declaredAt: CanonicalInstant): WorkFact[] =>
  facts.filter(
    (fact) =>
      fact.kind === 'declared-pull-request' &&
      SATISFYING_PULL_REQUEST_STATES.has(fact.state.toUpperCase()) &&
      fact.provenance.observedAt >= declaredAt,
  );

const pullRequestLabel = (fact: Extract<WorkFact, { kind: 'declared-pull-request' }>): string =>
  `${fact.repository}#${fact.number} (${fact.state})`;

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
  const { declaration } = input;

  const needsAction = requestedAction(declaration);
  if (declaration !== null && needsAction !== null) {
    const satisfying = asksForPullRequest(needsAction)
      ? satisfyingDeclaredPullRequests(input.facts, declaration.at)
      : [];
    if (satisfying.length > 0) {
      // The text names a few pull requests; the evidence carries them all.
      const labels = satisfying
        .slice(0, MAX_LISTED_PULL_REQUESTS)
        .map((fact) => (fact.kind === 'declared-pull-request' ? pullRequestLabel(fact) : fact.id));
      const more = satisfying.length - labels.length;
      interpretations.push({
        evidence: satisfying.map((fact) => fact.id),
        kind: 'request-satisfied-elsewhere',
        text: `Asked to act on a pull request; the same family of sessions later declared ${labels.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
        uncertainty:
          'The link rests on a pull request declared by the same family of sessions, not on proof that it is the same work.',
      });
    } else {
      attention = 'human-request';
      interpretations.push({
        evidence: input.facts.filter((fact) => fact.kind === 'declared-turn').map((fact) => fact.id),
        kind: 'request-open',
        text: `The session stopped on a question: ${needsAction}`,
        uncertainty: 'This is the session’s own last declaration; nothing observed since says it was answered.',
      });
    }
  } else if (declaration !== null && declaration.status === 'review_ready') {
    attention = 'human-request';
    interpretations.push({
      evidence: input.facts.filter((fact) => fact.kind === 'declared-turn').map((fact) => fact.id),
      kind: 'review-ready',
      text: 'The session declared its change ready for a review.',
      uncertainty: 'Declared by the session; no review outcome has been observed.',
    });
  }

  // An observed pull request waiting on someone else. Provisional until the GitHub producer
  // lands: the rule reads the shape the contract already defines and nothing more.
  const pendingReviews = input.facts.filter(
    (fact) =>
      fact.kind === 'pull-request' &&
      fact.outcome === 'observed' &&
      fact.state === 'OPEN' &&
      fact.draft !== true &&
      (fact.reviewDecision === null || fact.checksRollup === 'pending'),
  );
  if (pendingReviews.length > 0) {
    if (attention === 'none') {
      attention = 'external-wait';
    }
    interpretations.push({
      evidence: pendingReviews.map((fact) => fact.id),
      kind: 'external-review-pending',
      text: `${pendingReviews.length === 1 ? 'An open pull request is' : `${pendingReviews.length} open pull requests are`} waiting on a review or on checks.`,
      uncertainty: 'States what GitHub showed at the observation time; a review since then is not yet observed.',
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
      evidence: input.facts.filter((fact) => fact.kind === 'declared-turn').map((fact) => fact.id),
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

  return { attention, interpretations: interpretations.slice(0, maxInterpretations) };
};
