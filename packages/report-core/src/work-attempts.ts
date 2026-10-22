import { isRecord } from './datasets';
import type { ProviderStatus } from './provider-status';
import { normalizeIsoTimestamp } from './provider-status';
import { isPrintableSkillObservationText } from './skill-observation';
/**
 * Review attempts (ADR 0053, 0055): the one execution the product launches itself, a read-only review
 * by a qualified local Claude Code or Codex executor of one commit in a declared checkout. This module holds what is pure:
 *
 * - the home-config `routing.reviewTargets[]` parser (which checkouts a review may run in);
 * - the target resolution rule (Desktop session `worktreePath ?? cwd`, else the served Session's
 *   `sourcePath`) and the admission rule (equal to a declared checkout or below it);
 * - the launch policy `decideReviewLaunch`, which refuses with a typed reason unless the chosen
 *   candidate is declared, bound to this target, observed available and recommended `real` by the
 *   same qualification the Work view simulates;
 * - the attempt record (with its reservation, reviewed scope and harness guarantee) and its strict
 *   re-validation, the idempotency key, the prompt and the `stream-json` line reader.
 *
 * Nothing here spawns anything. The engine decides with these functions at launch time, from the
 * facts in its own store; the browser only renders.
 */
import {
  REVIEW_ATTEMPT_STATES,
  type ReviewAttemptState,
  type ReviewLaunchRefusalReason,
} from './work-attempts-vocabulary';
import {
  EXECUTOR_HARNESSES,
  type ExecutorDeclaration,
  type ExecutorHarness,
  type ExecutorObservation,
  isExecutorAccountFingerprint,
} from './work-executors';
import {
  assessReviewRecommendation,
  declarationForReviewCandidate,
  qualifyReviewCandidates,
  type ReviewCandidate,
  type ReviewTarget,
  simulateWorkReviewRouting,
} from './work-routing';

export {
  REVIEW_ATTEMPT_STATES,
  REVIEW_LAUNCH_REFUSAL_REASONS,
  type ReviewAttemptState,
  type ReviewLaunchRefusalReason,
} from './work-attempts-vocabulary';

export const REVIEW_ATTEMPT_ACTION = 'read-only-review' as const;
export type ReviewAttemptAction = typeof REVIEW_ATTEMPT_ACTION;

export const REVIEW_ATTEMPT_LIVE_STATES = [
  'requested',
  'starting',
  'running',
] as const satisfies readonly ReviewAttemptState[];
export const isLiveReviewAttemptState = (state: ReviewAttemptState): boolean =>
  (REVIEW_ATTEMPT_LIVE_STATES as readonly string[]).includes(state);

/**
 * States in which an attempt may hold its identity's reservation (ADR 0055): the live states, and
 * `lost` until the reservation is released with evidence. Losing contact with a process proves
 * nothing about its end, so a lost attempt keeps blocking a second launch on the same identity.
 */
export const REVIEW_ATTEMPT_RESERVING_STATES = [
  ...REVIEW_ATTEMPT_LIVE_STATES,
  'lost',
] as const satisfies readonly ReviewAttemptState[];

/**
 * Why a lost attempt no longer holds its reservation. Age is never one of them:
 *
 * - `process-absent`: no process on this machine carries the attempt's launch session id in its
 *   argument vector (the engine passes it as `--session-id`), so the harness process has ended
 *   whatever its pid became; only the launching engine could still write, and it is gone;
 * - `outcome-recorded-late`: the engine that launched the process saw it end and recorded the
 *   outcome after the attempt had been marked lost;
 * - `recorded-before-reservations`: the attempt was marked lost by the earlier rule, which kept no
 *   reservation; the migration says so instead of inventing a process fact;
 * - `operator-declared-ended`: the operator declared, at `releasedAt`, that no such review is
 *   still running, where the engine could not look (no launch marker, no readable process list).
 *   It is the operator's statement, recorded as theirs; nothing was stopped or adopted.
 */
