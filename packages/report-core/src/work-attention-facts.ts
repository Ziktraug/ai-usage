import path from 'node:path';
import { canonicalInstantEpochMs } from './canonical-instant';
import {
  type CheckoutStatusObservation,
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
    coverage: observation.outcome === 'observed' ? 'complete' : 'partial',
    machineId: observation.machineId,
    observedAt: observation.observedAt,
    source: 'local-checkout',
  },
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
  if (fact.outcome !== 'observed') {
    return interpretation(
      'coverage-gap',
      [fact.id],
      `Checkout ${label} could not be read at ${observedAt} (${fact.outcome}).`,
      'Local changes, if any, are unknown from this observation.',
    );
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
    `${String(fact.modifiedCount ?? 0)} modified, ${String(fact.untrackedCount ?? 0)} untracked observed at ${observedAt} on ${fact.branch ?? 'a detached HEAD'} in ${label}; since when is unknown; validation and delivery unobserved.${shared}`,
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
