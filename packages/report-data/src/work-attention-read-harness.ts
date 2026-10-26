import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { CodexWorkRequest, StoredCodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  WORK_ATTENTION_BOUNDS,
  type WorkFact,
  type WorkInterpretation,
  type WorkRoot,
} from '@ai-usage/report-core/work-attention';
import { interpretExternalFacts } from '@ai-usage/report-core/work-attention-facts';
import type {
  QueryRecentServedHarnessSessionsResult,
  ServedHarnessSessionFamily,
  ServedHarnessSessionMember,
} from '@ai-usage/usage-store/reader';

/**
 * Work roots for a harness that declares no general turn status (ADR 0059). Codex records no
 * `postTurnSummary` equivalent, but may record a structured input request and an exact answer.
 * Its sessions are read from the served revision the report already
 * publishes, one root per served campaign (the lineage the report folds from declared parents),
 * and each root carries what the harness recorded natively (checkout, branch, last activity,
 * children), with local auxiliary request evidence. Without a pending recorded request, general
 * attention remains `not-observable`. Nothing folds it under a Claude Desktop root.
 */

/** The one harness read this way today. */
export const WORK_UNDECLARED_HARNESS = 'codex';

/** What one read of a harness's recent families returned, with the harness it was asked for. */
export interface WorkHarnessSessions extends QueryRecentServedHarnessSessionsResult {
  readonly harness: string;
  /** Auxiliary local evidence for exactly the served members selected by this bounded read. */
  readonly workObservations?: readonly StoredCodexWorkObservation[];
}

const { maxChildrenTitles, maxInterpretations, maxShortText } = WORK_ATTENTION_BOUNDS;
const ELLIPSIS = '…';

/** Served labels are free text; a Work root carries at most `maxShortText`, cut visibly. */
const clampText = (value: string): string =>
  value.length <= maxShortText ? value : `${value.slice(0, maxShortText - ELLIPSIS.length)}${ELLIPSIS}`;

const instantOf = (value: number | string | null): CanonicalInstant | null =>
  value === null ? null : normalizeIsoTimestamp(value);

const HARNESS_LABELS: Readonly<Record<string, string>> = { codex: 'Codex' };
const harnessLabel = (harness: string): string => HARNESS_LABELS[harness] ?? harness;

const rootOf = (family: ServedHarnessSessionFamily): ServedHarnessSessionMember => {
  const root = family.members[0];
  if (root === undefined || !root.campaignRoot) {
    // The store returns only families whose root it could read; anything else is a contract breach.
    throw new RangeError(`harness session family ${family.campaignKey} has no root member`);
  }
  return root;
};

/** The distinct checkouts the members read worked in, root first; members beyond the read are unknown. */
export const harnessFamilyCheckoutPaths = (family: ServedHarnessSessionFamily): string[] => [
  ...new Set(family.members.flatMap((member) => (member.checkoutPath === null ? [] : [member.checkoutPath]))),
];

const notDeclaredInterpretation = (harness: string): WorkInterpretation => ({
  evidence: [],
  kind: 'coverage-gap',
  text: `${harnessLabel(harness)} records no general turn status: waits beyond the structured requests shown here are unknown — not declared by this harness.`,
  uncertainty:
    'Only supported structured requests and exactly linked responses are read. Runtime approvals and requests outside the selected sessions may be absent. Unknown is not "nothing pending".',
});

const parentMissingInterpretation = (harness: string): WorkInterpretation => ({
  evidence: [],
  kind: 'coverage-gap',
  text: `Started from a ${harnessLabel(harness)} session that is not in the served report; it stands as its own root.`,
  uncertainty: 'The parent session was not collected; nothing links this session to another root.',
});

export interface HarnessSessionRootInput {
  /** Checkout observations attached by exact path (`harnessFamilyCheckoutPaths`), already as facts. */
  readonly checkoutFacts: readonly WorkFact[];
  readonly family: ServedHarnessSessionFamily;
  /** When the served revision was generated: the last time the report observed this session. */
  readonly generatedAt: string | null;
  readonly harness: string;
  readonly now: Date;
  /** How many roots of the dataset share each checkout path on the root's machine. */
  readonly rootsPerCheckout?: ReadonlyMap<string, number>;
  readonly workObservations?: readonly StoredCodexWorkObservation[];
}

