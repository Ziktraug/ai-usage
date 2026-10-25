import { isRecord } from './datasets';
import type {
  DelegationAppliedRule,
  DelegationCheckoutFacts,
  DelegationConfig,
  DelegationConfigIssue,
  DelegationDefaults,
  DelegationModelEntry,
  DelegationPreferences,
  DelegationRequirements,
  DelegationRouteAnnotation,
  DelegationRouteRequirements,
  DelegationRouteSelector,
  DelegationRule,
  DelegationRuleMatch,
} from './delegation-contracts';
import { canonicalJson, sha256Hex } from './delegation-request';
import {
  DELEGATION_CONTEXTS,
  DELEGATION_EXECUTOR_HARNESSES,
  DELEGATION_IDENTITY_EVIDENCE,
  DELEGATION_PROVIDERS,
  DELEGATION_RULE_EFFECTS,
  DELEGATION_TASK_CATEGORIES,
  type DelegationContext,
  type DelegationExecutorHarness,
  type DelegationIdentityEvidence,
  type DelegationProvider,
  type DelegationRouteBlocker,
} from './delegation-vocabulary';
import { normalizeIsoTimestamp } from './provider-status';
import { isPrintableSkillObservationText } from './skill-observation';
import { normalizeCheckoutPath } from './work-attempts';

/**
 * The operator's delegation policy: the home `delegation` config section parsed tolerantly (one
 * bad entry never hides its neighbours), the rules evaluated against a checkout's facts, and the
 * policy applied to one route. Rules fail closed: a condition whose fact is unknown is assumed to
 * hold and reported as an assumption. Preferences order and annotate; they never re-admit.
 */

export const DELEGATION_CONFIG_BOUNDS = {
  maxListEntries: 16,
  /** `description`, `note`. */
  maxLongText: 500,
  maxModels: 64,
  /** Largest reset horizon a preference may name, in minutes (one week). */
  maxNearResetMinutes: 7 * 24 * 60,
  maxRoutes: 64,
  maxRules: 64,
  /** `accountScope`, `machineId`, `label`, `nativeId`, `alias`, `resolvedVersion`, match values. */
  maxText: 256,
  range: {
    maxAttempts: { max: 5, min: 1 },
    maxConcurrent: { max: 8, min: 1 },
    qualificationTtlSeconds: { max: 3600, min: 60 },
    reservePercent: { max: 90, min: 0 },
  },
} as const;

export const DELEGATION_RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const DEFAULT_DELEGATION_DEFAULTS: DelegationDefaults = {
  identityEvidence: 'declared',
  maxAttempts: 2,
  maxConcurrentPerPool: 1,
  qualificationTtlSeconds: 600,
  reservePercent: 20,
};

export const EMPTY_DELEGATION_PREFERENCES: DelegationPreferences = {
  harnesses: [],
  models: [],
  nearResetMinutes: null,
};

/** What an absent `delegation` section means: every default, no route, no rule, no catalog. */
export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  defaults: DEFAULT_DELEGATION_DEFAULTS,
  models: [],
  preferences: EMPTY_DELEGATION_PREFERENCES,
  routes: [],
  rules: [],
};

export interface ParseDelegationConfigOptions {
  /** This machine's identity; `null` when none is known, in which case a route's `machineId` is required. */
  readonly defaultMachineId: string | null;
  readonly path?: string;
}

export interface DelegationConfigParseResult {
  readonly config: DelegationConfig;
  readonly issues: readonly DelegationConfigIssue[];
}

const CONFIG_KEYS: ReadonlySet<string> = new Set(['defaults', 'models', 'preferences', 'routes', 'rules']);
const DEFAULTS_KEYS: ReadonlySet<string> = new Set([
  'identityEvidence',
  'maxAttempts',
  'maxConcurrentPerPool',
  'qualificationTtlSeconds',
  'reservePercent',
]);
const ROUTE_KEYS: ReadonlySet<string> = new Set([
  'accountScope',
  'context',
  'harness',
  'label',
  'machineId',
  'maxConcurrent',
  'reservePercent',
]);
const RULE_KEYS: ReadonlySet<string> = new Set(['description', 'effect', 'id', 'match', 'require', 'routes']);
const MATCH_KEYS: ReadonlySet<string> = new Set([
  'checkoutPath',
  'gitAuthorEmail',
  'githubAccount',
  'githubOwner',
  'repository',
]);
const SELECTOR_KEYS: ReadonlySet<string> = new Set(['accountScopes', 'contexts', 'harnesses', 'providers']);
const REQUIRE_KEYS: ReadonlySet<string> = new Set([
  'identityEvidence',
  'maxAttempts',
  'maxConcurrent',
  'reservePercent',
]);
const PREFERENCES_KEYS: ReadonlySet<string> = new Set(['harnesses', 'models', 'nearResetMinutes']);
const MODEL_KEYS: ReadonlySet<string> = new Set([
  'alias',
  'declaredAt',
  'discouragedFor',
  'harnesses',
  'id',
  'nativeId',
  'note',
  'provider',
  'recommendedFor',
  'resolvedVersion',
]);
/** `owner/name`: two non-blank segments without whitespace or further slashes. */
const REPOSITORY_PATTERN = /^[^\s/]+\/[^\s/]+$/u;
const DATE_TIME_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

