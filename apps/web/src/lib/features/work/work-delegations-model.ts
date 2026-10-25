import {
  DELEGATION_ENDED_STATES,
  type DelegationAcceptanceVerdict,
  type DelegationEvaluationAuthor,
  type DelegationJobState,
} from '@ai-usage/report-core/delegation-vocabulary';
import type {
  DelegationCancelOutput,
  DelegationEvaluationViewWire,
  DelegationJobViewWire,
  DelegationRecordAcceptanceOutput,
  DelegationSelectionWire,
} from '@ai-usage/web-contract/delegation';
import type { DelegationClientResult } from '../../rpc/delegation-client';

/**
 * The words of the Work view's Delegations panel. Everything here names a fact the store holds or
 * an answer the engine gave; nothing judges. Execution, verification and acceptance stay three
 * sentences, and a selector's rationale is always labelled as its statement.
 */
export const DEMO_DELEGATION_TEXT = 'Delegation is not available in the demo.';
export const EMPTY_DELEGATION_TEXT =
  'No delegation yet. A delegation is started by an MCP client or the CLI (docs/delegation.md).';
/** Jobs the Work panel lists; the newest first, bounded by the contract. */
export const WORK_DELEGATIONS_LIMIT = 20;
export const SELECTOR_STATEMENT_LABEL = 'stated by the selector, not measured';
export const USAGE_SOURCE_LABEL = 'as reported by the harness';
export const CANCEL_DELEGATION_LABEL = 'Cancel delegation';

export const ACCEPTANCE_ACTIONS: readonly { readonly label: string; readonly verdict: DelegationAcceptanceVerdict }[] =
  [
    { label: 'Accept', verdict: 'accepted' },
    { label: 'Reject', verdict: 'rejected' },
    { label: 'Taken over', verdict: 'taken-over' },
  ];

const STATE_LABELS: Readonly<Record<DelegationJobState, string>> = {
  abstained: 'abstained (kept with the caller)',
  cancelled: 'cancelled',
  failed: 'failed',
  finished: 'finished',
  lost: 'contact lost; verify in the harness',
  refused: 'refused',
  requested: 'requested',
  running: 'running',
  starting: 'starting',
};

export const delegationStateLabel = (state: DelegationJobState): string => STATE_LABELS[state];

export const isEndedDelegationState = (state: DelegationJobState): boolean =>
  (DELEGATION_ENDED_STATES as readonly DelegationJobState[]).includes(state);

export const delegationHarnessLabel = (harness: 'claude-code' | 'codex' | null): string => {
  if (harness === 'claude-code') {
    return 'Claude Code';
  }
  return harness === 'codex' ? 'Codex' : 'unknown harness';
};

export const shortJobId = (jobId: string): string => jobId.slice(0, 8);

/** The route the job ran on, with the requested model and the resolved one ("resolved: unknown" when the harness said nothing). */
export const routeLine = (route: DelegationJobViewWire['route']): string => {
  if (route === null) {
    return 'No route: nothing was launched.';
  }
  const context = route.context === null ? '' : ` (${route.context})`;
  const effort = route.effort === null ? '' : ` · effort ${route.effort}`;
  return `${delegationHarnessLabel(route.harness)} · ${route.accountScope ?? 'unknown account'}${context} · model requested ${route.modelRequested ?? 'none'}, resolved: ${route.modelResolved}${effort}.`;
};

export const scopeLine = (scope: DelegationJobViewWire['request']['scope']): string =>
  scope.kind === 'commit' ? `commit ${scope.commit}` : `range ${scope.base}..${scope.head}`;

const EXECUTED_LABELS: Readonly<Record<DelegationJobViewWire['status']['executed'], string>> = {
  cancelled: 'cancelled',
  failed: 'failed',
  'not-run': 'not run',
  running: 'running',
  succeeded: 'succeeded',
  unknown: 'unknown (contact lost)',
};

export const executedLabel = (executed: DelegationJobViewWire['status']['executed']): string =>
  EXECUTED_LABELS[executed];

export const verifiedLabel = (verified: DelegationJobViewWire['status']['verified']): string =>
  verified === 'not-verified' ? 'not verified' : verified;

export const acceptedLabel = (accepted: DelegationJobViewWire['status']['accepted']): string =>
  accepted === 'pending' ? 'pending — not recorded by you' : accepted;

/** A refusal is a decision; a failure is what happened to a launched job. One sentence either way. */
export const refusalOrFailureText = (job: Pick<DelegationJobViewWire, 'failure' | 'refusal'>): string | null => {
  if (job.refusal !== null) {
    return `Refused (${job.refusal.reason}): ${job.refusal.message}`;
  }
  return job.failure === null ? null : `Failure: ${job.failure}`;
};

const tokens = (count: number | null): string => (count === null ? 'not reported' : count.toLocaleString('en'));

export const usageLine = (usage: DelegationJobViewWire['usage']): string =>
  usage === null
    ? 'No usage reported by the harness.'
    : `Usage ${USAGE_SOURCE_LABEL}: input ${tokens(usage.inputTokens)} · cached input ${tokens(usage.cachedInputTokens)} · output ${tokens(usage.outputTokens)} tokens.`;