const pendingQuestions = (request: CodexWorkRequest) =>
  request.rejectedAt === null ? request.questions.filter((question) => question.answeredAt === null) : [];

const requestFactId = (sourceSessionId: string, callId: string): string =>
  `codex-request:${createHash('sha256')
    .update(JSON.stringify([sourceSessionId, callId]))
    .digest('hex')}`;

const boundedInterpretationText = (value: string): string =>
  value.length <= WORK_ATTENTION_BOUNDS.maxDetailText
    ? value
    : `${value.slice(0, WORK_ATTENTION_BOUNDS.maxDetailText - 1)}${ELLIPSIS}`;

const nativeEvidence = (input: HarnessSessionRootInput) => {
  const memberIds = new Set(input.family.members.map((member) => member.sourceSessionId));
  const machineId = rootOf(input.family).machineId;
  const observations = (input.workObservations ?? []).filter(
    (observation) => observation.machineId === machineId && memberIds.has(observation.sourceSessionId),
  );
  const contexts: WorkFact[] = observations.map((observation) => ({
    kind: 'codex-session-context',
    id: `codex:${observation.sourceSessionId}:context`,
    sourceSessionId: observation.sourceSessionId,
    originator: observation.originator,
    executionSource: observation.source,
    threadSource: observation.threadSource,
    forkedFromId: observation.forkedFromId,
    provenance: {
      source: 'codex-rollout',
      machineId,
      observedAt: observation.observedAt,
      coverage: observation.omittedRequests > 0 || observation.rejectedRecords > 0 ? 'partial' : 'complete',
    },
  }));
  const requests = observations
    .flatMap((observation) => observation.requests.map((request) => ({ observation, request })))
    .sort(
      (left, right) =>
        Number(pendingQuestions(right.request).length > 0) - Number(pendingQuestions(left.request).length > 0) ||
        right.request.askedAt.localeCompare(left.request.askedAt),
    );
  const facts: WorkFact[] = requests.map(({ observation, request }) => ({
    kind: 'codex-user-request',
    id: requestFactId(observation.sourceSessionId, request.callId),
    sourceSessionId: observation.sourceSessionId,
    request,
    provenance: {
      source: 'codex-rollout',
      machineId,
      observedAt: observation.observedAt,
      coverage:
        observation.omittedRequests > 0 ||
        observation.rejectedRecords > 0 ||
        request.questions.some((question) => question.textTruncated)
          ? 'partial'
          : 'complete',
    },
  }));
  const retainedFacts = [...contexts, ...facts].slice(
    0,
    Math.max(0, WORK_ATTENTION_BOUNDS.maxFacts - input.checkoutFacts.length),
  );
  const ids = new Set(retainedFacts.map((fact) => fact.id));
  const interpretations: WorkInterpretation[] = [];
  for (const { observation, request } of requests) {
    const factId = requestFactId(observation.sourceSessionId, request.callId);
    if (!ids.has(factId)) {
      continue;
    }
    const pending = pendingQuestions(request);
    if (request.rejectedAt !== null) {
      interpretations.push({
        kind: 'coverage-gap',
        evidence: [factId],
        text: `Codex's input tool rejected this request at ${request.rejectedAt}.`,
        uncertainty:
          'A recorded invocation is not proof the question reached you; this rejected request is not counted as waiting.',
      });
    } else if (pending.length === 0) {
      const answeredAt = request.questions
        .map((question) => question.answeredAt ?? '')
        .sort()
        .at(-1);
      interpretations.push({
        kind: 'request-answered',
        evidence: [factId],
        text: `Codex recorded answers to this request's ${request.questions.length} question(s) at ${answeredAt}.`,
        uncertainty:
          'The native response matches the exact call id and question ids. It settles no other request and establishes no delivery or general authorization.',
      });
    } else {
      const question = pending[0];
      const partial = request.questions.length - pending.length;
      interpretations.push({
        kind: 'request-open',
        evidence: [factId],
        text: `Codex asks: ${question?.text ?? ''}${pending.length > 1 ? ` (${pending.length - 1} more question(s) in this request)` : ''}`,
        uncertainty: `${partial > 0 ? `${partial} question(s) have a linked answer; ` : ''}${request.acknowledgedAt === null ? 'Only the invocation is recorded; presentation is not confirmed. ' : `The tool acknowledged the request at ${request.acknowledgedAt}. `}No native response identifies an answer to the remaining question(s).`,
      });
      if (observation.latestUserMessageAt !== null && observation.latestUserMessageAt > request.askedAt) {
        interpretations.push({
          kind: 'request-message-observed',
          evidence: [factId],
          text: `A user message was observed in this Codex session at ${observation.latestUserMessageAt}.`,
          uncertainty:
            'Its date does not connect it to this request; a later message is not an answer, decision or authorization.',
        });
      }
    }
  }
  const omitted =
    observations.reduce((total, observation) => total + observation.omittedRequests, 0) +
    facts.length +
    contexts.length -
    retainedFacts.length;
  const rejected = observations.reduce((total, observation) => total + observation.rejectedRecords, 0);
  if (omitted > 0 || rejected > 0) {
    interpretations.unshift({
      kind: 'coverage-gap',
      evidence: [],
      text: `Codex request evidence is partial: ${omitted} omitted, ${rejected} malformed record(s).`,
      uncertainty:
        'Requests outside these parser and display bounds may still be open; an empty selection does not prove there is no pending work.',
    });
  }
  if (input.family.memberCount > input.family.members.length) {
    interpretations.push({
      kind: 'coverage-gap',
      evidence: [],
      text: `Codex request evidence covers ${input.family.members.length} of ${input.family.memberCount} campaign sessions.`,
      uncertainty: 'The remaining members were not read for requests; their attention is unknown.',
    });
  }
  return {
    facts: retainedFacts,
    interpretations: interpretations.map((interpretation) => ({
      ...interpretation,
      text: boundedInterpretationText(interpretation.text),
      uncertainty: boundedInterpretationText(interpretation.uncertainty),
    })),
    pending: requests.some(({ request }) => pendingQuestions(request).length > 0),
    reconsidered: requests.some(
      ({ observation, request }) =>
        pendingQuestions(request).length > 0 &&
        observation.latestUserMessageAt !== null &&
        observation.latestUserMessageAt > request.askedAt,
    ),
    lastObservedAt:
      observations
        .map((observation) => observation.observedAt)
        .sort()
        .at(-1) ?? null,
  };
};