const isOneOf = <const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isBoundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  isPrintableSkillObservationText(value);

const textReason = (maximum: number): string => `must be a non-empty string of at most ${maximum} characters`;

const unknownKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): string[] =>
  Object.keys(record).filter((key) => !keys.has(key));

const quoted = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

/**
 * The section's shape: an object whose keys are the known sections, with arrays where lists are
 * expected and objects where maps are. Entries are checked later by `parseDelegationConfig`.
 */
export const isDelegationConfigShape = (value: unknown): boolean =>
  isRecord(value) &&
  unknownKeys(value, CONFIG_KEYS).length === 0 &&
  (value.routes === undefined || Array.isArray(value.routes)) &&
  (value.rules === undefined || Array.isArray(value.rules)) &&
  (value.models === undefined || Array.isArray(value.models)) &&
  (value.defaults === undefined || isRecord(value.defaults)) &&
  (value.preferences === undefined || isRecord(value.preferences));

type Issues = DelegationConfigIssue[];

const parseInteger = (
  value: unknown,
  path: string,
  range: { readonly max: number; readonly min: number },
  issues: Issues,
): number | undefined => {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max) {
    return value;
  }
  issues.push({ path, reason: `must be an integer between ${range.min} and ${range.max}` });
};

const parsePercent = (value: unknown, path: string, issues: Issues): number | undefined => {
  if (value === undefined) {
    return;
  }
  const { max, min } = DELEGATION_CONFIG_BOUNDS.range.reservePercent;
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
    return value;
  }
  issues.push({ path, reason: `must be a number between ${min} and ${max}` });
};

const parseIdentityEvidence = (
  value: unknown,
  path: string,
  issues: Issues,
): DelegationIdentityEvidence | undefined => {
  if (value === undefined) {
    return;
  }
  if (isOneOf(DELEGATION_IDENTITY_EVIDENCE, value)) {
    return value;
  }
  issues.push({ path, reason: `must be ${quoted(DELEGATION_IDENTITY_EVIDENCE)}` });
};

const parseOptionalText = (
  value: unknown,
  path: string,
  maximum: number,
  issues: Issues,
): { readonly ok: boolean; readonly value: string | null } => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (!isBoundedText(value, maximum)) {
    issues.push({ path, reason: textReason(maximum) });
    return { ok: false, value: null };
  }
  return { ok: true, value };
};

const parseDeclaredAt = (value: unknown): string | null =>
  typeof value === 'string' && DATE_TIME_PREFIX_PATTERN.test(value) ? normalizeIsoTimestamp(value) : null;

/** A bounded list of distinct values; the length is judged before any element. */
const parseList = <Value>(
  value: unknown,
  path: string,
  issues: Issues,
  accept: (entry: unknown) => entry is Value,
  reason: string,
): readonly Value[] | null => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, reason: 'must be an array' });
    return null;
  }
  if (value.length > DELEGATION_CONFIG_BOUNDS.maxListEntries) {
    issues.push({ path, reason: `must list at most ${DELEGATION_CONFIG_BOUNDS.maxListEntries} entries` });
    return null;
  }
  const entries: Value[] = [];
  for (const [index, entry] of value.entries()) {
    if (!accept(entry)) {
      issues.push({ path: `${path}[${index}]`, reason });
      return null;
    }
    if (!entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries;
};

const isHarness = (value: unknown): value is DelegationExecutorHarness => isOneOf(DELEGATION_EXECUTOR_HARNESSES, value);
const isContext = (value: unknown): value is DelegationContext => isOneOf(DELEGATION_CONTEXTS, value);
const isProvider = (value: unknown): value is DelegationProvider => isOneOf(DELEGATION_PROVIDERS, value);
const isCategory = (value: unknown): value is (typeof DELEGATION_TASK_CATEGORIES)[number] =>
  isOneOf(DELEGATION_TASK_CATEGORIES, value);
const isShortText = (value: unknown): value is string => isBoundedText(value, DELEGATION_CONFIG_BOUNDS.maxText);

const parseDefaults = (value: unknown, path: string, issues: Issues): DelegationDefaults => {
  if (value === undefined) {
    return DEFAULT_DELEGATION_DEFAULTS;
  }
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return DEFAULT_DELEGATION_DEFAULTS;
  }
  const extra = unknownKeys(value, DEFAULTS_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
  }
  const { range } = DELEGATION_CONFIG_BOUNDS;
  return {
    identityEvidence:
      parseIdentityEvidence(value.identityEvidence, `${path}.identityEvidence`, issues) ??
      DEFAULT_DELEGATION_DEFAULTS.identityEvidence,
    maxAttempts:
      parseInteger(value.maxAttempts, `${path}.maxAttempts`, range.maxAttempts, issues) ??
      DEFAULT_DELEGATION_DEFAULTS.maxAttempts,
    maxConcurrentPerPool:
      parseInteger(value.maxConcurrentPerPool, `${path}.maxConcurrentPerPool`, range.maxConcurrent, issues) ??
      DEFAULT_DELEGATION_DEFAULTS.maxConcurrentPerPool,
    qualificationTtlSeconds:
      parseInteger(
        value.qualificationTtlSeconds,
        `${path}.qualificationTtlSeconds`,
        range.qualificationTtlSeconds,
        issues,
      ) ?? DEFAULT_DELEGATION_DEFAULTS.qualificationTtlSeconds,
    reservePercent:
      parsePercent(value.reservePercent, `${path}.reservePercent`, issues) ??
      DEFAULT_DELEGATION_DEFAULTS.reservePercent,
  };
};