export const REVIEW_RESERVATION_RELEASE_EVIDENCE = [
  'process-absent',
  'outcome-recorded-late',
  'recorded-before-reservations',
  'operator-declared-ended',
] as const;
export type ReviewReservationReleaseEvidence = (typeof REVIEW_RESERVATION_RELEASE_EVIDENCE)[number];

/** The operator's release of a held reservation, as the Work view names it (refusals name it too). */
export const REVIEW_RESERVATION_RELEASE_ACTION = 'Declare the review ended';

/** Whether the attempt still blocks a new launch on its identity. */
export const holdsReviewReservation = (attempt: {
  readonly releasedAt: string | null;
  readonly state: ReviewAttemptState;
}): boolean => isLiveReviewAttemptState(attempt.state) || (attempt.state === 'lost' && attempt.releasedAt === null);

export const REVIEW_ATTEMPT_RESULT_KINDS = ['review', 'error', 'timeout'] as const;
export type ReviewAttemptResultKind = (typeof REVIEW_ATTEMPT_RESULT_KINDS)[number];
export const REVIEW_ATTEMPT_ACCEPTANCES = ['pending', 'accepted', 'rejected'] as const;
export type ReviewAttemptAcceptance = (typeof REVIEW_ATTEMPT_ACCEPTANCES)[number];

export const REVIEW_CHECKOUT_ORIGINS = ['desktop-worktree', 'desktop-cwd', 'served-session'] as const;
export type ReviewCheckoutOrigin = (typeof REVIEW_CHECKOUT_ORIGINS)[number];

/** The tools a launched review may have; the guarantee may name a subset, never another tool. */
export const REVIEW_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export type ReviewReadOnlyTool = (typeof REVIEW_READ_ONLY_TOOLS)[number];
/** Claude Code setting sources a launch could load (`--setting-sources`); managed policy is not one of them. */
export const REVIEW_SETTING_SOURCES = ['user', 'project', 'local'] as const;
export type ReviewSettingSource = (typeof REVIEW_SETTING_SOURCES)[number];

export const REVIEW_SCOPE_FILE_STATUSES = ['added', 'deleted', 'modified', 'renamed', 'copied'] as const;
export type ReviewScopeFileStatus = (typeof REVIEW_SCOPE_FILE_STATUSES)[number];
/** How much of one file's patch the review received: all of it, a prefix, none, or a binary notice only. */
export const REVIEW_SCOPE_FILE_COVERAGES = ['complete', 'partial', 'omitted', 'binary'] as const;
export type ReviewScopeFileCoverage = (typeof REVIEW_SCOPE_FILE_COVERAGES)[number];

/** Git's empty tree, the base of a root commit, per object format (SHA-1, SHA-256). */
export const GIT_EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const;

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
  /** Patch bytes the prompt carries; the rest is declared truncated, per file. Fits one argv element. */
  maxPatchPromptBytes: 64 * 1024,
  maxPatchPromptLines: 2000,
  /** Patch bytes read from git at all; a larger commit is refused rather than reviewed blind. */
  maxPatchReadBytes: 8 * 1024 * 1024,
  maxReviewTargets: 32,
  /** Files the stored scope lists; `fileCount` keeps the total. */
  maxScopeFiles: 64,
  /** Path of one listed file; a longer path is counted, not listed. */
  maxScopePath: 1024,
  /** `projectLabel`, `sessionTitle`, `label`, scope subject, CLI version. */
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

/** Legacy default used when no declaration can identify a refused attempt's executor. */
export const SUPPORTED_REVIEW_EXECUTOR: ExecutorHarness = 'claude-code';

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

/** One file of the reviewed commit and how much of its patch the review received. */
export interface ReviewScopeFile {
  readonly additions: number;
  readonly coverage: ReviewScopeFileCoverage;
  readonly deletions: number;
  /** Repository-relative path after the change (before it, for a deletion). */
  readonly path: string;
  /** The source of a rename or copy; `null` otherwise. */
  readonly previousPath: string | null;
  readonly status: ReviewScopeFileStatus;
}

