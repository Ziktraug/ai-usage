import { isRecord } from './datasets';
import type { ProviderStatus } from './provider-status';
import { normalizeIsoTimestamp } from './provider-status';
import { isPrintableSkillObservationText } from './skill-observation';
import {
  EXECUTOR_HARNESSES,
  type ExecutorDeclaration,
  type ExecutorHarness,
  type ExecutorObservation,
  executorDeclarationKey,
} from './work-executors';
import {
  assessReviewRecommendation,
  qualifyReviewCandidates,
  type ReviewCandidate,
  type ReviewTarget,
  simulateWorkReviewRouting,
} from './work-routing';

/**
 * Review attempts (ADR 0053): the one execution the product launches itself, a read-only review by
 * Claude Code of the latest change in a declared checkout. This module holds what is pure:
 *
 * - the home-config `routing.reviewTargets[]` parser (which checkouts a review may run in);
 * - the target resolution rule (Desktop session `worktreePath ?? cwd`, else the served Session's
 *   `sourcePath`) and the admission rule (equal to a declared checkout or below it);
 * - the launch policy `decideReviewLaunch`, which refuses with a typed reason unless the chosen
 *   candidate is declared, bound to this target, observed available and recommended `real` by the
 *   same qualification the Work view simulates;
 * - the attempt record and its strict re-validation, the idempotency key, the prompt and the
 *   `stream-json` line reader.
 *
 * Nothing here spawns anything. The engine decides with these functions at launch time, from the
 * facts in its own store; the browser only renders.
 */
export const REVIEW_ATTEMPT_ACTION = 'read-only-review' as const;
export type ReviewAttemptAction = typeof REVIEW_ATTEMPT_ACTION;

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
export const REVIEW_ATTEMPT_LIVE_STATES = [
  'requested',
  'starting',
  'running',
] as const satisfies readonly ReviewAttemptState[];
export const isLiveReviewAttemptState = (state: ReviewAttemptState): boolean =>
  (REVIEW_ATTEMPT_LIVE_STATES as readonly string[]).includes(state);

export const REVIEW_ATTEMPT_RESULT_KINDS = ['review', 'error', 'timeout'] as const;
export type ReviewAttemptResultKind = (typeof REVIEW_ATTEMPT_RESULT_KINDS)[number];
export const REVIEW_ATTEMPT_ACCEPTANCES = ['pending', 'accepted', 'rejected'] as const;
export type ReviewAttemptAcceptance = (typeof REVIEW_ATTEMPT_ACCEPTANCES)[number];

export const REVIEW_LAUNCH_REFUSAL_REASONS = [
  'no-declaration',
  'target-not-allowed',
  'recommendation-not-real',
  'executor-unavailable',
  'harness-unsupported',
  'attempt-already-live',
] as const;
export type ReviewLaunchRefusalReason = (typeof REVIEW_LAUNCH_REFUSAL_REASONS)[number];

export const REVIEW_CHECKOUT_ORIGINS = ['desktop-worktree', 'desktop-cwd', 'served-session'] as const;
export type ReviewCheckoutOrigin = (typeof REVIEW_CHECKOUT_ORIGINS)[number];

export const REVIEW_ATTEMPT_BOUNDS = {
  /** Serialized declaration snapshot stored beside the attempt. */
  maxDeclarationJson: 8192,
  /** `resultExcerpt`: the harness's final message, never the transcript. */
  maxExcerpt: 4000,
  maxFailureReason: 512,
  /** `attemptId`, `candidateId`, `sourceSessionId`, `desktopSessionId`, `nativeSessionId`, `idempotencyKey`. */
  maxId: 512,
  /** Attempts one list read returns. */
  maxListLimit: 50,
  maxPath: 4096,
  /** Each git summary the prompt carries. */
  maxPromptContext: 4096,
  maxReviewTargets: 32,
  /** `projectLabel`, `sessionTitle`, `label`. */
  maxText: 256,
  maxValidationText: 512,
  maxValidations: 32,
} as const;

/** Execution limits the launcher enforces; stored nowhere, stated once. */
export const REVIEW_ATTEMPT_RUN_LIMITS = {
  heartbeatMs: 15_000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxTurns: 8,
  timeoutMs: 10 * 60_000,
} as const;