const parseRoute = (
  value: unknown,
  path: string,
  defaultMachineId: string | null,
  issues: Issues,
): DelegationRouteAnnotation | null => {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return null;
  }
  const before = issues.length;
  const extra = unknownKeys(value, ROUTE_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
  }
  if (!isHarness(value.harness)) {
    issues.push({ path: `${path}.harness`, reason: `must be ${quoted(DELEGATION_EXECUTOR_HARNESSES)}` });
  }
  if (!isShortText(value.accountScope)) {
    issues.push({ path: `${path}.accountScope`, reason: textReason(DELEGATION_CONFIG_BOUNDS.maxText) });
  }
  if (!isContext(value.context)) {
    issues.push({ path: `${path}.context`, reason: `must be ${quoted(DELEGATION_CONTEXTS)}` });
  }
  let machineId: string | null = null;
  if (value.machineId === undefined) {
    machineId = defaultMachineId;
    if (machineId === null) {
      issues.push({ path: `${path}.machineId`, reason: 'is required because no local machine identity is known' });
    }
  } else if (isShortText(value.machineId)) {
    machineId = value.machineId;
  } else {
    issues.push({ path: `${path}.machineId`, reason: textReason(DELEGATION_CONFIG_BOUNDS.maxText) });
  }
  const label = parseOptionalText(value.label, `${path}.label`, DELEGATION_CONFIG_BOUNDS.maxText, issues);
  const reservePercent = parsePercent(value.reservePercent, `${path}.reservePercent`, issues);
  const maxConcurrent = parseInteger(
    value.maxConcurrent,
    `${path}.maxConcurrent`,
    DELEGATION_CONFIG_BOUNDS.range.maxConcurrent,
    issues,
  );
  if (
    issues.length > before ||
    !isHarness(value.harness) ||
    !isShortText(value.accountScope) ||
    !isContext(value.context) ||
    machineId === null
  ) {
    return null;
  }
  return {
    accountScope: value.accountScope,
    context: value.context,
    harness: value.harness,
    ...(label.value === null ? {} : { label: label.value }),
    machineId,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(reservePercent === undefined ? {} : { reservePercent }),
  };
};

const parseMatch = (value: unknown, path: string, issues: Issues): DelegationRuleMatch | null => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object of match conditions' });
    return null;
  }
  const extra = unknownKeys(value, MATCH_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
    return null;
  }
  const before = issues.length;
  const match: { -readonly [Key in keyof DelegationRuleMatch]?: string } = {};
  if (value.checkoutPath !== undefined) {
    const checkoutPath = normalizeCheckoutPath(value.checkoutPath);
    if (checkoutPath === null) {
      issues.push({ path: `${path}.checkoutPath`, reason: 'must be an absolute path without . or .. segments' });
    } else {
      match.checkoutPath = checkoutPath;
    }
  }
  if (value.repository !== undefined) {
    if (isShortText(value.repository) && REPOSITORY_PATTERN.test(value.repository)) {
      match.repository = value.repository;
    } else {
      issues.push({ path: `${path}.repository`, reason: "must be 'owner/name'" });
    }
  }
  for (const key of ['gitAuthorEmail', 'githubAccount', 'githubOwner'] as const) {
    if (value[key] === undefined) {
      continue;
    }
    if (isShortText(value[key])) {
      match[key] = value[key];
    } else {
      issues.push({ path: `${path}.${key}`, reason: textReason(DELEGATION_CONFIG_BOUNDS.maxText) });
    }
  }
  return issues.length === before ? match : null;
};

