import { isRecord } from './datasets';
import { normalizeIsoTimestamp } from './provider-status';
import { isPrintableSkillObservationText } from './skill-observation';

/**
 * Review executors: the declared and observed facts that qualify a local harness for a read-only
 * review, kept apart on purpose (campaign contracts, "Routage"):
 *
 * - A **declaration** is what the operator wrote once in `~/.config/ai-usage/config.json` under
 *   `routing.executors[]`: which account on which machine may run which action, under which billing.
 *   It is dated by `declaredAt` and is the only source of authorization. A quota never authorizes.
 * - An **executor observation** is what the engine saw on a machine at a time: a binary on the
 *   PATH, its version, and the sign-in state a non-interactive CLI command reports. It never reads a
 *   credential file and never generates anything.
 * - Quota stays where it already is (provider-status, ADR 0045); this module does not restate it.
 *
 * Both parsers are strict and re-run on the way out of storage, so a tightened bound hides rows
 * already persisted. Raising a bound is safe.
 */
export const EXECUTOR_HARNESSES = ['claude-code', 'codex'] as const;
export type ExecutorHarness = (typeof EXECUTOR_HARNESSES)[number];
export const EXECUTOR_AUTHORIZATIONS = ['allowed', 'forbidden'] as const;
export type ExecutorAuthorization = (typeof EXECUTOR_AUTHORIZATIONS)[number];
export const EXECUTOR_SUBSCRIPTIONS = ['verified', 'api'] as const;
export type ExecutorSubscription = (typeof EXECUTOR_SUBSCRIPTIONS)[number];
export const EXECUTOR_CAPABILITIES = ['read-only-review'] as const;
export type ExecutorCapability = (typeof EXECUTOR_CAPABILITIES)[number];
export const EXECUTOR_QUALITIES = ['review-capable'] as const;
export type ExecutorQuality = (typeof EXECUTOR_QUALITIES)[number];
export const EXECUTOR_AUTH_STATES = ['logged-in', 'logged-out', 'unknown'] as const;
export type ExecutorAuthState = (typeof EXECUTOR_AUTH_STATES)[number];
export const EXECUTOR_OBSERVATION_OUTCOMES = ['observed', 'unavailable', 'timeout', 'invalid'] as const;
export type ExecutorObservationOutcome = (typeof EXECUTOR_OBSERVATION_OUTCOMES)[number];

export const EXECUTOR_BOUNDS = {
  /** `authMethod`: the sign-in method word a CLI reports ("claude.ai", "console", "api-key"). */
  maxAuthMethod: 64,
  /** Entries accepted from `routing.executors[]`; later entries are reported, not read. */
  maxDeclarations: 64,
  /** Latest observations a reader returns (one per machine and harness is the realistic ceiling). */
  maxObservations: 64,
  /** `binaryPath`. */
  maxPath: 4096,
  /** Observations retained per machine and harness. */
  maxRetainedPerExecutor: 10,
  /** `accountScope`, `machineId`. */
  maxScope: 256,
  /** Declared targets per entry. */
  maxTargets: 32,
  /** `model`, `effort`, `projectLabel`, `version`, `authEvidence`. */
  maxText: 256,
} as const;

/** The cadence of the `executors.capabilities` source; freshness is judged against it. */
export const EXECUTOR_CAPABILITIES_CADENCE_MS = 15 * 60_000;

export type ExecutorDeclaredTarget =
  | { readonly kind: 'any-local-session' }
  | { readonly kind: 'project'; readonly projectLabel: string };

export interface ExecutorDeclaration {
  /** The account suffix of the quota key (`claude:<accountScope>`), or the operator's name for the account. */
  readonly accountScope: string;
  readonly authorization: ExecutorAuthorization;
  readonly capabilities: readonly ExecutorCapability[];
  /** Canonical ISO instant; the declaration is a dated statement, never a current observation. */
  readonly declaredAt: string;
  readonly effort: string | null;
  readonly harness: ExecutorHarness;
  readonly machineId: string;
  readonly model: string | null;
  readonly quality: ExecutorQuality;
  readonly subscription: ExecutorSubscription;
  readonly targets: readonly ExecutorDeclaredTarget[];
}

/** The documented shape of one `routing.executors[]` entry as the operator writes it. */
export interface ExecutorDeclarationInput {
  readonly accountScope: string;
  readonly authorization: ExecutorAuthorization;
  readonly capabilities: readonly ExecutorCapability[];
  readonly declaredAt: string;
  readonly effort?: string | null;
  readonly harness: ExecutorHarness;
  /** Defaults to this machine (`~/.config/ai-usage/machine.json`). */
  readonly machineId?: string;
  readonly model?: string | null;
  readonly quality: ExecutorQuality;
  readonly subscription: ExecutorSubscription;
  readonly targets: readonly ExecutorDeclaredTarget[];
}