/** The selector's choice or abstention, as its statement. */
export const selectionText = (selection: DelegationSelectionWire | null): string => {
  if (selection === null) {
    return 'No selection recorded.';
  }
  if (selection.kind === 'abstain') {
    return `Abstained (${selection.reason})${selection.note === undefined ? '' : `: ${selection.note}`}; selector ${selection.selectorVersion}.`;
  }
  const rationale =
    selection.rationale === undefined || selection.rationale.length === 0
      ? ''
      : `; rationale: ${selection.rationale.join('; ')}`;
  const confidence = selection.confidence === undefined ? '' : `; confidence ${selection.confidence} (self-reported)`;
  return `Choice: route ${selection.routeId} (${SELECTOR_STATEMENT_LABEL})${rationale}${confidence}; selector ${selection.selectorVersion}.`;
};

export const coverageText = (coverage: NonNullable<DelegationJobViewWire['result']>['coverage']): string => {
  if (coverage === null) {
    return 'Coverage: not stated.';
  }
  const notReviewed = coverage.notReviewed.length === 0 ? 'nothing declared' : coverage.notReviewed.join('; ');
  return `Reviewed: ${coverage.reviewed} Not reviewed: ${notReviewed}.`;
};

export const evidenceText = (evidence: readonly { readonly line: number | null; readonly path: string }[]): string =>
  evidence.length === 0
    ? 'no evidence path'
    : evidence.map((entry) => (entry.line === null ? entry.path : `${entry.path}:${entry.line}`)).join(', ');

export const truncationText = (truncation: DelegationJobViewWire['truncation']): string | null =>
  truncation.findings + truncation.evidence + truncation.notReviewed + truncation.evaluations === 0
    ? null
    : `Cut for this view: ${truncation.findings} finding(s), ${truncation.evidence} evidence entr(y/ies), ${truncation.notReviewed} not-reviewed entr(y/ies) and ${truncation.evaluations} evaluation(s) omitted; the store keeps the whole result and every evaluation.`;

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round((bytes / 1024) * 10) / 10} KB`;

export const executedScopeText = (scope: NonNullable<DelegationJobViewWire['executedScope']>): string =>
  `Scope given to the worker: ${scope.fileCount} file(s), patch ${formatBytes(scope.patchBytes)} (${formatBytes(scope.includedBytes)} given${scope.truncated ? ', truncated' : ''})${scope.workingTreeDirty ? '; the working tree had uncommitted changes' : ''}; sha256 ${scope.patchSha256.slice(0, 12)}.`;

export const guaranteeText = (guarantee: NonNullable<DelegationJobViewWire['guarantee']>): string =>
  `Ran under ${delegationHarnessLabel(guarantee.harness)} ${guarantee.cliVersion}, model ${guarantee.model ?? 'not passed (CLI default)'}${guarantee.effort === null ? '' : `, effort ${guarantee.effort}`}. Controls: ${guarantee.controls.join('; ')}. Limits: ${guarantee.limits.length === 0 ? 'none stated' : guarantee.limits.join('; ')}.`;

const AUTHOR_LABELS: Readonly<Record<DelegationEvaluationAuthor, string>> = {
  'automated-check': 'an automated check',
  'calling-model': 'the calling model',
  operator: 'the operator',
};

export const evaluationAuthorLabel = (
  evaluation: Pick<DelegationEvaluationViewWire, 'author' | 'authorLabel'>,
): string =>
  `${AUTHOR_LABELS[evaluation.author]}${evaluation.authorLabel === null ? '' : ` (${evaluation.authorLabel})`}`;

export const evaluationLine = (evaluation: DelegationEvaluationViewWire, when: string): string =>
  `${evaluation.verdict} — by ${evaluationAuthorLabel(evaluation)}, ${when}${evaluation.checks.length === 0 ? '' : `; checks: ${evaluation.checks.join('; ')}`}${evaluation.note === null || evaluation.note.length === 0 ? '' : `; note: ${evaluation.note}`}.`;

export interface DelegationActionOutcome {
  readonly failed: boolean;
  readonly message: string;
}

const CANCEL_TEXTS: Readonly<Record<DelegationCancelOutput['result'], string>> = {
  'already-ended': 'Nothing to cancel: the job had already ended.',
  cancelling: 'Cancellation requested: the engine terminates the worker and records the end.',
  'not-cancellable-lost':
    'Not cancellable: contact with this job is lost, so nothing is signalled; verify in the harness.',
  'not-found': 'Nothing to cancel: no job has this id.',
};

export const cancelOutcome = (result: DelegationClientResult<DelegationCancelOutput>): DelegationActionOutcome =>
  result.ok
    ? { failed: false, message: CANCEL_TEXTS[result.data.result] }
    : { failed: true, message: `Not cancelled: ${result.error.message}` };

export const acceptanceOutcome = (
  result: DelegationClientResult<DelegationRecordAcceptanceOutput>,
  verdict: DelegationAcceptanceVerdict,
): DelegationActionOutcome =>
  result.ok
    ? { failed: false, message: `Recorded as ${verdict} by you (evaluation ${shortJobId(result.data.evaluationId)}).` }
    : { failed: true, message: `Not recorded: ${result.error.message}` };