const parseSelector = (value: unknown, path: string, issues: Issues): DelegationRouteSelector | null | undefined => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object of route selectors' });
    return null;
  }
  const extra = unknownKeys(value, SELECTOR_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
    return null;
  }
  const contexts = parseList(
    value.contexts,
    `${path}.contexts`,
    issues,
    isContext,
    `must be ${quoted(DELEGATION_CONTEXTS)}`,
  );
  const harnesses = parseList(
    value.harnesses,
    `${path}.harnesses`,
    issues,
    isHarness,
    `must be ${quoted(DELEGATION_EXECUTOR_HARNESSES)}`,
  );
  const accountScopes = parseList(
    value.accountScopes,
    `${path}.accountScopes`,
    issues,
    isShortText,
    textReason(DELEGATION_CONFIG_BOUNDS.maxText),
  );
  const providers = parseList(
    value.providers,
    `${path}.providers`,
    issues,
    isProvider,
    `must be ${quoted(DELEGATION_PROVIDERS)}`,
  );
  if (contexts === null || harnesses === null || accountScopes === null || providers === null) {
    return null;
  }
  return {
    ...(value.accountScopes === undefined ? {} : { accountScopes }),
    ...(value.contexts === undefined ? {} : { contexts }),
    ...(value.harnesses === undefined ? {} : { harnesses }),
    ...(value.providers === undefined ? {} : { providers }),
  };
};

const parseRequirements = (value: unknown, path: string, issues: Issues): DelegationRequirements | null | undefined => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object of requirements' });
    return null;
  }
  const extra = unknownKeys(value, REQUIRE_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
    return null;
  }
  const before = issues.length;
  const { range } = DELEGATION_CONFIG_BOUNDS;
  const identityEvidence = parseIdentityEvidence(value.identityEvidence, `${path}.identityEvidence`, issues);
  const reservePercent = parsePercent(value.reservePercent, `${path}.reservePercent`, issues);
  const maxConcurrent = parseInteger(value.maxConcurrent, `${path}.maxConcurrent`, range.maxConcurrent, issues);
  const maxAttempts = parseInteger(value.maxAttempts, `${path}.maxAttempts`, range.maxAttempts, issues);
  if (issues.length > before) {
    return null;
  }
  const requirements: { -readonly [Key in keyof DelegationRequirements]?: DelegationRequirements[Key] } = {};
  if (identityEvidence !== undefined) {
    requirements.identityEvidence = identityEvidence;
  }
  if (reservePercent !== undefined) {
    requirements.reservePercent = reservePercent;
  }
  if (maxConcurrent !== undefined) {
    requirements.maxConcurrent = maxConcurrent;
  }
  if (maxAttempts !== undefined) {
    requirements.maxAttempts = maxAttempts;
  }
  if (Object.keys(requirements).length === 0) {
    issues.push({
      path,
      reason: 'must require at least one of identityEvidence, reservePercent, maxConcurrent, maxAttempts',
    });
    return null;
  }
  return requirements;
};

const parseRule = (value: unknown, path: string, issues: Issues): DelegationRule | null => {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return null;
  }
  const before = issues.length;
  const extra = unknownKeys(value, RULE_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
  }
  if (!(typeof value.id === 'string' && DELEGATION_RULE_ID_PATTERN.test(value.id))) {
    issues.push({ path: `${path}.id`, reason: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' });
  }
  if (!isOneOf(DELEGATION_RULE_EFFECTS, value.effect)) {
    issues.push({ path: `${path}.effect`, reason: `must be ${quoted(DELEGATION_RULE_EFFECTS)}` });
  }
  const description = parseOptionalText(
    value.description,
    `${path}.description`,
    DELEGATION_CONFIG_BOUNDS.maxLongText,
    issues,
  );
  const match = parseMatch(value.match, `${path}.match`, issues);
  const routes = parseSelector(value.routes, `${path}.routes`, issues);
  const require = parseRequirements(value.require, `${path}.require`, issues);
  if (value.effect === 'require' && require === undefined) {
    issues.push({ path: `${path}.require`, reason: "is required for a 'require' rule" });
  } else if (value.effect !== 'require' && isOneOf(DELEGATION_RULE_EFFECTS, value.effect) && require !== undefined) {
    issues.push({ path: `${path}.require`, reason: "is only read on a 'require' rule" });
  }
  if (
    issues.length > before ||
    typeof value.id !== 'string' ||
    !isOneOf(DELEGATION_RULE_EFFECTS, value.effect) ||
    match === null ||
    routes === null ||
    require === null
  ) {
    return null;
  }
  return {
    ...(description.value === null ? {} : { description: description.value }),
    effect: value.effect,
    id: value.id,
    match,
    ...(require === undefined ? {} : { require }),
    ...(routes === undefined ? {} : { routes }),
  };
};

const parsePreferences = (value: unknown, path: string, issues: Issues): DelegationPreferences => {
  if (value === undefined) {
    return EMPTY_DELEGATION_PREFERENCES;
  }
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return EMPTY_DELEGATION_PREFERENCES;
  }
  const extra = unknownKeys(value, PREFERENCES_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
  }
  const models = parseList(
    value.models,
    `${path}.models`,
    issues,
    isShortText,
    textReason(DELEGATION_CONFIG_BOUNDS.maxText),
  );
  const harnesses = parseList(
    value.harnesses,
    `${path}.harnesses`,
    issues,
    isHarness,
    `must be ${quoted(DELEGATION_EXECUTOR_HARNESSES)}`,
  );
  let nearResetMinutes: number | null = null;
  if (value.nearResetMinutes !== undefined && value.nearResetMinutes !== null) {
    if (
      typeof value.nearResetMinutes === 'number' &&
      Number.isFinite(value.nearResetMinutes) &&
      value.nearResetMinutes > 0 &&
      value.nearResetMinutes <= DELEGATION_CONFIG_BOUNDS.maxNearResetMinutes
    ) {
      nearResetMinutes = value.nearResetMinutes;
    } else {
      issues.push({
        path: `${path}.nearResetMinutes`,
        reason: `must be null or a number of minutes between 0 (exclusive) and ${DELEGATION_CONFIG_BOUNDS.maxNearResetMinutes}`,
      });
    }
  }
  return { harnesses: harnesses ?? [], models: models ?? [], nearResetMinutes };
};