/**
 * Exactly what a review was given (ADR 0055): one commit, resolved to a SHA before anything else
 * was read, compared with its first parent (or the empty tree for a root commit), and the bounded
 * prefix of its patch the prompt carried. A review never claims more than this: not a branch, not
 * a pull request, not the working tree.
 */
export interface ReviewAttemptScope {
  readonly base: 'empty-tree' | 'first-parent';
  readonly baseSha: string;
  /** Files the patch touches in total; `files` lists at most `maxScopeFiles` of them. */
  readonly fileCount: number;
  readonly files: readonly ReviewScopeFile[];
  readonly headSha: string;
  /** Bytes and lines of the patch prefix the prompt carried. */
  readonly includedBytes: number;
  readonly includedLines: number;
  readonly kind: 'commit';
  /** 0 for a root commit, 2 or more for a merge (compared with its first parent only). */
  readonly parentCount: number;
  readonly patchBytes: number;
  readonly patchLines: number;
  /** SHA-256 of the whole patch as git produced it; the prompt carried its first `includedBytes`. */
  readonly patchSha256: string;
  /** The checkout's path inside its repository (`git rev-parse --show-prefix`), `''` at the root. */
  readonly repositoryPrefix: string;
  readonly subject: string | null;
  readonly truncated: boolean;
  /** Tracked files differed from HEAD when the scope was prepared; file reads show the working tree. */
  readonly workingTreeDirty: boolean;
}

/**
 * What the launched harness was qualified for and configured with (ADR 0055), so the attempt says
 * which guarantee its "read-only" rests on. Read-only means: no repository write and no external
 * action by the review's tools. The harness still writes its own logs, and no OS sandbox is claimed.
 */
export interface ClaudeReviewHarnessGuarantee {
  /** Version `claude --version` answered before the launch. */
  readonly cliVersion: string;
  /** The `--effort` the launch passed; `null` when none was (the CLI default applied). */
  readonly effort: string | null;
  /**
   * A managed (policy) settings file on this machine: managed settings cannot be excluded per
   * invocation, so their hooks, if any, still run. Server-delivered policy is not observable here.
   */
  readonly managedSettings: 'absent' | 'present';
  /**
   * The `--model` the launch passed; `null` when none was (the CLI default applied). It is the
   * launched candidate's model, recorded with the scope so a result names what produced it.
   */
  readonly model: string | null;
  /** `--safe-mode`: plugins, skills, CLAUDE.md, hooks and MCP servers from any customization are off. */
  readonly safeMode: boolean;
  /** Setting sources the session loaded (`--setting-sources`); empty means none of user, project, local. */
  readonly settingSources: readonly ReviewSettingSource[];
  /** The only built-in tools the session had (`--tools`). */
  readonly tools: readonly ReviewReadOnlyTool[];
}

/** Codex controls are native app-server settings, never Claude safe-mode claims. */
export interface CodexReviewHarnessGuarantee {
  readonly accountFingerprint: string;
  readonly approvalPolicy: 'never';
  readonly cliVersion: string;
  readonly effort: string | null;
  readonly externalTools: 'disabled';
  readonly kind: 'codex-app-server';
  readonly managedPolicy: 'inherited';
  readonly model: string;
  readonly networkAccess: false;
  readonly sandbox: 'read-only';
}