const isOneOf = <const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isBoundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  isPrintableSkillObservationText(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): string[] =>
  Object.keys(record).filter((key) => !keys.has(key));

/** Multi-line text a page can render: tabs and line breaks stay, every other C0/C1 character is refused. */
const isRenderableMultilineText = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return false;
    }
  }
  return true;
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// ---------------------------------------------------------------------------------------------
// Declared checkouts and target resolution
// ---------------------------------------------------------------------------------------------

export interface ReviewTargetDeclaration {
  /** Absolute, normalized path of a checkout a review may run in; descendants are admitted too. */
  readonly checkoutPath: string;
  readonly label: string | null;
}

export interface ReviewTargetDeclarationIssue {
  /** Config path such as `routing.reviewTargets[1].checkoutPath`; never the offending value. */
  readonly path: string;
  readonly reason: string;
}

export interface ReviewTargetDeclarationParseResult {
  readonly issues: readonly ReviewTargetDeclarationIssue[];
  readonly targets: readonly ReviewTargetDeclaration[];
}

const REVIEW_TARGET_KEYS: ReadonlySet<string> = new Set(['checkoutPath', 'label']);

/**
 * An absolute POSIX path with duplicate and trailing slashes removed, or `null` when the value is
 * relative, carries `.`/`..` segments (an admission check must not be talked around) or is not
 * printable. No filesystem access: this is a textual rule both the engine and the Web read apply.
 */
export const normalizeCheckoutPath = (value: unknown): string | null => {
  if (!(isBoundedText(value, REVIEW_ATTEMPT_BOUNDS.maxPath) && value.startsWith('/'))) {
    return null;
  }
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return `/${segments.join('/')}`;
};

/** Equal to a declared checkout, or strictly below one. */
export const isCheckoutPathAdmitted = (checkoutPath: string, targets: readonly ReviewTargetDeclaration[]): boolean => {
  const normalized = normalizeCheckoutPath(checkoutPath);
  if (normalized === null) {
    return false;
  }
  return targets.some((target) => {
    if (normalized === target.checkoutPath) {
      return true;
    }
    const prefix = target.checkoutPath === '/' ? '/' : `${target.checkoutPath}/`;
    return normalized.startsWith(prefix);
  });
};

/** Strict parsing of `routing.reviewTargets[]`; an invalid entry is located, never echoed. */
export const parseReviewTargetDeclarations = (
  value: unknown,
  options: { readonly path?: string } = {},
): ReviewTargetDeclarationParseResult => {
  const path = options.path ?? 'routing.reviewTargets';
  if (value === undefined) {
    return { issues: [], targets: [] };
  }
  if (!Array.isArray(value)) {
    return { issues: [{ path, reason: 'must be an array of { checkoutPath, label? } entries' }], targets: [] };
  }
  const issues: ReviewTargetDeclarationIssue[] = [];
  const targets: ReviewTargetDeclaration[] = [];
  const seen = new Map<string, number>();
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (index >= REVIEW_ATTEMPT_BOUNDS.maxReviewTargets) {
      issues.push({
        path: entryPath,
        reason: `exceeds the ${REVIEW_ATTEMPT_BOUNDS.maxReviewTargets}-entry bound; ignored`,
      });
      continue;
    }
    if (!isRecord(entry)) {
      issues.push({ path: entryPath, reason: 'must be an object with a checkoutPath' });
      continue;
    }
    const extra = hasOnlyKeys(entry, REVIEW_TARGET_KEYS);
    if (extra.length > 0) {
      issues.push({ path: entryPath, reason: `unknown field(s): ${extra.join(', ')}` });
      continue;
    }
    const checkoutPath = normalizeCheckoutPath(entry.checkoutPath);
    if (checkoutPath === null) {
      issues.push({
        path: `${entryPath}.checkoutPath`,
        reason: `must be an absolute path of at most ${REVIEW_ATTEMPT_BOUNDS.maxPath} characters without . or .. segments`,
      });
      continue;
    }
    let label: string | null = null;
    if (entry.label !== undefined && entry.label !== null) {
      if (!isBoundedText(entry.label, REVIEW_ATTEMPT_BOUNDS.maxText)) {
        issues.push({
          path: `${entryPath}.label`,
          reason: `must be a non-empty string of at most ${REVIEW_ATTEMPT_BOUNDS.maxText} characters`,
        });
        continue;
      }
      label = entry.label;
    }
    const previous = seen.get(checkoutPath);
    if (previous !== undefined) {
      issues.push({ path: entryPath, reason: `duplicates reviewTargets[${previous}] (same checkoutPath); ignored` });
      continue;
    }
    seen.set(checkoutPath, index);
    targets.push({ checkoutPath, label });
  }
  return { issues, targets };
};