const parseModel = (value: unknown, path: string, issues: Issues): DelegationModelEntry | null => {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return null;
  }
  const before = issues.length;
  const extra = unknownKeys(value, MODEL_KEYS);
  if (extra.length > 0) {
    issues.push({ path, reason: `unknown field(s): ${extra.join(', ')}` });
  }
  if (!(typeof value.id === 'string' && DELEGATION_RULE_ID_PATTERN.test(value.id))) {
    issues.push({ path: `${path}.id`, reason: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' });
  }
  if (!isProvider(value.provider)) {
    issues.push({ path: `${path}.provider`, reason: `must be ${quoted(DELEGATION_PROVIDERS)}` });
  }
  if (!isShortText(value.nativeId)) {
    issues.push({ path: `${path}.nativeId`, reason: textReason(DELEGATION_CONFIG_BOUNDS.maxText) });
  }
  const alias = parseOptionalText(value.alias, `${path}.alias`, DELEGATION_CONFIG_BOUNDS.maxText, issues);
  const resolvedVersion = parseOptionalText(
    value.resolvedVersion,
    `${path}.resolvedVersion`,
    DELEGATION_CONFIG_BOUNDS.maxText,
    issues,
  );
  const note = parseOptionalText(value.note, `${path}.note`, DELEGATION_CONFIG_BOUNDS.maxLongText, issues);
  const harnesses = parseList(
    value.harnesses,
    `${path}.harnesses`,
    issues,
    isHarness,
    `must be ${quoted(DELEGATION_EXECUTOR_HARNESSES)}`,
  );
  const categoryReason = `must be ${quoted(DELEGATION_TASK_CATEGORIES)}`;
  const recommendedFor = parseList(value.recommendedFor, `${path}.recommendedFor`, issues, isCategory, categoryReason);
  const discouragedFor = parseList(value.discouragedFor, `${path}.discouragedFor`, issues, isCategory, categoryReason);
  if (recommendedFor && discouragedFor) {
    const both = recommendedFor.filter((category) => discouragedFor.includes(category));
    if (both.length > 0) {
      issues.push({ path: `${path}.discouragedFor`, reason: `repeats recommendedFor: ${both.join(', ')}` });
    }
  }
  const declaredAt = parseDeclaredAt(value.declaredAt);
  if (declaredAt === null) {
    issues.push({ path: `${path}.declaredAt`, reason: 'is required and must be an RFC 3339 date-time' });
  }
  if (
    issues.length > before ||
    typeof value.id !== 'string' ||
    !isProvider(value.provider) ||
    !isShortText(value.nativeId) ||
    harnesses === null ||
    recommendedFor === null ||
    discouragedFor === null ||
    declaredAt === null
  ) {
    return null;
  }
  return {
    alias: alias.value,
    declaredAt,
    discouragedFor,
    harnesses,
    id: value.id,
    nativeId: value.nativeId,
    note: note.value,
    provider: value.provider,
    recommendedFor,
    resolvedVersion: resolvedVersion.value,
  };
};

const routeAnnotationKey = (route: Pick<DelegationRouteAnnotation, 'accountScope' | 'harness' | 'machineId'>): string =>
  JSON.stringify([route.machineId ?? null, route.harness, route.accountScope]);

/** Walks a bounded list of entries, keeping valid, non-duplicate ones and locating every other. */
const parseEntries = <Entry>(
  value: unknown,
  path: string,
  maximum: number,
  issues: Issues,
  parse: (entry: unknown, entryPath: string) => Entry | null,
  keyOf: (entry: Entry) => string,
  duplicateReason: string,
): Entry[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, reason: 'must be an array' });
    return [];
  }
  const entries: Entry[] = [];
  const seen = new Map<string, number>();
  for (const [index, raw] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (index >= maximum) {
      issues.push({ path: entryPath, reason: `exceeds the ${maximum}-entry bound; ignored` });
      continue;
    }
    const entry = parse(raw, entryPath);
    if (entry === null) {
      continue;
    }
    const key = keyOf(entry);
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({
        path: entryPath,
        reason: `duplicates ${path.slice(path.lastIndexOf('.') + 1)}[${previous}] ${duplicateReason}; ignored`,
      });
      continue;
    }
    seen.set(key, index);
    entries.push(entry);
  }
  return entries;
};