export type ReviewHarnessGuarantee = ClaudeReviewHarnessGuarantee | CodexReviewHarnessGuarantee;

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
  /** The harness configuration the launch rested on; `null` before a launch or for a refusal. */
  readonly guarantee: ReviewHarnessGuarantee | null;
  readonly idempotencyKey: string;
  /**
   * The session id the engine chose and passed as `--session-id`, recorded before any spawn: the
   * launched process carries it in its argument vector, which identifies it where a pid cannot.
   */
  readonly launchSessionId: string | null;
  readonly machineId: string;
  /** The harness's own session id, read from its `system/init` message; the link to a later collected Session. */
  readonly nativeSessionId: string | null;
  readonly nativeTurnId: string | null;
  readonly numTurns: number | null;
  readonly pid: number | null;
  readonly releasedAt: string | null;
  /** Why a lost attempt stopped holding its reservation; `null` while it holds it, and for every other state. */
  readonly releaseEvidence: ReviewReservationReleaseEvidence | null;
  readonly requestedAt: string;
  readonly resultExcerpt: string | null;
  readonly resultKind: ReviewAttemptResultKind | null;
  /** What the review was given; `null` before the scope was prepared or when it could not be. */
  readonly scope: ReviewAttemptScope | null;
  readonly startedAt: string | null;
  readonly state: ReviewAttemptState;
  readonly stopConfirmedAt: string | null;
  readonly stopRequestedAt: string | null;
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
  'guarantee',
  'idempotencyKey',
  'launchSessionId',
  'machineId',
  'nativeSessionId',
  'nativeTurnId',
  'stopRequestedAt',
  'stopConfirmedAt',
  'numTurns',
  'pid',
  'releaseEvidence',
  'releasedAt',
  'requestedAt',
  'resultExcerpt',
  'resultKind',
  'scope',
  'startedAt',
  'state',
  'target',
  'updatedAt',
  'validations',
]);
const SCOPE_KEYS: ReadonlySet<string> = new Set([
  'base',
  'baseSha',
  'fileCount',
  'files',
  'headSha',
  'includedBytes',
  'includedLines',
  'kind',
  'parentCount',
  'patchBytes',
  'patchLines',
  'patchSha256',
  'repositoryPrefix',
  'subject',
  'truncated',
  'workingTreeDirty',
]);
const SCOPE_FILE_KEYS: ReadonlySet<string> = new Set([
  'additions',
  'coverage',
  'deletions',
  'path',
  'previousPath',
  'status',
]);
const GUARANTEE_KEYS: ReadonlySet<string> = new Set([
  'cliVersion',
  'effort',
  'managedSettings',
  'model',
  'safeMode',
  'settingSources',
  'tools',
]);
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
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

const isScopePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= REVIEW_ATTEMPT_BOUNDS.maxScopePath &&
  isPrintableSkillObservationText(value);

const parseScopeFile = (value: unknown): ReviewScopeFile | null => {
  if (!isRecord(value) || hasOnlyKeys(value, SCOPE_FILE_KEYS).length > 0) {
    return null;
  }
  const { additions, coverage, deletions, path, previousPath, status } = value;
  const moved = status === 'renamed' || status === 'copied';
  if (
    !(
      isNonNegativeInteger(additions) &&
      isNonNegativeInteger(deletions) &&
      isOneOf(REVIEW_SCOPE_FILE_COVERAGES, coverage) &&
      isOneOf(REVIEW_SCOPE_FILE_STATUSES, status) &&
      isScopePath(path) &&
      (moved ? isScopePath(previousPath) : previousPath === null)
    )
  ) {
    return null;
  }
  return { additions, coverage, deletions, path, previousPath: moved ? (previousPath as string) : null, status };
};

