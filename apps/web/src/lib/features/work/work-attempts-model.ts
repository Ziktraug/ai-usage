import {
  isLiveReviewAttemptState,
  type ReviewAttemptState,
  type ReviewCheckoutOrigin,
  type ReviewReservationReleaseEvidence,
  SUPPORTED_REVIEW_EXECUTOR,
} from '@ai-usage/report-core/work-attempts';
import type { ReviewCandidate, ReviewRecommendation } from '@ai-usage/report-core/work-routing';
import type {
  WorkAttemptGuaranteeWire,
  WorkAttemptScopeWire,
  WorkAttemptsListOutput,
  WorkAttemptWire,
} from '@ai-usage/web-contract/work-attempts';

/**
 * What the Work view says beside the launch button, and why the button is absent. The browser
 * never decides: the engine re-checks the declaration, the target and the recommendation at launch
 * and refuses with its own typed reason. This only names, before the click, the fix that would
 * otherwise come back as a refusal.
 */
export const DEMO_EXECUTION_TEXT = 'Execution is not available in the demo.';
export const START_REVIEW_LABEL = 'Start read-only review (Claude Code)';

export interface LaunchGateInput {
  readonly attempts: WorkAttemptsListOutput | null;
  readonly attemptsPending: boolean;
  readonly chosen: ReviewCandidate | undefined;
  readonly recommendation: ReviewRecommendation | null;
  readonly reviewTargetsDeclared: number;
}

export type LaunchGate =
  | { readonly kind: 'open'; readonly checkoutPath: string }
  | { readonly kind: 'closed'; readonly reason: string };

export const liveAttemptOf = (attempts: WorkAttemptsListOutput | null): WorkAttemptWire | null =>
  attempts?.ok ? (attempts.data.attempts.find((attempt) => isLiveReviewAttemptState(attempt.state)) ?? null) : null;

/** Ordered like the engine's refusals, so the text here is the refusal the engine would answer. */
export const launchGate = (input: LaunchGateInput): LaunchGate => {
  const { chosen, recommendation } = input;
  if (!(chosen && recommendation) || recommendation.kind !== 'real' || recommendation.candidateId !== chosen.id) {
    return {
      kind: 'closed',
      reason:
        recommendation?.kind === 'conditional'
          ? 'the recommendation is conditional; a conditional simulation never permits a launch.'
          : 'launch requires a real recommendation, and none selects a candidate.',
    };
  }
  if (chosen.harness !== SUPPORTED_REVIEW_EXECUTOR) {
    return {
      kind: 'closed',
      reason: 'only Claude Code launches a review in this version; Codex is simulated, not executed.',
    };
  }
  const live = liveAttemptOf(input.attempts);
  if (live) {
    return { kind: 'closed', reason: `a review is already running (attempt ${live.attemptId}); wait for it to end.` };
  }
  if (input.attemptsPending || input.attempts === null) {
    return { kind: 'closed', reason: 'the target checkout and existing attempts are still being read.' };
  }
  if (!input.attempts.ok) {
    return { kind: 'closed', reason: `review attempts are unavailable (${input.attempts.error.tag}).` };
  }
  const target = input.attempts.data.target;
  if (target === null || target.checkoutPath === null) {
    return {
      kind: 'closed',
      reason:
        'the target session names no checkout (no Desktop worktree or cwd, no served session path); nothing to review.',
    };
  }
  if (input.reviewTargetsDeclared === 0) {
    return {
      kind: 'closed',
      reason: `no checkout is declared for execution; add routing.reviewTargets for ${target.checkoutPath} to the home config.`,
    };
  }
  if (!target.admitted) {
    return { kind: 'closed', reason: `add routing.reviewTargets for ${target.checkoutPath}.` };
  }
  return { checkoutPath: target.checkoutPath, kind: 'open' };
};

const STATE_LABELS: Readonly<Record<ReviewAttemptState, string>> = {
  failed: 'failed',
  finished: 'finished',
  lost: 'contact lost; verify in the harness',
  refused: 'refused',
  requested: 'requested',
  running: 'running',
  starting: 'starting',
};

export const reviewAttemptStateLabel = (state: ReviewAttemptState): string => STATE_LABELS[state];

const ORIGIN_LABELS: Readonly<Record<ReviewCheckoutOrigin, string>> = {
  'desktop-cwd': 'Desktop session cwd',
  'desktop-worktree': 'Desktop session worktree',
  'served-session': 'served session path',
};

export const checkoutOriginLabel = (origin: ReviewCheckoutOrigin): string => ORIGIN_LABELS[origin];

export const shortAttemptId = (attemptId: string): string => attemptId.slice(0, 8);

export const formatDurationSeconds = (durationMs: number | null): string | null =>
  durationMs === null ? null : `${Math.round(durationMs / 100) / 10} s`;