/**
 * Tolerant per-entry parsing of the home `delegation` section. Absent means the defaults. An
 * invalid entry is located by config path and reason (never echoed) and does not hide its
 * neighbours; an invalid default field keeps its default value; duplicates keep the first entry.
 */
export const parseDelegationConfig = (
  value: unknown,
  options: ParseDelegationConfigOptions,
): DelegationConfigParseResult => {
  const path = options.path ?? 'delegation';
  if (value === undefined) {
    return { config: DEFAULT_DELEGATION_CONFIG, issues: [] };
  }
  if (!(isDelegationConfigShape(value) && isRecord(value))) {
    return {
      config: DEFAULT_DELEGATION_CONFIG,
      issues: [
        {
          path,
          reason:
            'must be an object with optional defaults and preferences objects and optional routes, rules and models arrays',
        },
      ],
    };
  }
  const issues: Issues = [];
  const defaults = parseDefaults(value.defaults, `${path}.defaults`, issues);
  const routes = parseEntries(
    value.routes,
    `${path}.routes`,
    DELEGATION_CONFIG_BOUNDS.maxRoutes,
    issues,
    (entry, entryPath) => parseRoute(entry, entryPath, options.defaultMachineId, issues),
    routeAnnotationKey,
    '(same machineId, harness and accountScope)',
  );
  const rules = parseEntries(
    value.rules,
    `${path}.rules`,
    DELEGATION_CONFIG_BOUNDS.maxRules,
    issues,
    (entry, entryPath) => parseRule(entry, entryPath, issues),
    (rule) => rule.id,
    '(same id)',
  );
  const preferences = parsePreferences(value.preferences, `${path}.preferences`, issues);
  const models = parseEntries(
    value.models,
    `${path}.models`,
    DELEGATION_CONFIG_BOUNDS.maxModels,
    issues,
    (entry, entryPath) => parseModel(entry, entryPath, issues),
    (model) => model.id,
    '(same id)',
  );
  return { config: { defaults, models, preferences, routes, rules }, issues };
};

// ---------------------------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------------------------

const REVISION_HEX_LENGTH = 16;

const shortDigest = async (value: unknown): Promise<string> =>
  (await sha256Hex(canonicalJson(value))).slice(0, REVISION_HEX_LENGTH);

/** The policy a qualification was decided under: the three config sections it reads, canonically. */
export const delegationPolicyRevision = (input: {
  readonly delegation: unknown;
  readonly github: unknown;
  readonly routing: unknown;
}): Promise<string> =>
  shortDigest({
    delegation: input.delegation ?? null,
    github: input.github ?? null,
    routing: input.routing ?? null,
  });

/** The operator's model catalog as declared; changes to it never invalidate a qualification. */
export const delegationCatalogRevision = (models: unknown): Promise<string> => shortDigest(models ?? null);

// ---------------------------------------------------------------------------------------------
// Rules against a checkout's facts
// ---------------------------------------------------------------------------------------------

export interface EvaluateDelegationRulesInput {
  /** Canonical checkout path, as the engine resolved it (always known). */
  readonly checkoutPath: string;
  readonly facts: DelegationCheckoutFacts;
  readonly rules: readonly DelegationRule[];
}

export interface EvaluatedDelegationRules {
  readonly applied: readonly DelegationAppliedRule[];
  /** One sentence per rule that applies only because a fact it needs is unknown. */
  readonly assumptions: readonly string[];
}

type ConditionOutcome = 'no' | 'unknown' | 'yes';

interface ConditionResult {
  readonly condition: string;
  readonly outcome: ConditionOutcome;
  readonly source: string | null;
}

const sameText = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const checkoutPathUnder = (checkoutPath: string, prefix: string): boolean =>
  checkoutPath === prefix || checkoutPath.startsWith(prefix === '/' ? '/' : `${prefix}/`);