const isRepositoryPrefix = (value: unknown): value is string =>
  value === '' ||
  (typeof value === 'string' &&
    value.length <= REVIEW_ATTEMPT_BOUNDS.maxPath &&
    value.endsWith('/') &&
    !value.startsWith('/') &&
    isPrintableSkillObservationText(value) &&
    value
      .slice(0, -1)
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'));

/** Strict re-validation of a stored scope: one commit, consistent counts, a declared truncation that matches them. */
export const parseReviewAttemptScope = (value: unknown): ReviewAttemptScope | null => {
  if (!isRecord(value) || hasOnlyKeys(value, SCOPE_KEYS).length > 0 || value.kind !== 'commit') {
    return null;
  }
  const { base, baseSha, fileCount, headSha, includedBytes, includedLines, parentCount, patchBytes, patchLines } =
    value;
  if (
    !(
      typeof headSha === 'string' &&
      OBJECT_ID.test(headSha) &&
      typeof baseSha === 'string' &&
      OBJECT_ID.test(baseSha) &&
      baseSha.length === headSha.length &&
      isNonNegativeInteger(parentCount) &&
      isNonNegativeInteger(fileCount) &&
      isNonNegativeInteger(patchBytes) &&
      isNonNegativeInteger(patchLines) &&
      isNonNegativeInteger(includedBytes) &&
      isNonNegativeInteger(includedLines) &&
      includedBytes <= patchBytes &&
      includedLines <= patchLines &&
      typeof value.truncated === 'boolean' &&
      value.truncated === (includedBytes < patchBytes || includedLines < patchLines) &&
      typeof value.workingTreeDirty === 'boolean' &&
      typeof value.patchSha256 === 'string' &&
      SHA256_HEX.test(value.patchSha256) &&
      isRepositoryPrefix(value.repositoryPrefix) &&
      (value.subject === null || isBoundedText(value.subject, REVIEW_ATTEMPT_BOUNDS.maxText))
    )
  ) {
    return null;
  }
  const emptyTree = headSha.length === 40 ? GIT_EMPTY_TREE.sha1 : GIT_EMPTY_TREE.sha256;
  const baseConsistent =
    base === 'empty-tree' ? parentCount === 0 && baseSha === emptyTree : base === 'first-parent' && parentCount > 0;
  if (
    !(baseConsistent && Array.isArray(value.files)) ||
    value.files.length > REVIEW_ATTEMPT_BOUNDS.maxScopeFiles ||
    value.files.length > fileCount
  ) {
    return null;
  }
  const files: ReviewScopeFile[] = [];
  for (const entry of value.files) {
    const file = parseScopeFile(entry);
    if (file === null) {
      return null;
    }
    files.push(file);
  }
  return {
    base: base === 'empty-tree' ? 'empty-tree' : 'first-parent',
    baseSha,
    fileCount,
    files,
    headSha,
    includedBytes,
    includedLines,
    kind: 'commit',
    parentCount,
    patchBytes,
    patchLines,
    patchSha256: value.patchSha256,
    repositoryPrefix: value.repositoryPrefix,
    subject: value.subject,
    truncated: value.truncated,
    workingTreeDirty: value.workingTreeDirty,
  };
};

const isUniqueSubset = <const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number][] =>
  Array.isArray(value) &&
  value.every((entry) => isOneOf(values, entry)) &&
  new Set(value as readonly unknown[]).size === value.length;