/**
 * The `routing` section of the home config. Entries are `unknown` on purpose: one invalid entry is
 * reported by `parseExecutorDeclarations` and must not make the whole configuration unreadable.
 */
export interface RoutingConfig {
  readonly executors: readonly unknown[];
}

export interface ExecutorDeclarationIssue {
  /** Config path such as `routing.executors[2].targets[0].kind`; never the offending value. */
  readonly path: string;
  readonly reason: string;
}

export interface ExecutorDeclarationParseResult {
  readonly declarations: readonly ExecutorDeclaration[];
  readonly issues: readonly ExecutorDeclarationIssue[];
}

export interface ParseExecutorDeclarationsOptions {
  /** This machine's identity; `null` when none is known, in which case `machineId` becomes required. */
  readonly defaultMachineId: string | null;
  readonly path?: string;
}

export interface ExecutorObservation {
  /** How the sign-in state was established, bounded and credential-free (for example "codex login status exit 0"). */
  readonly authEvidence: string;
  /**
   * The sign-in method as the CLI names it ("claude.ai", "console", "api-key"), or `null` when it
   * named none. An API-key method contradicts a declared subscription; see `work-routing.ts`.
   */
  readonly authMethod: string | null;
  readonly authState: ExecutorAuthState;
  readonly binaryPath: string | null;
  readonly harness: ExecutorHarness;
  readonly machineId: string;
  readonly observedAt: string;
  readonly outcome: ExecutorObservationOutcome;
  readonly version: string | null;
}

const DECLARATION_KEYS: ReadonlySet<string> = new Set([
  'accountScope',
  'authorization',
  'capabilities',
  'declaredAt',
  'effort',
  'harness',
  'machineId',
  'model',
  'quality',
  'subscription',
  'targets',
]);
const OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  'authEvidence',
  'authMethod',
  'authState',
  'binaryPath',
  'harness',
  'machineId',
  'observedAt',
  'outcome',
  'version',
]);

const isOneOf = <const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** Any RFC 3339 date-time prefix; the full value is then validated by `normalizeIsoTimestamp`. */
const DATE_TIME_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

// Reuses the repository's one definition of "renderable as text" (no C0/C1 control characters).
const isBoundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  isPrintableSkillObservationText(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): string[] =>
  Object.keys(record).filter((key) => !keys.has(key));

export const isExecutorHarness = (value: unknown): value is ExecutorHarness => isOneOf(EXECUTOR_HARNESSES, value);

/** The provider family a harness bills against; the first segment of its quota key. */
export const executorHarnessFamily = (harness: ExecutorHarness): 'claude' | 'codex' =>
  harness === 'claude-code' ? 'claude' : 'codex';

export const executorHarnessForFamily = (family: string): ExecutorHarness | null => {
  if (family === 'claude') {
    return 'claude-code';
  }
  return family === 'codex' ? 'codex' : null;
};

export const executorDeclarationKey = (
  declaration: Pick<ExecutorDeclaration, 'accountScope' | 'harness' | 'machineId'>,
): string => JSON.stringify([declaration.machineId, declaration.harness, declaration.accountScope]);

/** The config section must be an object whose only key is an `executors` array; entries are checked later. */
export const isRoutingConfigShape = (value: unknown): value is RoutingConfig =>
  isRecord(value) && hasOnlyKeys(value, new Set(['executors'])).length === 0 && Array.isArray(value.executors);

const parseDeclaredAt = (value: unknown): string | null => {
  // Operators write this by hand, so any RFC 3339 date-time is accepted and stored canonically;
  // a bare date, a number or a relative word is not a declaration time.
  if (typeof value !== 'string' || !DATE_TIME_PREFIX_PATTERN.test(value)) {
    return null;
  }
  return normalizeIsoTimestamp(value);
};

const parseTarget = (
  value: unknown,
  path: string,
  issues: ExecutorDeclarationIssue[],
): ExecutorDeclaredTarget | null => {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object with a kind' });
    return null;
  }
  if (value.kind === 'any-local-session') {
    const extra = hasOnlyKeys(value, new Set(['kind']));
    if (extra.length > 0) {
      issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
      return null;
    }
    return { kind: 'any-local-session' };
  }
  if (value.kind === 'project') {
    const extra = hasOnlyKeys(value, new Set(['kind', 'projectLabel']));
    if (extra.length > 0) {
      issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
      return null;
    }
    if (!isBoundedText(value.projectLabel, EXECUTOR_BOUNDS.maxText)) {
      issues.push({
        path: `${path}.projectLabel`,
        reason: `must be a non-empty string of at most ${EXECUTOR_BOUNDS.maxText} characters`,
      });
      return null;
    }
    return { kind: 'project', projectLabel: value.projectLabel };
  }
  issues.push({ path: `${path}.kind`, reason: "must be 'any-local-session' or 'project'" });
  return null;
};