const factCondition = <Value>(
  condition: string,
  fact: { readonly source: string; readonly value: Value | null },
  holds: (value: Value) => boolean,
): ConditionResult => {
  let outcome: ConditionOutcome = 'unknown';
  if (fact.value !== null) {
    outcome = holds(fact.value) ? 'yes' : 'no';
  }
  return { condition, outcome, source: fact.source };
};

const ruleConditions = (rule: DelegationRule, input: EvaluateDelegationRulesInput): ConditionResult[] => {
  const { match } = rule;
  const results: ConditionResult[] = [];
  if (match.checkoutPath !== undefined) {
    results.push({
      condition: `checkoutPath under ${match.checkoutPath}`,
      outcome: checkoutPathUnder(input.checkoutPath, match.checkoutPath) ? 'yes' : 'no',
      source: null,
    });
  }
  if (match.repository !== undefined) {
    const repository = match.repository;
    results.push(
      factCondition(`repository ${repository}`, input.facts.repositories, (values) =>
        values.some((value) => sameText(value, repository)),
      ),
    );
  }
  if (match.githubOwner !== undefined) {
    const owner = match.githubOwner;
    results.push(
      factCondition(`githubOwner ${owner}`, input.facts.githubOwners, (values) =>
        values.some((value) => sameText(value, owner)),
      ),
    );
  }
  if (match.githubAccount !== undefined) {
    const account = match.githubAccount;
    results.push(
      factCondition(`githubAccount ${account}`, input.facts.githubAccount, (value) => sameText(value, account)),
    );
  }
  if (match.gitAuthorEmail !== undefined) {
    const email = match.gitAuthorEmail;
    results.push(
      factCondition(`gitAuthorEmail ${email}`, input.facts.gitAuthorEmail, (value) => sameText(value, email)),
    );
  }
  return results;
};

/**
 * Which rules apply to this checkout. Every given condition must hold; a rule without conditions
 * applies everywhere. A condition whose fact is unknown does not defeat the rule: the rule is
 * assumed to apply (fail closed) and the assumption is reported in words.
 */
export const evaluateDelegationRules = (input: EvaluateDelegationRulesInput): EvaluatedDelegationRules => {
  const applied: DelegationAppliedRule[] = [];
  const assumptions: string[] = [];
  for (const rule of input.rules) {
    const conditions = ruleConditions(rule, input);
    if (conditions.some((condition) => condition.outcome === 'no')) {
      continue;
    }
    const unknown = conditions.filter((condition) => condition.outcome === 'unknown');
    if (conditions.length === 0) {
      applied.push({
        applies: 'yes',
        effect: rule.effect,
        id: rule.id,
        reason: 'applies everywhere (no match condition)',
      });
      continue;
    }
    if (unknown.length === 0) {
      applied.push({
        applies: 'yes',
        effect: rule.effect,
        id: rule.id,
        reason: `matches ${conditions.map((condition) => condition.condition).join(', ')}`,
      });
      continue;
    }
    const unknownFacts = unknown.map(
      (condition) => `${condition.condition.split(' ')[0]} (${condition.source ?? 'no source'})`,
    );
    applied.push({
      applies: 'assumed',
      effect: rule.effect,
      id: rule.id,
      reason: `assumed to apply: ${unknownFacts.join(', ')} unknown`,
    });
    assumptions.push(
      `Rule ${rule.id} (${rule.effect}) is assumed to apply because ${unknownFacts.join(' and ')} is unknown; a known fact that contradicts it would lift the rule.`,
    );
  }
  return { applied, assumptions };
};

// ---------------------------------------------------------------------------------------------
// Policy for one route
// ---------------------------------------------------------------------------------------------

export interface DelegationPolicyRoute {
  readonly accountScope: string | null;
  readonly context: DelegationContext | null;
  readonly harness: DelegationExecutorHarness;
  readonly provider: DelegationProvider;
}

export interface EvaluateRoutePolicyInput {
  readonly annotation: DelegationRouteAnnotation | null;
  readonly applied: readonly DelegationAppliedRule[];
  readonly defaults: DelegationDefaults;
  readonly route: DelegationPolicyRoute;
  readonly rules: readonly DelegationRule[];
}

export interface RoutePolicyEvaluation {
  readonly blockers: readonly DelegationRouteBlocker[];
  readonly exclusions: readonly string[];
  readonly requirements: DelegationRouteRequirements;
}

export const CONTEXT_UNDECLARED_EXCLUSION =
  'Declare the context (professional or personal) of this route in Delegation › Routes';

/** A selector absent selects every route; a dimension absent accepts any value on that dimension. */
export const routeMatchesSelector = (
  selector: DelegationRouteSelector | undefined,
  route: DelegationPolicyRoute,
): boolean => {
  if (selector === undefined) {
    return true;
  }
  if (selector.contexts !== undefined && (route.context === null || !selector.contexts.includes(route.context))) {
    return false;
  }
  if (selector.harnesses !== undefined && !selector.harnesses.includes(route.harness)) {
    return false;
  }
  if (selector.providers !== undefined && !selector.providers.includes(route.provider)) {
    return false;
  }
  if (
    selector.accountScopes !== undefined &&
    (route.accountScope === null || !selector.accountScopes.includes(route.accountScope))
  ) {
    return false;
  }
  return true;
};

