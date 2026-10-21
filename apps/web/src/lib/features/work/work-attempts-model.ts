import {
  isLiveReviewAttemptState,
  type ReviewAttemptState,
  type ReviewCheckoutOrigin,
  SUPPORTED_REVIEW_EXECUTOR,
} from '@ai-usage/report-core/work-attempts';
import type { ReviewCandidate, ReviewRecommendation } from '@ai-usage/report-core/work-routing';
import type { WorkAttemptsListOutput, WorkAttemptWire } from '@ai-usage/web-contract/work-attempts';

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