const parseTargets = (
  value: unknown,
  path: string,
  issues: ExecutorDeclarationIssue[],
): ExecutorDeclaredTarget[] | null => {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, reason: 'must be a non-empty array of targets' });
    return null;
  }
  if (value.length > EXECUTOR_BOUNDS.maxTargets) {
    issues.push({ path, reason: `must declare at most ${EXECUTOR_BOUNDS.maxTargets} targets` });
    return null;
  }
  const targets: ExecutorDeclaredTarget[] = [];
  for (const [index, entry] of value.entries()) {
    const target = parseTarget(entry, `${path}[${index}]`, issues);
    if (target) {
      targets.push(target);
    }
  }
  return targets.length === value.length ? targets : null;
};

const parseCapabilities = (
  value: unknown,
  path: string,
  issues: ExecutorDeclarationIssue[],
): ExecutorCapability[] | null => {
  if (!Array.isArray(value)) {
    issues.push({ path, reason: "must be an array of capabilities ('read-only-review')" });
    return null;
  }
  const capabilities: ExecutorCapability[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isOneOf(EXECUTOR_CAPABILITIES, entry)) {
      issues.push({ path: `${path}[${index}]`, reason: "must be 'read-only-review'" });
      return null;
    }
    if (!capabilities.includes(entry)) {
      capabilities.push(entry);
    }
  }
  return capabilities;
};

const parseOptionalText = (
  value: unknown,
  path: string,
  issues: ExecutorDeclarationIssue[],
): { readonly ok: boolean; readonly value: string | null } => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (!isBoundedText(value, EXECUTOR_BOUNDS.maxText)) {
    issues.push({ path, reason: `must be a non-empty string of at most ${EXECUTOR_BOUNDS.maxText} characters` });
    return { ok: false, value: null };
  }
  return { ok: true, value };
};

const parseDeclaration = (
  value: unknown,
  path: string,
  defaultMachineId: string | null,
  issues: ExecutorDeclarationIssue[],
): ExecutorDeclaration | null => {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return null;
  }
  const before = issues.length;
  const extra = hasOnlyKeys(value, DECLARATION_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
  }
  if (!isExecutorHarness(value.harness)) {
    issues.push({ path: `${path}.harness`, reason: "must be 'claude-code' or 'codex'" });
  }
  if (!isBoundedText(value.accountScope, EXECUTOR_BOUNDS.maxScope)) {
    issues.push({
      path: `${path}.accountScope`,
      reason: `must be a non-empty string of at most ${EXECUTOR_BOUNDS.maxScope} characters`,
    });
  }
  let machineId: string | null = null;
  if (value.machineId === undefined) {
    machineId = defaultMachineId;
    if (machineId === null) {
      issues.push({ path: `${path}.machineId`, reason: 'is required because no local machine identity is known' });
    }
  } else if (isBoundedText(value.machineId, EXECUTOR_BOUNDS.maxScope)) {
    machineId = value.machineId;
  } else {
    issues.push({
      path: `${path}.machineId`,
      reason: `must be a non-empty string of at most ${EXECUTOR_BOUNDS.maxScope} characters`,
    });
  }
  if (!isOneOf(EXECUTOR_AUTHORIZATIONS, value.authorization)) {
    issues.push({ path: `${path}.authorization`, reason: "must be 'allowed' or 'forbidden'" });
  }
  const targets = parseTargets(value.targets, `${path}.targets`, issues);
  if (!isOneOf(EXECUTOR_SUBSCRIPTIONS, value.subscription)) {
    issues.push({ path: `${path}.subscription`, reason: "must be 'verified' or 'api'" });
  }
  const capabilities = parseCapabilities(value.capabilities, `${path}.capabilities`, issues);
  if (!isOneOf(EXECUTOR_QUALITIES, value.quality)) {
    issues.push({ path: `${path}.quality`, reason: "must be 'review-capable'" });
  }
  const model = parseOptionalText(value.model, `${path}.model`, issues);
  const effort = parseOptionalText(value.effort, `${path}.effort`, issues);
  const declaredAt = parseDeclaredAt(value.declaredAt);
  if (declaredAt === null) {
    issues.push({ path: `${path}.declaredAt`, reason: 'is required and must be an RFC 3339 date-time' });
  }
  if (
    issues.length > before ||
    !isExecutorHarness(value.harness) ||
    typeof value.accountScope !== 'string' ||
    machineId === null ||
    !isOneOf(EXECUTOR_AUTHORIZATIONS, value.authorization) ||
    targets === null ||
    !isOneOf(EXECUTOR_SUBSCRIPTIONS, value.subscription) ||
    capabilities === null ||
    !isOneOf(EXECUTOR_QUALITIES, value.quality) ||
    declaredAt === null
  ) {
    return null;
  }
  return {
    accountScope: value.accountScope,
    authorization: value.authorization,
    capabilities,
    declaredAt,
    effort: effort.value,
    harness: value.harness,
    machineId,
    model: model.value,
    quality: value.quality,
    subscription: value.subscription,
    targets,
  };
};