const SELECTOR_DIMENSIONS = ['accountScopes', 'contexts', 'harnesses', 'providers'] as const;

/** Two selectors that leave no route on some dimension: no route can satisfy both restrictions. */
const selectorsDisjoint = (
  left: DelegationRouteSelector | undefined,
  right: DelegationRouteSelector | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return false;
  }
  return SELECTOR_DIMENSIONS.some((dimension) => {
    const leftValues = left[dimension] as readonly string[] | undefined;
    const rightValues = right[dimension] as readonly string[] | undefined;
    return (
      leftValues !== undefined && rightValues !== undefined && !leftValues.some((value) => rightValues.includes(value))
    );
  });
};

const strictestIdentity = (
  left: DelegationIdentityEvidence,
  right: DelegationIdentityEvidence | undefined,
): DelegationIdentityEvidence => (left === 'observed' || right === 'observed' ? 'observed' : 'declared');

const ruleLabel = (rule: DelegationRule): string =>
  rule.description === undefined ? rule.id : `${rule.id} (${rule.description})`;

/**
 * The policy applied to one route, in priority order: an undeclared context excludes; an applying
 * `forbid` that selects the route excludes; every applying `restrict` must select it (two restricts
 * that cannot both hold exclude every route); requirements combine the strictest of the defaults,
 * the route's annotation and the applying `require` rules that select it. Preferences play no part.
 */
export const evaluateRoutePolicy = (input: EvaluateRoutePolicyInput): RoutePolicyEvaluation => {
  const blockers: DelegationRouteBlocker[] = [];
  const exclusions: string[] = [];
  const rulesById = new Map(input.rules.map((rule) => [rule.id, rule] as const));
  const applying = input.applied.flatMap((entry) => {
    const rule = rulesById.get(entry.id);
    return rule === undefined ? [] : [rule];
  });
  if (input.annotation === null || input.route.context === null) {
    blockers.push('context-undeclared');
    exclusions.push(CONTEXT_UNDECLARED_EXCLUSION);
  }
  const forbidding = applying.filter(
    (rule) => rule.effect === 'forbid' && routeMatchesSelector(rule.routes, input.route),
  );
  if (forbidding.length > 0) {
    blockers.push('forbidden-by-rule');
    exclusions.push(`Forbidden by rule ${forbidding.map(ruleLabel).join(', ')}`);
  }
  const restricting = applying.filter((rule) => rule.effect === 'restrict');
  let incompatible: readonly [DelegationRule, DelegationRule] | null = null;
  for (const [index, left] of restricting.entries()) {
    for (const right of restricting.slice(index + 1)) {
      if (incompatible === null && selectorsDisjoint(left.routes, right.routes)) {
        incompatible = [left, right];
      }
    }
  }
  if (incompatible === null) {
    const outside = restricting.filter((rule) => !routeMatchesSelector(rule.routes, input.route));
    if (outside.length > 0) {
      blockers.push('outside-restriction');
      exclusions.push(`Outside the restriction of rule ${outside.map(ruleLabel).join(', ')}`);
    }
  } else {
    blockers.push('incompatible-rules');
    exclusions.push(
      `Incompatible rules ${incompatible[0].id}, ${incompatible[1].id}: no route satisfies both restrictions`,
    );
  }
  let requirements: DelegationRouteRequirements = {
    identityEvidence: input.defaults.identityEvidence,
    maxAttempts: input.defaults.maxAttempts,
    maxConcurrent: Math.min(
      input.defaults.maxConcurrentPerPool,
      input.annotation?.maxConcurrent ?? Number.POSITIVE_INFINITY,
    ),
    reservePercent: Math.max(input.defaults.reservePercent, input.annotation?.reservePercent ?? 0),
  };
  for (const rule of applying) {
    if (rule.effect !== 'require' || rule.require === undefined || !routeMatchesSelector(rule.routes, input.route)) {
      continue;
    }
    requirements = {
      identityEvidence: strictestIdentity(requirements.identityEvidence, rule.require.identityEvidence),
      maxAttempts: Math.min(requirements.maxAttempts, rule.require.maxAttempts ?? Number.POSITIVE_INFINITY),
      maxConcurrent: Math.min(requirements.maxConcurrent, rule.require.maxConcurrent ?? Number.POSITIVE_INFINITY),
      reservePercent: Math.max(requirements.reservePercent, rule.require.reservePercent ?? 0),
    };
  }
  return { blockers, exclusions, requirements };
};