const RELEASE_LABELS: Readonly<Record<ReviewReservationReleaseEvidence, string>> = {
  'outcome-recorded-late': 'the engine that launched it recorded its end after contact was lost',
  'process-absent': 'no process on this machine carried its launch marker any more',
  'recorded-before-reservations': 'it was lost under the earlier rule, which kept no reservation',
};

/**
 * What a lost attempt means for the next launch (ADR 0055). A held reservation keeps the button:
 * the click is the explicit request for the engine to look for that process, and the engine
 * refuses while it still runs. Nothing here decides; the engine does.
 */
export const reservationNotice = (attempt: Pick<WorkAttemptWire, 'reservation' | 'state'>): string | null => {
  if (attempt.state !== 'lost') {
    return null;
  }
  if (attempt.reservation.held) {
    return 'It still reserves this target: a new review is accepted here only once no process carries its launch marker or its result is recorded. Starting a review asks the engine to look first; it never adopts or stops that process.';
  }
  const evidence = attempt.reservation.releaseEvidence;
  return evidence === null ? null : `Reservation released: ${RELEASE_LABELS[evidence]}.`;
};

const shortSha = (sha: string): string => sha.slice(0, 12);

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round((bytes / 1024) * 10) / 10} KB`;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** One sentence naming exactly what the review was given, and what it was not. */
export const scopeSummary = (scope: WorkAttemptScopeWire): string => {
  const base =
    scope.base === 'empty-tree'
      ? 'the empty tree (a root commit)'
      : `its first parent ${shortSha(scope.baseSha)}${scope.parentCount > 1 ? ' (a merge, first parent only)' : ''}`;
  const patch = scope.truncated
    ? `partial: ${formatBytes(scope.includedBytes)} of ${formatBytes(scope.patchBytes)}, ${scope.includedLines} of ${scope.patchLines} lines`
    : `complete: ${formatBytes(scope.patchBytes)}, ${plural(scope.patchLines, 'line')}`;
  const counts = new Map<string, number>();
  for (const file of scope.files) {
    counts.set(file.coverage, (counts.get(file.coverage) ?? 0) + 1);
  }
  const coverage = ['complete', 'partial', 'omitted', 'binary']
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => `${counts.get(kind)} ${kind}`)
    .join(', ');
  const unlisted = scope.fileCount - scope.files.length;
  return `Reviewed commit ${shortSha(scope.headSha)}${scope.subject === null ? '' : ` "${scope.subject}"`} against ${base}, one revision only. Patch ${patch}; ${plural(scope.fileCount, 'file')} (${coverage}${unlisted > 0 ? `, ${unlisted} not listed` : ''}); sha256 ${shortSha(scope.patchSha256)}.`;
};

export const DIRTY_TREE_TEXT =
  'The working tree had uncommitted changes: files the review read may differ from this commit.';

/** The guarantee the launch rested on, and the limits of "read-only", in the operator's words. */
export const guaranteeSummary = (guarantee: WorkAttemptGuaranteeWire): string => {
  const sources =
    guarantee.settingSources.length === 0
      ? 'none (user, project and local settings, and their hooks, were not loaded)'
      : guarantee.settingSources.join(', ');
  const managed =
    guarantee.managedSettings === 'present'
      ? 'a managed policy file exists on this machine and cannot be excluded: its hooks, if any, still ran'
      : 'no managed policy file on this machine (policy delivered by an organization is not observable here)';
  return `Ran under Claude Code ${guarantee.cliVersion}: settings loaded ${sources}; safe mode ${guarantee.safeMode ? 'on' : 'off'}; tools ${guarantee.tools.join(', ')}; model ${guarantee.model ?? 'not passed (CLI default)'}${guarantee.effort === null ? '' : `, effort ${guarantee.effort}`}; ${managed}. Read-only means no repository write and no external action by the review's tools; Claude Code still writes its own session logs, and no OS sandbox is claimed.`;
};

/** The line above the excerpt: its kind, whether the scope was partial, turns, duration and exit. */
export const resultHeading = (
  attempt: Pick<WorkAttemptWire, 'durationMs' | 'exitCode' | 'numTurns' | 'resultKind' | 'scope'>,
): string => {
  const duration = formatDurationSeconds(attempt.durationMs);
  return [
    `Result (${attempt.resultKind ?? 'unknown'}${attempt.scope?.truncated ? ', partial: the patch was truncated' : ''})`,
    ...(attempt.numTurns === null ? [] : [`${attempt.numTurns} turns`]),
    ...(duration === null ? [] : [duration]),
    ...(attempt.exitCode === null ? [] : [`exit ${attempt.exitCode}`]),
  ]
    .join(' · ')
    .concat(':');
};