/** Strict re-validation of a stored guarantee; a tool outside the read-only set is refused, not shown. */
export const parseReviewHarnessGuarantee = (value: unknown): ReviewHarnessGuarantee | null => {
  if (isRecord(value) && value.kind === 'codex-app-server') {
    const keys = new Set([
      'kind',
      'cliVersion',
      'model',
      'effort',
      'sandbox',
      'approvalPolicy',
      'networkAccess',
      'accountFingerprint',
      'externalTools',
      'managedPolicy',
    ]);
    if (
      hasOnlyKeys(value, keys).length > 0 ||
      !isBoundedText(value.cliVersion, 256) ||
      !isBoundedText(value.model, 256) ||
      !(value.effort === null || isBoundedText(value.effort, 256)) ||
      value.sandbox !== 'read-only' ||
      value.approvalPolicy !== 'never' ||
      value.networkAccess !== false ||
      typeof value.accountFingerprint !== 'string' ||
      !isExecutorAccountFingerprint(value.accountFingerprint) ||
      value.externalTools !== 'disabled' ||
      value.managedPolicy !== 'inherited'
    ) {
      return null;
    }
    return {
      kind: 'codex-app-server',
      cliVersion: value.cliVersion,
      model: value.model,
      effort: value.effort,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      networkAccess: false,
      accountFingerprint: value.accountFingerprint,
      externalTools: 'disabled',
      managedPolicy: 'inherited',
    };
  }
  if (!isRecord(value) || hasOnlyKeys(value, GUARANTEE_KEYS).length > 0) {
    return null;
  }
  const { cliVersion, effort, managedSettings, model, safeMode, settingSources, tools } = value;
  if (
    !(
      isBoundedText(cliVersion, REVIEW_ATTEMPT_BOUNDS.maxText) &&
      (effort === null || isBoundedText(effort, REVIEW_ATTEMPT_BOUNDS.maxText)) &&
      (model === null || isBoundedText(model, REVIEW_ATTEMPT_BOUNDS.maxText)) &&
      (managedSettings === 'absent' || managedSettings === 'present') &&
      typeof safeMode === 'boolean' &&
      isUniqueSubset(REVIEW_SETTING_SOURCES, settingSources) &&
      isUniqueSubset(REVIEW_READ_ONLY_TOOLS, tools) &&
      tools.length > 0
    )
  ) {
    return null;
  }
  return {
    cliVersion,
    effort,
    managedSettings,
    model,
    safeMode,
    settingSources: [...settingSources],
    tools: [...tools],
  };
};

const optionalParsed = <Value>(value: unknown, parse: (input: unknown) => Value | null): Value | null | undefined => {
  if (value === null) {
    return null;
  }
  return parse(value) ?? undefined;
};

/**
 * Strict re-validation of one stored attempt. `declaration` is taken as given (the store re-parses
 * it with `parseExecutorDeclarations` before calling this), so only its presence is checked here.
 */
export const parseReviewAttempt = (value: unknown): ReviewAttempt | null => {
  if (!isRecord(value) || hasOnlyKeys(value, ATTEMPT_KEYS).length > 0) {
    return null;
  }
  const scope = optionalParsed(value.scope, parseReviewAttemptScope);
  const guarantee = optionalParsed(value.guarantee, parseReviewHarnessGuarantee);
  const releasedAt = optionalInstant(value.releasedAt);
  const releaseEvidence = optionalParsed(value.releaseEvidence, (input) =>
    isOneOf(REVIEW_RESERVATION_RELEASE_EVIDENCE, input) ? input : null,
  );
  const launchSessionId = optionalParsed(value.launchSessionId, (input) =>
    typeof input === 'string' && UUID.test(input) ? input : null,
  );
  if (
    scope === undefined ||
    guarantee === undefined ||
    releasedAt === undefined ||
    releaseEvidence === undefined ||
    launchSessionId === undefined ||
    (releasedAt === null) !== (releaseEvidence === null) ||
    (releasedAt !== null && value.state !== 'lost')
  ) {
    return null;
  }
  const target = parseAttemptTarget(value.target);
  const requestedAt = optionalInstant(value.requestedAt);
  const updatedAt = optionalInstant(value.updatedAt);
  const startedAt = optionalInstant(value.startedAt);
  const endedAt = optionalInstant(value.endedAt);
  const nativeSessionId = optionalId(value.nativeSessionId);
  const nativeTurnId = optionalId(value.nativeTurnId ?? null);
  const stopRequestedAt = optionalInstant(value.stopRequestedAt ?? null);
  const stopConfirmedAt = optionalInstant(value.stopConfirmedAt ?? null);
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
    nativeTurnId === undefined ||
    stopRequestedAt === undefined ||
    stopConfirmedAt === undefined ||
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
    guarantee,
    idempotencyKey: value.idempotencyKey,
    launchSessionId,
    machineId: value.machineId,
    nativeSessionId,
    nativeTurnId,
    stopRequestedAt,
    stopConfirmedAt,
    numTurns,
    pid,
    releaseEvidence,
    releasedAt,
    requestedAt,
    resultExcerpt,
    resultKind: value.resultKind,
    scope,
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
  /** A lost attempt on the target whose reservation the engine could not release with evidence. */
  readonly unresolvedAttempt: UnresolvedReviewReservation | null;
}

