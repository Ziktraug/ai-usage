import type { CanonicalInstant } from './canonical-instant';
import { normalizeIsoTimestamp } from './provider-status';
import {
  type ClaudeDesktopTurnStatus,
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
 * What may change a request (ADR 0056), from the strongest to the weakest:
 *
 * - **A dated, explicit native record closes it.** The person wrote to the session in Claude
 *   Desktop after the question (`latestUserFrameAt`), archived the session there, or a session
 *   started from this one after the question declared itself completed. The product does not
 *   decide; it reads the harness's own record and names its date.
 * - **An unproven link makes it an older declaration to reconsider.** A later pull request (the
 *   narrow rule below), work continued in a session started from this one, or a report a session
 *   sent to it after the question: the attention stays `human-request`, the root is marked
 *   `reconsidered`, and the question stays the person's.
 * - **Everything else leaves it a current confirmed block**, however much else happened in the
 *   family: an unrelated pull request, a child that finished work it was given before the question.
 *
 * A message answers the request it followed and nothing else: it never settles a child's question
 * or another root, and it authorizes nothing. It ends an earlier proposal only as an offer the
 * person went past (`proposal-superseded`), never as a decision about it.
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

/** A declaration of the root that a later turn replaced, with the fact that carries it. */
export interface WorkEarlierDeclaration {
  readonly declaredAt: CanonicalInstant;
  readonly factId: string;
  readonly needsAction: string | null;
  /** A message the person wrote to the session after it and no later than its replacement. */
  readonly repliedAt: CanonicalInstant | null;
  readonly status: ClaudeDesktopTurnStatus;
  /** The replacing declaration's date. */
  readonly supersededAt: CanonicalInstant;
}

/**
 * A session the harness links to the root: started from it (`spawnedFrom`, dated by its own
 * creation) or reporting to it (a side-session note in the root's file, dated by the note).
 */
export interface WorkLinkedSession {
  /** Its current declaration and the fact that carries it, when the read has one. */
  readonly declaration: {
    readonly at: CanonicalInstant;
    readonly factId: string;
    readonly status: ClaudeDesktopTurnStatus;
  } | null;
  readonly desktopSessionId: string;
  readonly link: 'spawned-from' | 'side-session-note';
  readonly linkedAt: CanonicalInstant;
  /** The fact that attests the link, when one carries it (the side-session note). */
  readonly linkFactId: string | null;
  readonly title: string;
}

/** An open proposal with the dates Claude Desktop recorded for it. */
export interface WorkOpenProposal {
  readonly createdAt: CanonicalInstant | null;
  readonly expiresAt: CanonicalInstant | null;
  readonly factId: string;
  readonly title: string;
}

/** What the harness recorded around the root's declaration, beyond the declaration itself. */
export interface WorkRootHarnessInput {
  /** `isArchived`: the person archived the session in Claude Desktop. */
  readonly archived: boolean;
  /** Oldest first. */
  readonly earlierDeclarations: readonly WorkEarlierDeclaration[];
  /** `latestUserFrameAt` of the root. */
  readonly latestUserFrameAt: CanonicalInstant | null;
  readonly linkedSessions: readonly WorkLinkedSession[];
  readonly openProposals: readonly WorkOpenProposal[];
}

export const NO_HARNESS_CONTEXT: WorkRootHarnessInput = {
  archived: false,
  earlierDeclarations: [],
  latestUserFrameAt: null,
  linkedSessions: [],
  openProposals: [],
};

export interface InterpretWorkRootInput {
  readonly coverage: WorkRootCoverageInput;
  readonly declaration: WorkRootDeclaration | null;
  readonly facts: readonly WorkFact[];
  /** Defaults to `NO_HARNESS_CONTEXT`: nothing recorded beyond the declaration and the facts. */
  readonly harness?: WorkRootHarnessInput;
  readonly now: CanonicalInstant | Date | string;
  /** Age past which a declaration is reported as stale; defaults to seven days. */
  readonly staleAfterMs?: number;
}

export interface WorkRootInterpretationResult {
  readonly attention: WorkAttentionKind;
  readonly interpretations: readonly WorkInterpretation[];
  /** An older declaration to reconsider: something later may have answered it; `attention` is unchanged by it. */
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
/** Earlier declarations read per root; older ones stay in the store but are not restated. */
const MAX_EARLIER_REQUESTS = 3;
const WHITESPACE = /\s+/gu;

const instantOf = (value: CanonicalInstant | Date | string): CanonicalInstant | null =>
  value instanceof Date ? normalizeIsoTimestamp(value.getTime()) : normalizeIsoTimestamp(value);

const isQuestion = (status: ClaudeDesktopTurnStatus, needsAction: string | null): needsAction is string =>
  status === 'blocked' && needsAction !== null && needsAction.trim().length > 0;

/** The question a blocked declaration asks, or `null` when it asks nothing the product can relay. */
const requestedAction = (declaration: WorkRootDeclaration | null): string | null =>
  declaration !== null && isQuestion(declaration.status, declaration.needsAction) ? declaration.needsAction : null;

/** Whether a declaration asks something of the person: a question, or a review request. */
const isRequest = (status: ClaudeDesktopTurnStatus, needsAction: string | null): boolean =>
  isQuestion(status, needsAction) || status === 'review_ready';

const sameQuestion = (left: string | null, right: string | null): boolean =>
  left !== null &&
  right !== null &&
  left.trim().replace(WHITESPACE, ' ').toLowerCase() === right.trim().replace(WHITESPACE, ' ').toLowerCase();

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

const ANSWER_UNCERTAINTY =
  'Read from Claude Desktop’s own record; the message itself is not read. It answers this request only: no proposal, other question or authorization follows from it.';

/** What the person's request is called in a sentence. */
const requestLabel = (status: ClaudeDesktopTurnStatus, needsAction: string | null): string =>
  isQuestion(status, needsAction) ? `the question “${needsAction}”` : 'the review request';

const linkPhrase = (session: WorkLinkedSession): string =>
  session.link === 'spawned-from'
    ? `started from this session at ${session.linkedAt}`
    : `reported to this session at ${session.linkedAt}`;

/** The linked session that finished after the request: started or reporting after it, then completed. */
const handledBy = (sessions: readonly WorkLinkedSession[], askedAt: CanonicalInstant): WorkLinkedSession | null =>
  sessions
    .filter(
      (session) =>
        session.linkedAt > askedAt &&
        session.declaration !== null &&
        session.declaration.status === 'completed' &&
        session.declaration.at >= askedAt,
    )
    .sort((left, right) => ((left.declaration?.at ?? '') < (right.declaration?.at ?? '') ? 1 : -1))[0] ?? null;

/** Linked sessions that took up work after the request without a declaration that it was done. */
const continuedIn = (sessions: readonly WorkLinkedSession[], askedAt: CanonicalInstant): WorkLinkedSession[] =>
  sessions.filter((session) => session.linkedAt > askedAt);

/** The facts a linked session contributes: what attests the link, then its declaration. */
const linkEvidence = (session: WorkLinkedSession): string[] => [
  ...(session.linkFactId === null ? [] : [session.linkFactId]),
  ...(session.declaration === null ? [] : [session.declaration.factId]),
];

const continuedElsewhere = (sessions: readonly WorkLinkedSession[]): WorkInterpretation => {
  const parts = sessions.slice(0, MAX_LISTED_PULL_REQUESTS).map((session) => {
    const state =
      session.declaration === null
        ? 'no declaration read'
        : `declared ${session.declaration.status.replace('_', ' ')} at ${session.declaration.at}`;
    return `“${session.title}” (${linkPhrase(session)}; ${state})`;
  });
  const more = sessions.length - parts.length;
  return {
    evidence: sessions.flatMap(linkEvidence),
    kind: 'request-continued-elsewhere',
    text: `Older declaration to reconsider: work continued after the question in ${parts.join('; ')}${more > 0 ? ` and ${more} more` : ''}.`,
    uncertainty:
      'The link to that session is attested, but nothing says it settles this request; the question stays yours.',
  };
};

interface ProposalStanding {
  readonly expired: WorkOpenProposal[];
  /** Proposal fact ids still offered. */
  readonly pending: string[];
  readonly superseded: WorkOpenProposal[];
}

/**
 * An open proposal stops being presented as pending when Claude Desktop's own expiry passed, or
 * when the person wrote to the session after it was offered: they went on with the session
 * instead, and the offer of the turn that followed is the current one. A proposal without a
 * creation date or a recorded message stays pending.
 */
const proposalStanding = (
  facts: readonly WorkFact[],
  proposals: readonly WorkOpenProposal[],
  latestUserFrameAt: CanonicalInstant | null,
  now: CanonicalInstant,
): ProposalStanding => {
  const byFact = new Map(proposals.map((proposal) => [proposal.factId, proposal]));
  const standing: ProposalStanding = { expired: [], pending: [], superseded: [] };
  for (const fact of facts) {
    if (fact.kind !== 'proposal' || fact.resolution !== 'open') {
      continue;
    }
    const proposal = byFact.get(fact.id);
    if (proposal?.expiresAt !== null && proposal?.expiresAt !== undefined && proposal.expiresAt <= now) {
      standing.expired.push(proposal);
    } else if (
      proposal?.createdAt !== null &&
      proposal?.createdAt !== undefined &&
      latestUserFrameAt !== null &&
      latestUserFrameAt > proposal.createdAt
    ) {
      standing.superseded.push(proposal);
    } else {
      standing.pending.push(fact.id);
    }
  }
  return standing;
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : `${count} ${many}`);

const proposalInterpretations = (
  standing: ProposalStanding,
  latestUserFrameAt: CanonicalInstant | null,
): WorkInterpretation[] => {
  const interpretations: WorkInterpretation[] = [];
  if (standing.pending.length > 0) {
    interpretations.push({
      evidence: standing.pending,
      kind: 'proposal-open',
      text: `${standing.pending.length === 1 ? 'One proposal is' : `${standing.pending.length} proposals are`} open and unanswered.`,
      uncertainty: 'Proposals are the session’s suggestions, not tasks; nothing says they are still wanted.',
    });
  }
  if (standing.superseded.length > 0) {
    interpretations.push({
      evidence: standing.superseded.map((proposal) => proposal.factId),
      kind: 'proposal-superseded',
      text: `${plural(standing.superseded.length, 'One proposal', 'proposals')} offered before your later message (${latestUserFrameAt ?? 'undated'}) ${standing.superseded.length === 1 ? 'is' : 'are'} no longer presented as pending: ${standing.superseded.map((proposal) => `“${proposal.title}”`).join(', ')}.`,
      uncertainty:
        'You went on with the session after the offer; whether the work it suggested was done is not read, and it was neither started nor dismissed in Claude Desktop.',
    });
  }
  if (standing.expired.length > 0) {
    const latest = standing.expired
      .map((proposal) => proposal.expiresAt ?? '')
      .reduce((left, right) => (right > left ? right : left), '');
    interpretations.push({
      evidence: standing.expired.map((proposal) => proposal.factId),
      kind: 'proposal-expired',
      text: `${plural(standing.expired.length, 'One proposal', 'proposals')} expired in Claude Desktop (latest at ${latest}): ${standing.expired.map((proposal) => `“${proposal.title}”`).join(', ')}.`,
      uncertainty: 'The expiry is Claude Desktop’s own; an expired offer can no longer be started from it.',
    });
  }
  return interpretations;
};

/** Interpretations of the declarations a later turn replaced, most recent first. */
const earlierRequestInterpretations = (
  earlier: readonly WorkEarlierDeclaration[],
  current: WorkRootDeclaration | null,
  currentEvidence: readonly string[],
): WorkInterpretation[] =>
  earlier
    .filter((declaration) => isRequest(declaration.status, declaration.needsAction))
    .filter(
      (declaration) =>
        // A question asked again after the reply is the current one: it is restated there, not here.
        !(
          current !== null &&
          declaration.repliedAt !== null &&
          sameQuestion(declaration.needsAction, requestedAction(current))
        ),
    )
    .slice(-MAX_EARLIER_REQUESTS)
    .reverse()
    .map((declaration): WorkInterpretation => {
      const label = requestLabel(declaration.status, declaration.needsAction);
      if (declaration.repliedAt !== null) {
        return {
          evidence: [declaration.factId, ...currentEvidence],
          kind: 'earlier-request-answered',
          text: `Answered in Claude Desktop: ${label} (asked ${declaration.declaredAt}); you wrote to the session at ${declaration.repliedAt} and it declared again at ${declaration.supersededAt}.`,
          uncertainty: ANSWER_UNCERTAINTY,
        };
      }
      return {
        evidence: [declaration.factId, ...currentEvidence],
        kind: 'earlier-request-superseded',
        text: `No longer asked: ${label} (asked ${declaration.declaredAt}) was replaced by the session’s declaration at ${declaration.supersededAt}.`,
        uncertainty:
          'No message from you was recorded in between: the session went on by itself (a side session woke it, for instance) or a sweep missed the message.',
      };
    });

interface RequestResult {
  readonly attention: WorkAttentionKind;
  readonly interpretations: WorkInterpretation[];
  readonly reconsidered: boolean;
}

/** The root's current request against what followed it: closed by a native record, to reconsider, or open. */
const interpretCurrentRequest = (
  declaration: WorkRootDeclaration,
  facts: readonly WorkFact[],
  harness: WorkRootHarnessInput,
  evidence: readonly string[],
): RequestResult => {
  const askedAt = declaration.at;
  const label = requestLabel(declaration.status, declaration.needsAction);
  const reply =
    harness.latestUserFrameAt !== null && harness.latestUserFrameAt > askedAt ? harness.latestUserFrameAt : null;
  if (harness.archived) {
    return {
      attention: 'none',
      interpretations: [
        {
          evidence: [...evidence],
          kind: 'request-archived',
          text: `Archived in Claude Desktop: the session was archived with ${label} (asked ${askedAt}) as its last declaration.`,
          uncertainty:
            'Archiving is your own action in the harness; this view no longer presents the request as waiting.',
        },
      ],
      reconsidered: false,
    };
  }
  if (reply !== null) {
    return {
      attention: 'none',
      interpretations: [
        {
          evidence: [...evidence],
          kind: 'request-answered',
          text: `Answered in Claude Desktop: you wrote to the session at ${reply}, after ${label} (asked ${askedAt}); it has not declared since.`,
          uncertainty: ANSWER_UNCERTAINTY,
        },
      ],
      reconsidered: false,
    };
  }
  const handled = handledBy(harness.linkedSessions, askedAt);
  if (handled?.declaration) {
    return {
      attention: 'none',
      interpretations: [
        {
          evidence: [...evidence, ...linkEvidence(handled)],
          kind: 'request-handled-elsewhere',
          text: `Handled in “${handled.title}”: ${linkPhrase(handled)}, after ${label} (asked ${askedAt}), and declared completed at ${handled.declaration.at}.`,
          uncertainty:
            'Claude Desktop attests the link and the completion; what that session did is its own declaration, not read further.',
        },
      ],
      reconsidered: false,
    };
  }
  const needsAction = requestedAction(declaration);
  const asksPullRequest = needsAction !== null && asksForPullRequest(needsAction);
  const declared = asksPullRequest ? childDeclaredPullRequests(facts, askedAt) : [];
  const observed = asksPullRequest ? answeringObservedPullRequests(facts, askedAt, declared) : [];
  const continued = continuedIn(harness.linkedSessions, askedAt);
  const pullRequestLater = declared.length + observed.length > 0;
  const reconsidered = pullRequestLater || continued.length > 0;
  const reconsideredBecause = pullRequestLater
    ? 'a later pull request may be the answer, but nothing confirms it.'
    : 'work continued in a linked session after it, but nothing confirms it settled the question.';
  const repeated = harness.earlierDeclarations.findLast(
    (earlier) => earlier.repliedAt !== null && sameQuestion(earlier.needsAction, needsAction),
  );
  const asked = repeated
    ? ` It was asked before (${repeated.declaredAt}), you wrote to the session at ${repeated.repliedAt}, and it asked again.`
    : '';
  const interpretations: WorkInterpretation[] = [
    needsAction === null
      ? {
          evidence: [...evidence],
          kind: 'review-ready',
          text: 'The session declared its change ready for a review.',
          uncertainty: reconsidered
            ? 'Declared by the session; something later may be the outcome, but nothing confirms it.'
            : 'Declared by the session; no review outcome has been observed.',
        }
      : {
          evidence: [...evidence],
          kind: 'request-open',
          text: `The session stopped on a question: ${needsAction}`,
          uncertainty: reconsidered
            ? `This is the session’s own last declaration; ${reconsideredBecause}${asked}`
            : `This is the session’s own last declaration; nothing observed since says it was answered.${asked}`,
        },
  ];
  if (pullRequestLater) {
    interpretations.push(possiblyAnsweredElsewhere(declared, observed));
  }
  if (continued.length > 0) {
    interpretations.push(continuedElsewhere(continued));
  }
  return { attention: 'human-request', interpretations, reconsidered };
};

export const interpretWorkRoot = (input: InterpretWorkRootInput): WorkRootInterpretationResult => {
  const now = instantOf(input.now);
  if (now === null) {
    throw new RangeError('interpretWorkRoot requires a valid `now` instant');
  }
  const staleAfterMs = input.staleAfterMs ?? WORK_ATTENTION_STALE_AFTER_MS;
  if (!(Number.isSafeInteger(staleAfterMs) && staleAfterMs > 0)) {
    throw new RangeError('interpretWorkRoot requires a positive `staleAfterMs`');
  }
  const harness = input.harness ?? NO_HARNESS_CONTEXT;
  const interpretations: WorkInterpretation[] = [];
  let attention: WorkAttentionKind = 'none';
  let reconsidered = false;
  const { declaration } = input;
  const declaredTurnEvidence = input.facts
    .filter((fact) => fact.kind === 'declared-turn' && fact.declaredAt === declaration?.at)
    .map((fact) => fact.id);

  if (declaration !== null && isRequest(declaration.status, declaration.needsAction)) {
    const request = interpretCurrentRequest(declaration, input.facts, harness, declaredTurnEvidence);
    attention = request.attention;
    reconsidered = request.reconsidered;
    interpretations.push(...request.interpretations);
  }
  interpretations.push(
    ...earlierRequestInterpretations(harness.earlierDeclarations, declaration, declaredTurnEvidence),
  );

  const proposals = proposalStanding(input.facts, harness.openProposals, harness.latestUserFrameAt, now);
  if (proposals.pending.length > 0 && attention === 'none') {
    attention = 'optional-lead';
  }
  interpretations.push(...proposalInterpretations(proposals, harness.latestUserFrameAt));
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