/**
 * Strict per-entry parsing of `routing.executors[]`. An invalid entry is reported with its config
 * path and reason and does not invalidate its neighbours; duplicates of one (machine, harness,
 * account) keep the first entry and report the rest.
 */
export const parseExecutorDeclarations = (
  value: unknown,
  options: ParseExecutorDeclarationsOptions,
): ExecutorDeclarationParseResult => {
  const path = options.path ?? 'routing';
  if (value === undefined) {
    return { declarations: [], issues: [] };
  }
  if (!isRoutingConfigShape(value)) {
    return { declarations: [], issues: [{ path, reason: 'must be an object whose only key is an executors array' }] };
  }
  const issues: ExecutorDeclarationIssue[] = [];
  const declarations: ExecutorDeclaration[] = [];
  const seen = new Map<string, number>();
  for (const [index, entry] of value.executors.entries()) {
    const entryPath = `${path}.executors[${index}]`;
    if (index >= EXECUTOR_BOUNDS.maxDeclarations) {
      issues.push({ path: entryPath, reason: `exceeds the ${EXECUTOR_BOUNDS.maxDeclarations}-entry bound; ignored` });
      continue;
    }
    const declaration = parseDeclaration(entry, entryPath, options.defaultMachineId, issues);
    if (!declaration) {
      continue;
    }
    const key = executorDeclarationKey(declaration);
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({
        path: entryPath,
        reason: `duplicates executors[${previous}] (same machineId, harness and accountScope); ignored`,
      });
      continue;
    }
    seen.set(key, index);
    declarations.push(declaration);
  }
  return { declarations, issues };
};

const API_KEY_AUTH_METHODS: ReadonlySet<string> = new Set(['api-key', 'apikey', 'console']);

/**
 * Whether a sign-in method word means the CLI bills an API key rather than a subscription: the
 * known words, or any method naming the API. `null` (no method reported) means nothing.
 */
export const executorAuthMethodIndicatesApiKey = (authMethod: string | null): boolean => {
  if (authMethod === null) {
    return false;
  }
  const method = authMethod.trim().toLowerCase();
  return API_KEY_AUTH_METHODS.has(method) || method.includes('api');
};

/** Strict re-validation of one stored or collected executor observation. */
export const parseExecutorObservation = (value: unknown): ExecutorObservation | null => {
  if (!isRecord(value) || hasOnlyKeys(value, OBSERVATION_KEYS).length > 0) {
    return null;
  }
  const observedAt = normalizeIsoTimestamp(value.observedAt);
  // Rows and collectors from before the field carry no `authMethod`; absent reads as null.
  const authMethod = value.authMethod === undefined ? null : value.authMethod;
  if (
    !(isExecutorHarness(value.harness) && isBoundedText(value.machineId, EXECUTOR_BOUNDS.maxScope)) ||
    typeof value.observedAt !== 'string' ||
    observedAt === null ||
    !isOneOf(EXECUTOR_AUTH_STATES, value.authState) ||
    !isOneOf(EXECUTOR_OBSERVATION_OUTCOMES, value.outcome) ||
    !isBoundedText(value.authEvidence, EXECUTOR_BOUNDS.maxText) ||
    !(authMethod === null || isBoundedText(authMethod, EXECUTOR_BOUNDS.maxAuthMethod)) ||
    !(value.binaryPath === null || isBoundedText(value.binaryPath, EXECUTOR_BOUNDS.maxPath)) ||
    !(value.version === null || isBoundedText(value.version, EXECUTOR_BOUNDS.maxText))
  ) {
    return null;
  }
  return {
    authEvidence: value.authEvidence,
    authMethod,
    authState: value.authState,
    binaryPath: value.binaryPath,
    harness: value.harness,
    machineId: value.machineId,
    observedAt,
    outcome: value.outcome,
    version: value.version,
  };
};