/**
 * A lost attempt that still holds its reservation, and what the engine found when it looked:
 * `process-running` when a process on this machine still carries the attempt's launch session id
 * (`pids` names them), `process-evidence-unavailable` when this machine offers no process listing
 * the engine can read, so the end of the process cannot be established.
 */
export interface UnresolvedReviewReservation {
  readonly attemptId: string;
  readonly evidence: 'process-evidence-unavailable' | 'process-running';
  readonly launchSessionId: string | null;
  /** When contact was recorded lost (`endedAt` of the lost row). */
  readonly lostAt: string | null;
  readonly pids: readonly number[];
}

/** The refusal text for a held reservation: what is unresolved, and the evidence that would release it. Bounded. */
export const describeUnresolvedReviewReservation = (reservation: UnresolvedReviewReservation): string => {
  const lost = `attempt ${reservation.attemptId} lost contact${reservation.lostAt === null ? '' : ` at ${reservation.lostAt}`}`;
  const marker =
    reservation.launchSessionId === null ? 'its launch marker' : `--session-id ${reservation.launchSessionId}`;
  let text: string;
  const declare = `If no such review is still running, use “${REVIEW_RESERVATION_RELEASE_ACTION}” on that attempt in the Work view: the release is recorded as your declaration, with its time; nothing is stopped or adopted, and the engine never assumes an end from age.`;
  if (reservation.evidence === 'process-running') {
    text = `${lost}, and a process carrying ${marker} still runs (pid ${reservation.pids.slice(0, 4).join(', ')}). The engine neither adopts nor stops a process it no longer owns: end that review in the harness; a review is accepted again once no process carries that marker.`;
  } else if (reservation.launchSessionId === null) {
    text = `${lost}, and no independently verifiable process marker is available for this harness, so its end cannot be established. ${declare}`;
  } else {
    text = `${lost}, and this machine offers no process listing the engine can read, so it cannot tell whether its harness process still runs. ${declare}`;
  }
  return text.slice(0, REVIEW_ATTEMPT_BOUNDS.maxFailureReason);
};

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

/**
 * Pure launch policy. Refusals are ordered from the most structural to the most transient so the
 * operator reads the fix that unblocks the next step: an attempt already live for the target, a
 * lost attempt whose reservation is unresolved, no declaration for the candidate, unqualified Codex
 * identity or model, a target outside `routing.reviewTargets`, an executor not observed available,
 * and finally a recommendation that is not `real` under the forced candidate.
 */