export interface ReviewCheckoutResolution {
  readonly checkoutPath: string;
  readonly origin: ReviewCheckoutOrigin;
}

export interface ReviewCheckoutResolutionInput {
  /** The Claude Desktop session that declared this transcript, when one was collected. */
  readonly desktop: { readonly cwd: string | null; readonly worktreePath: string | null } | null;
  /** The served Session row for the native session, when the report carries it. */
  readonly session: { readonly sourcePath: string | null } | null;
}

/** Desktop `worktreePath`, then Desktop `cwd`, then the served Session's `sourcePath`; `null` otherwise. */
export const resolveReviewCheckoutPath = (input: ReviewCheckoutResolutionInput): ReviewCheckoutResolution | null => {
  const candidates: readonly (readonly [unknown, ReviewCheckoutOrigin])[] = [
    [input.desktop?.worktreePath, 'desktop-worktree'],
    [input.desktop?.cwd, 'desktop-cwd'],
    [input.session?.sourcePath, 'served-session'],
  ];
  for (const [value, origin] of candidates) {
    const checkoutPath = normalizeCheckoutPath(value);
    if (checkoutPath !== null) {
      return { checkoutPath, origin };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

export interface ReviewAttemptIdentityParts {
  readonly action: ReviewAttemptAction;
  /** The target session's harness key (`claude`, `codex`, ...), part of the target identity. */
  readonly checkoutPath: string | null;
  readonly harness: string;
  readonly machineId: string;
  readonly sourceSessionId: string;
}

/** The pre-image of the idempotency key, in the order the decision names it. */
export const reviewAttemptIdentity = (parts: ReviewAttemptIdentityParts): string =>
  [parts.machineId, parts.action, parts.harness, parts.sourceSessionId, parts.checkoutPath ?? ''].join('|');

const toHex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
};

/** `sha256(machineId|action|harness|sourceSessionId|checkoutPath)` as lowercase hex; Web Crypto, so it runs anywhere. */
export const reviewAttemptIdempotencyKey = async (parts: ReviewAttemptIdentityParts): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(reviewAttemptIdentity(parts)),
  );
  return toHex(new Uint8Array(digest));
};

// ---------------------------------------------------------------------------------------------
// The attempt record
// ---------------------------------------------------------------------------------------------

export interface ReviewAttemptTarget {
  /** Where the checkout path came from; `null` for a refusal that never resolved one. */
  readonly checkoutOrigin: ReviewCheckoutOrigin | null;
  readonly checkoutPath: string | null;
  readonly desktopSessionId: string | null;
  readonly harness: string;
  readonly projectLabel: string | null;
  readonly sessionTitle: string | null;
  readonly sourceSessionId: string;
}

export interface ReviewAttempt {
  /** Human acceptance of the result, distinct from the result itself; always `pending` in this version. */
  readonly acceptance: ReviewAttemptAcceptance;
  readonly action: ReviewAttemptAction;
  readonly attemptId: string;
  readonly candidateId: string;
  /** The declaration the launch rested on, re-validated; `null` when it no longer parses or was never bound. */
  readonly declaration: ExecutorDeclaration | null;
  readonly durationMs: number | null;
  readonly endedAt: string | null;
  readonly executorHarness: ExecutorHarness;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  readonly idempotencyKey: string;
  readonly machineId: string;
  /** The harness's own session id, read from its `system/init` message; the link to a later collected Session. */
  readonly nativeSessionId: string | null;
  readonly numTurns: number | null;
  readonly pid: number | null;
  readonly requestedAt: string;
  readonly resultExcerpt: string | null;
  readonly resultKind: ReviewAttemptResultKind | null;
  readonly startedAt: string | null;
  readonly state: ReviewAttemptState;
  readonly target: ReviewAttemptTarget;
  /** Last heartbeat or transition. */
  readonly updatedAt: string;
  /** Verification commands the review actually ran: none in a read-only review, never invented. */
  readonly validations: readonly string[];
}

