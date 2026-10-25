/**
 * The attempt states and launch refusal reasons (ADR 0053, 0055), in a module with no import at
 * all. The usage-engine control contract validates both and sits in the browser's first-load
 * closure; reading them from here keeps the launch policy, the routing qualification and the
 * executor parser out of that closure. `work-attempts.ts` re-exports both; this file must stay
 * import-free.
 */
export const REVIEW_ATTEMPT_STATES = [
  'requested',
  'starting',
  'running',
  'finished',
  'failed',
  'refused',
  'lost',
] as const;
export type ReviewAttemptState = (typeof REVIEW_ATTEMPT_STATES)[number];

export const REVIEW_LAUNCH_REFUSAL_REASONS = [
  'no-declaration',
  'target-not-allowed',
  'recommendation-not-real',
  'executor-unavailable',
  'harness-unsupported',
  'attempt-already-live',
  'attempt-unresolved',
  'identity-changed',
  // The common review policy (ADR 0077) applied before the legacy launch too: the delegation rules
  // refused the route, the checkout has no reviewable revision, another review of either family
  // reserves the target, or the route's quota pool has no slot left.
  'policy-refused',
  'scope-unavailable',
  'target-reserved',
  'pool-busy',
] as const;
export type ReviewLaunchRefusalReason = (typeof REVIEW_LAUNCH_REFUSAL_REASONS)[number];