/**
 * One root per family. A native input request may require attention; a dirty checkout alone
 * never becomes a human request, and a completed turn never establishes that requests were answered.
 */
export const harnessSessionRoot = (input: HarnessSessionRootInput): WorkRoot => {
  const { family, harness } = input;
  const root = rootOf(family);
  const children = family.members.filter((member) => member !== root);
  const native = nativeEvidence(input);
  const external = interpretExternalFacts({
    facts: input.checkoutFacts,
    now: input.now,
    ...(input.rootsPerCheckout === undefined ? {} : { rootsPerCheckout: input.rootsPerCheckout }),
  });
  const interpretations = [
    ...native.interpretations,
    notDeclaredInterpretation(harness),
    ...(root.parentSourceSessionId === null ? [] : [parentMissingInterpretation(harness)]),
    ...external,
  ].slice(0, maxInterpretations);
  return {
    age: {
      createdAt: instantOf(root.startedAt),
      declaredAt: null,
      lastActivityAt: instantOf(root.activeAt),
      lastObservedAt: native.lastObservedAt ?? instantOf(input.generatedAt),
    },
    archived: false,
    attention: native.pending ? 'human-request' : 'not-observable',
    children: {
      blocked: 0,
      completed: 0,
      count: Math.max(family.memberCount - 1, 0),
      reviewReady: 0,
      titles: children.slice(0, maxChildrenTitles).map((child) => clampText(child.title)),
    },
    declared: null,
    desktopSessionId: null,
    facts: [...native.facts, ...input.checkoutFacts],
    interpretations,
    key: { harness, machineId: root.machineId, sourceSessionId: root.sourceSessionId },
    project: {
      branch: root.branch === null ? null : clampText(root.branch),
      checkoutPath: root.checkoutPath,
      // The same rule as a Desktop root: the directory's name; the report's own label rides apart.
      label: clampText(root.checkoutPath === null ? root.projectLabel : path.basename(root.checkoutPath)),
      servedLabel: clampText(root.projectLabel),
      worktreeName: null,
    },
    reconsidered: native.reconsidered,
    session: { campaignKey: family.campaignKey, rowId: root.rowId },
    title: clampText(root.title),
    titleSource: 'unknown',
  };
};