export const decideReviewLaunch = (input: ReviewLaunchDecisionInput): ReviewLaunchDecision => {
  if (input.otherLiveAttempt !== null) {
    return refusal(
      'attempt-already-live',
      `a review is already running (attempt ${input.otherLiveAttempt.attemptId}); wait for it to end`,
    );
  }
  if (input.unresolvedAttempt !== null) {
    return refusal('attempt-unresolved', describeUnresolvedReviewReservation(input.unresolvedAttempt));
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
  // An alternate-model candidate (ADR 0057) shares its declaration; the id names both.
  const declaration = declarationForReviewCandidate(input.declarations, input.candidateId)?.declaration;
  if (!(candidate && declaration) || candidate.provenance.authorization !== 'declared') {
    return refusal(
      'no-declaration',
      `candidate ${input.candidateId} is not a declared executor on machine ${input.target.machineId}`,
    );
  }
  if (candidate.harness === 'codex' && (candidate.identity?.state !== 'confirmed' || candidate.model === null)) {
    return refusal(
      'executor-unavailable',
      'Codex needs a confirmed account fingerprint and an explicit model before launch',
      candidate.qualificationActions,
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
      `the ${candidate.harness} CLI is not observed available on machine ${input.target.machineId} (${candidate.availability})`,
      candidate.qualificationActions,
    );
  }
  const result = simulateWorkReviewRouting({
    candidates,
    policy: {
      forcedCandidateId: input.candidateId,
      nearResetMinutes: 60,
      preferNearReset: false,
      preferredHarness: candidate.harness,
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
  /** The patch prefix the scope declares (`includedBytes`), prepared by the engine with git. */
  readonly patch: string;
  readonly scope: ReviewAttemptScope;
  readonly sessionTitle: string | null;
}

const promptLine = (value: string | null): string => {
  const trimmed = value?.replace(/\s+/gu, ' ').trim() ?? '';
  return trimmed.length === 0 ? 'unavailable' : trimmed.slice(0, REVIEW_ATTEMPT_BOUNDS.maxText);
};

const describeScopeFile = (file: ReviewScopeFile): string =>
  `- ${file.status} ${file.previousPath === null ? '' : `${file.previousPath} -> `}${file.path} (+${file.additions} -${file.deletions}, ${file.coverage})`;

/** Bytes of file listing the prompt carries at most; beside the 64 KiB patch the prompt stays far below 128 KiB. */
const PROMPT_FILE_LIST_BYTES = 16 * 1024;

export const REVIEW_PROMPT_INSTRUCTION =
  "List at most five findings on this commit's change with file:line, severity and a one-line failure scenario. If the patch is truncated, say which files you could not assess and that the review is partial. Do not modify files.";

/**
 * The prompt names one commit and carries its patch, so the review compares before and after
 * rather than reading current files. Never a transcript; the patch is the declared prefix only.
 */
export const buildReviewPrompt = (input: ReviewPromptInput): string => {
  const { scope } = input;
  const base =
    scope.base === 'empty-tree'
      ? `from the empty tree (a root commit) to ${scope.headSha}`
      : `from its first parent ${scope.baseSha} to ${scope.headSha}${scope.parentCount > 1 ? '; a merge commit, compared with its first parent only' : ''}`;
  // The listing is bounded on its own, so the whole prompt stays one argv element under 128 KiB.
  const listed: string[] = [];
  let listedBytes = 0;
  const encoder = new TextEncoder();
  for (const line of scope.files.map(describeScopeFile)) {
    const bytes = encoder.encode(line).byteLength + 1;
    if (listedBytes + bytes > PROMPT_FILE_LIST_BYTES) {
      break;
    }
    listed.push(line);
    listedBytes += bytes;
  }
  const unlisted = scope.fileCount - listed.length;
  return [
    `Read-only review of one commit, ${scope.headSha} ("${promptLine(scope.subject)}"), in this checkout.`,
    `Scope: the change ${base}. This is one revision, not a pull request or a branch.`,
    scope.truncated
      ? `The patch is truncated: ${scope.includedBytes} of ${scope.patchBytes} bytes, ${scope.includedLines} of ${scope.patchLines} lines. Files marked partial or omitted below were not fully shown.`
      : `The patch is complete: ${scope.patchBytes} bytes, ${scope.patchLines} lines, ${scope.fileCount} files.`,
    `Patch paths are relative to the repository root; this checkout is ${scope.repositoryPrefix === '' ? 'that root' : `the subdirectory ${scope.repositoryPrefix} of that repository`}.`,
    scope.workingTreeDirty
      ? 'The working tree has uncommitted changes to tracked files: a file you Read shows the working tree, which may differ from this commit.'
      : 'A file you Read shows the working tree at the time you read it.',
    `Target session: ${promptLine(input.sessionTitle)}`,
    'Files:',
    ...listed,
    ...(unlisted > 0 ? [`- and ${unlisted} more files not listed`] : []),
    '',
    REVIEW_PROMPT_INSTRUCTION,
    '',
    `<<<patch sha256=${scope.patchSha256}`,
    `${input.patch}>>>end of patch`,
  ].join('\n');
};

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