const ATTEMPT_KEYS: ReadonlySet<string> = new Set([
  'acceptance',
  'action',
  'attemptId',
  'candidateId',
  'declaration',
  'durationMs',
  'endedAt',
  'executorHarness',
  'exitCode',
  'failureReason',
  'idempotencyKey',
  'machineId',
  'nativeSessionId',
  'numTurns',
  'pid',
  'requestedAt',
  'resultExcerpt',
  'resultKind',
  'startedAt',
  'state',
  'target',
  'updatedAt',
  'validations',
]);
const TARGET_KEYS: ReadonlySet<string> = new Set([
  'checkoutOrigin',
  'checkoutPath',
  'desktopSessionId',
  'harness',
  'projectLabel',
  'sessionTitle',
  'sourceSessionId',
]);

const optionalId = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return isBoundedText(value, REVIEW_ATTEMPT_BOUNDS.maxId) ? value : undefined;
};
const optionalText = (value: unknown, maximum: number): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && value.length <= maximum && isRenderableMultilineText(value) ? value : undefined;
};
const optionalInstant = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  const instant = normalizeIsoTimestamp(value);
  return typeof value === 'string' && instant !== null ? instant : undefined;
};
const optionalCount = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }
  return isNonNegativeInteger(value) ? value : undefined;
};
const optionalExitCode = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
};

const parseAttemptTarget = (value: unknown): ReviewAttemptTarget | null => {
  if (!isRecord(value) || hasOnlyKeys(value, TARGET_KEYS).length > 0) {
    return null;
  }
  const desktopSessionId = optionalId(value.desktopSessionId);
  const projectLabel = optionalText(value.projectLabel, REVIEW_ATTEMPT_BOUNDS.maxText);
  const sessionTitle = optionalText(value.sessionTitle, REVIEW_ATTEMPT_BOUNDS.maxText);
  const checkoutPath = value.checkoutPath === null ? null : normalizeCheckoutPath(value.checkoutPath);
  const checkoutOrigin = value.checkoutOrigin === null ? null : value.checkoutOrigin;
  if (
    !(
      isBoundedText(value.harness, REVIEW_ATTEMPT_BOUNDS.maxText) &&
      isBoundedText(value.sourceSessionId, REVIEW_ATTEMPT_BOUNDS.maxId)
    ) ||
    desktopSessionId === undefined ||
    projectLabel === undefined ||
    sessionTitle === undefined ||
    (value.checkoutPath !== null && checkoutPath === null) ||
    (checkoutOrigin !== null && !isOneOf(REVIEW_CHECKOUT_ORIGINS, checkoutOrigin)) ||
    (checkoutPath === null) !== (checkoutOrigin === null)
  ) {
    return null;
  }
  return {
    checkoutOrigin,
    checkoutPath,
    desktopSessionId,
    harness: value.harness,
    projectLabel,
    sessionTitle,
    sourceSessionId: value.sourceSessionId,
  };
};

const parseValidations = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value) || value.length > REVIEW_ATTEMPT_BOUNDS.maxValidations) {
    return null;
  }
  const validations: string[] = [];
  for (const entry of value) {
    if (!isBoundedText(entry, REVIEW_ATTEMPT_BOUNDS.maxValidationText)) {
      return null;
    }
    validations.push(entry);
  }
  return validations;
};

/**
 * Strict re-validation of one stored attempt. `declaration` is taken as given (the store re-parses
 * it with `parseExecutorDeclarations` before calling this), so only its presence is checked here.
 */
export const parseReviewAttempt = (value: unknown): ReviewAttempt | null => {
  if (!isRecord(value) || hasOnlyKeys(value, ATTEMPT_KEYS).length > 0) {
    return null;
  }
  const target = parseAttemptTarget(value.target);
  const requestedAt = optionalInstant(value.requestedAt);
  const updatedAt = optionalInstant(value.updatedAt);
  const startedAt = optionalInstant(value.startedAt);
  const endedAt = optionalInstant(value.endedAt);
  const nativeSessionId = optionalId(value.nativeSessionId);
  const pid = optionalCount(value.pid);
  const exitCode = optionalExitCode(value.exitCode);
  const numTurns = optionalCount(value.numTurns);
  const durationMs = optionalCount(value.durationMs);
  const resultExcerpt = optionalText(value.resultExcerpt, REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
  const failureReason = optionalText(value.failureReason, REVIEW_ATTEMPT_BOUNDS.maxFailureReason);
  const validations = parseValidations(value.validations);
  let declaration: Record<string, unknown> | null | undefined;
  if (value.declaration === null) {
    declaration = null;
  } else if (isRecord(value.declaration)) {
    declaration = value.declaration;
  }
  if (
    target === null ||
    value.action !== REVIEW_ATTEMPT_ACTION ||
    !isBoundedText(value.attemptId, REVIEW_ATTEMPT_BOUNDS.maxId) ||
    !isBoundedText(value.candidateId, REVIEW_ATTEMPT_BOUNDS.maxId) ||
    !isBoundedText(value.idempotencyKey, REVIEW_ATTEMPT_BOUNDS.maxId) ||
    !isBoundedText(value.machineId, REVIEW_ATTEMPT_BOUNDS.maxText) ||
    !isOneOf(EXECUTOR_HARNESSES, value.executorHarness) ||
    !isOneOf(REVIEW_ATTEMPT_STATES, value.state) ||
    !isOneOf(REVIEW_ATTEMPT_ACCEPTANCES, value.acceptance) ||
    !(value.resultKind === null || isOneOf(REVIEW_ATTEMPT_RESULT_KINDS, value.resultKind)) ||
    requestedAt === null ||
    requestedAt === undefined ||
    updatedAt === null ||
    updatedAt === undefined ||
    startedAt === undefined ||
    endedAt === undefined ||
    nativeSessionId === undefined ||
    pid === undefined ||
    exitCode === undefined ||
    numTurns === undefined ||
    durationMs === undefined ||
    resultExcerpt === undefined ||
    failureReason === undefined ||
    validations === null ||
    declaration === undefined
  ) {
    return null;
  }
  return {
    acceptance: value.acceptance,
    action: REVIEW_ATTEMPT_ACTION,
    attemptId: value.attemptId,
    candidateId: value.candidateId,
    declaration: declaration as ExecutorDeclaration | null,
    durationMs,
    endedAt,
    executorHarness: value.executorHarness,
    exitCode,
    failureReason,
    idempotencyKey: value.idempotencyKey,
    machineId: value.machineId,
    nativeSessionId,
    numTurns,
    pid,
    requestedAt,
    resultExcerpt,
    resultKind: value.resultKind,
    startedAt,
    state: value.state,
    target,
    updatedAt,
    validations,
  };
};

// ---------------------------------------------------------------------------------------------
// Launch policy
// ---------------------------------------------------------------------------------------------

export interface ReviewLaunchDecisionInput {
  readonly candidateId: string;
  readonly checkout: ReviewCheckoutResolution | null;
  readonly declarations: readonly ExecutorDeclaration[];
  readonly executorObservations: readonly ExecutorObservation[];
  readonly now: string;
  /** A live attempt for the same target under another identity (for example another checkout path). */
  readonly otherLiveAttempt: Pick<ReviewAttempt, 'attemptId'> | null;
  readonly providers: readonly ProviderStatus[];
  readonly reviewTargets: readonly ReviewTargetDeclaration[];
  readonly target: ReviewTarget;
}

export type ReviewLaunchDecision =
  | {
      readonly candidate: ReviewCandidate;
      readonly checkout: ReviewCheckoutResolution;
      readonly declaration: ExecutorDeclaration;
      readonly kind: 'allowed';
    }
  | {
      readonly kind: 'refused';
      readonly message: string;
      /** The named facts whose absence or state produced the refusal; empty when the reason is complete by itself. */
      readonly missing: readonly string[];
      readonly reason: ReviewLaunchRefusalReason;
    };

const refusal = (
  reason: ReviewLaunchRefusalReason,
  message: string,
  missing: readonly string[] = [],
): ReviewLaunchDecision => ({ kind: 'refused', message, missing: [...new Set(missing)], reason });

/** The one supported executor for this first execution; Codex is declared, simulated, and refused. */
export const SUPPORTED_REVIEW_EXECUTOR: ExecutorHarness = 'claude-code';

/**
 * Pure launch policy. Refusals are ordered from the most structural to the most transient so the
 * operator reads the fix that unblocks the next step: an attempt already live for the target, no
 * declaration for the candidate, an executor other than Claude Code, a target outside
 * `routing.reviewTargets`, an executor not observed available, and finally a recommendation that
 * is not `real` under the forced candidate.
 */
export const decideReviewLaunch = (input: ReviewLaunchDecisionInput): ReviewLaunchDecision => {
  if (input.otherLiveAttempt !== null) {
    return refusal(
      'attempt-already-live',
      `a review is already running (attempt ${input.otherLiveAttempt.attemptId}); wait for it to end`,
    );
  }
  const candidates = qualifyReviewCandidates({
    declarations: input.declarations,
    executorObservations: input.executorObservations,
    now: input.now,
    providers: input.providers,
    target: input.target,
  });
  const candidate = candidates.find((entry) => entry.id === input.candidateId);
  const declared = input.declarations.filter((declaration) => declaration.machineId === input.target.machineId);
  if (declared.length === 0) {
    return refusal(
      'no-declaration',
      `no routing.executors[] declaration exists for machine ${input.target.machineId}; add one before launching`,
    );
  }
  const declaration = input.declarations.find(
    (entry) => `declared:${executorDeclarationKey(entry)}` === input.candidateId,
  );
  if (!(candidate && declaration) || candidate.provenance.authorization !== 'declared') {
    return refusal(
      'no-declaration',
      `candidate ${input.candidateId} is not a declared executor on machine ${input.target.machineId}`,
    );
  }
  if (candidate.harness !== SUPPORTED_REVIEW_EXECUTOR) {
    return refusal(
      'harness-unsupported',
      `only Claude Code launches a review in this version; ${candidate.harness} is simulated, not executed`,
    );
  }
  if (input.checkout === null) {
    return refusal(
      'target-not-allowed',
      'the target session names no checkout (no Desktop worktree or cwd, no served session path); nothing to review',
    );
  }
  if (!isCheckoutPathAdmitted(input.checkout.checkoutPath, input.reviewTargets)) {
    return refusal('target-not-allowed', `add routing.reviewTargets for ${input.checkout.checkoutPath}`);
  }
  if (candidate.availability !== 'available') {
    return refusal(
      'executor-unavailable',
      `the Claude Code CLI is not observed available on machine ${input.target.machineId} (${candidate.availability})`,
      candidate.qualificationActions,
    );
  }
  const result = simulateWorkReviewRouting({
    candidates,
    policy: {
      forcedCandidateId: input.candidateId,
      nearResetMinutes: 60,
      preferNearReset: false,
      preferredHarness: SUPPORTED_REVIEW_EXECUTOR,
    },
    referenceTime: input.now,
    request: {
      action: REVIEW_ATTEMPT_ACTION,
      minimumQuality: 'review-capable',
      requiredCapabilities: ['read-only-review'],
      target: input.target,
    },
  });
  const recommendation = assessReviewRecommendation(result, candidates);
  if (recommendation.kind !== 'real' || recommendation.candidateId !== input.candidateId) {
    const evaluation = result.evaluations.find((entry) => entry.candidateId === input.candidateId);
    return refusal(
      'recommendation-not-real',
      recommendation.kind === 'conditional'
        ? `recommendation is conditional (missing: ${recommendation.missing ?? 'candidate detail'}); a conditional simulation never permits a launch`
        : 'no real recommendation selects this candidate; see the missing facts and exclusions',
      [
        ...(recommendation.missing === null ? [] : [recommendation.missing]),
        ...(evaluation?.missingData ?? []),
        ...(evaluation?.exclusionReasons ?? []),
      ],
    );
  }
  return { candidate, checkout: input.checkout, declaration, kind: 'allowed' };
};

// ---------------------------------------------------------------------------------------------
// Prompt and stream-json reading
// ---------------------------------------------------------------------------------------------

export interface ReviewPromptInput {
  /** `git diff --stat HEAD~1..HEAD`, read by the launcher; `null` when git could not answer. */
  readonly gitDiffStat: string | null;
  /** `git log -1 --format='%h %s'`; `null` when git could not answer. */
  readonly gitLog: string | null;
  readonly sessionTitle: string | null;
}

const boundContext = (value: string | null): string => {
  if (value === null || value.trim().length === 0) {
    return 'unavailable';
  }
  const trimmed = value.trim();
  return trimmed.length <= REVIEW_ATTEMPT_BOUNDS.maxPromptContext
    ? trimmed
    : `${trimmed.slice(0, REVIEW_ATTEMPT_BOUNDS.maxPromptContext)}\n[truncated]`;
};

export const REVIEW_PROMPT_INSTRUCTION =
  'Read-only review of the latest change in this checkout (`git log -1` is already summarized below). List at most five findings with file:line, severity and a one-line failure scenario. Do not modify files.';

/** Generic and bounded: the instruction, the target's title and two git summaries. Never a transcript. */
export const buildReviewPrompt = (input: ReviewPromptInput): string =>
  [
    REVIEW_PROMPT_INSTRUCTION,
    '',
    `Target session: ${boundContext(input.sessionTitle)}`,
    `Latest commit (git log -1): ${boundContext(input.gitLog)}`,
    'Changed files (git diff --stat HEAD~1..HEAD):',
    boundContext(input.gitDiffStat),
  ].join('\n');

export type ClaudeStreamEvent =
  | { readonly kind: 'init'; readonly sessionId: string }
  | {
      readonly durationMs: number | null;
      readonly isError: boolean;
      readonly kind: 'result';
      readonly numTurns: number | null;
      readonly sessionId: string | null;
      readonly subtype: string | null;
      readonly text: string | null;
    };

/**
 * One line of `claude -p --output-format stream-json`. Only the two messages the attempt record
 * needs are read: `system/init` for the native session id and `result` for the outcome. Every other
 * line (assistant turns, tool use) is `null` and is never retained.
 */
export const parseClaudeStreamJsonLine = (line: string): ClaudeStreamEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = isBoundedText(value.session_id, REVIEW_ATTEMPT_BOUNDS.maxId) ? value.session_id : null;
  if (value.type === 'system' && value.subtype === 'init') {
    return sessionId === null ? null : { kind: 'init', sessionId };
  }
  if (value.type === 'result') {
    return {
      durationMs: isNonNegativeInteger(value.duration_ms) ? value.duration_ms : null,
      isError: value.is_error === true,
      kind: 'result',
      numTurns: isNonNegativeInteger(value.num_turns) ? value.num_turns : null,
      sessionId,
      subtype: typeof value.subtype === 'string' ? value.subtype.slice(0, REVIEW_ATTEMPT_BOUNDS.maxText) : null,
      text: typeof value.result === 'string' ? value.result : null,
    };
  }
  return null;
};

/** The final message bounded to `maxExcerpt` characters with control characters removed. */
export const boundReviewExcerpt = (text: string | null): string | null => {
  if (text === null) {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the excerpt is stored and rendered; tabs and newlines stay, other C0/C1 characters go.
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '');
  if (cleaned.trim().length === 0) {
    return null;
  }
  return cleaned.length <= REVIEW_ATTEMPT_BOUNDS.maxExcerpt
    ? cleaned
    : `${cleaned.slice(0, REVIEW_ATTEMPT_BOUNDS.maxExcerpt - 12)}\n[truncated]`;
};
