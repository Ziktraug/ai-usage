import { isRecord } from './datasets';
import {
  clampPercent,
  labelForLimitWindow,
  normalizeIsoTimestamp,
  normalizeUnixSecondsTimestamp,
  type ProviderLimitWindow,
  type ProviderStatus,
  type ProviderStatusState,
  parseProviderLimitWindow,
  parseProviderStatusDataset,
  remainingPercentFromUsed,
  windowGroupForLimitSeconds,
} from './provider-status';
import { quotaWindowDurationFromMinutes } from './quota-window-duration';

export const PROVIDER_QUOTA_DEFAULT_MAXIMUM_POINTS = 1000;
export const PROVIDER_QUOTA_MAXIMUM_POINTS = 5000;
export const PROVIDER_QUOTA_LIVE_GAP_MS = 10 * 60 * 1000;

export interface ProviderQuotaObservationSource {
  confidence: 'authoritative' | 'historical' | 'derived';
  key: string;
  mode: 'poll' | 'push' | 'backfill';
}

export interface ProviderQuotaObservation {
  accountScope: string | null;
  machineId: string;
  machineLabel: string | null;
  observedAt: string;
  plan: string | null;
  providerGeneratedAt: string | null;
  providerKey: string;
  providerLabel: string;
  source: ProviderQuotaObservationSource;
  state: ProviderStatusState;
  windows: ProviderLimitWindow[];
}

export interface ProviderQuotaHistoryRequest {
  from: string;
  machineId?: string;
  maximumPoints?: number;
  providerKey?: string;
  to: string;
}

export interface ProviderQuotaHistoryPoint {
  accountScope: string | null;
  blocked: boolean;
  firstObservedAt: string;
  group: string | null;
  lastObservedAt: string;
  limitSeconds: number | null;
  machineId: string;
  machineLabel: string | null;
  providerKey: string;
  providerLabel: string;
  resetAt: string | null;
  source: ProviderQuotaObservationSource;
  usedPercent: number | null;
  windowId: string;
  windowLabel: string;
}

export interface ProviderQuotaCoverage {
  accountScope: string | null;
  firstObservedAt: string;
  largestGapMs: number;
  lastObservedAt: string;
  machineId: string;
  pointCount: number;
  providerKey: string;
  sourceConfidence: ProviderQuotaObservationSource['confidence'];
  sourceKey: string;
  windowId: string;
}

export interface ProviderQuotaHistoryResult {
  coverage: ProviderQuotaCoverage[];
  generatedAt: string;
  latest: ProviderStatus[];
  points: ProviderQuotaHistoryPoint[];
  skipped: number;
  truncated: boolean;
}

export interface ProviderQuotaSegment {
  breakReason: 'gap' | 'reset' | null;
  points: ProviderQuotaHistoryPoint[];
}

export interface NormalizeCodexAppServerQuotaInput {
  accountScope?: string | null;
  machineId: string;
  machineLabel?: string | null;
  observedAt: Date | string;
  result: unknown;
}

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && normalizeIsoTimestamp(value) === value;

const CODEX_MODEL_WINDOW_PREFIX = 'model:codex:';
const CODEX_AVAILABILITY_PREFIX = 'availability:codex:';

/** Exact native model identity, never a display-name or shared-word match. */
export const codexQuotaWindowModel = (id: string): string | null => {
  if (!id.startsWith(CODEX_MODEL_WINDOW_PREFIX)) {
    return null;
  }
  const separator = id.indexOf(':', CODEX_MODEL_WINDOW_PREFIX.length);
  if (separator <= CODEX_MODEL_WINDOW_PREFIX.length) {
    return null;
  }
  try {
    return decodeURIComponent(id.slice(CODEX_MODEL_WINDOW_PREFIX.length, separator));
  } catch {
    return null;
  }
};

export const isCodexQuotaAvailabilityWindow = (id: string): boolean =>
  id.startsWith(CODEX_AVAILABILITY_PREFIX) || (codexQuotaWindowModel(id) !== null && id.endsWith(':availability'));

type CodexQuotaScope = { readonly kind: 'global' | 'unknown' } | { readonly kind: 'model'; readonly model: string };
const codexQuotaScope = (snapshot: Record<string, unknown>): CodexQuotaScope => {
  const model = snapshot.normalModelSlug;
  if (typeof model === 'string' && model.length > 0 && model === model.trim()) {
    return { kind: 'model', model };
  }
  if (model === null && snapshot.limitId === 'codex') {
    return { kind: 'global' };
  }
  return { kind: 'unknown' };
};

type CodexCapacityRefusal = 'credits' | 'included-usage' | 'unknown-alias' | 'denied' | 'unknown-capacity';
export type CodexReviewCapacity =
  | { readonly kind: 'available' }
  | { readonly kind: 'unavailable'; readonly reason: CodexCapacityRefusal };

const futureCodexReset = (value: unknown, now: number): boolean =>
  typeof value === 'number' && normalizeUnixSecondsTimestamp(value) !== null && value * 1000 > now;

const knownAvailableCodexWindow = (value: unknown, now: number): boolean =>
  isRecord(value) &&
  typeof value.usedPercent === 'number' &&
  Number.isFinite(value.usedPercent) &&
  value.usedPercent >= 0 &&
  value.usedPercent < 100 &&
  typeof value.windowDurationMins === 'number' &&
  Number.isFinite(value.windowDurationMins * 60) &&
  value.windowDurationMins > 0 &&
  futureCodexReset(value.resetsAt, now);

const codexSnapshotCapacityRefusal = (snapshot: Record<string, unknown>, now: number): CodexCapacityRefusal | null => {
  if (snapshot.spendControlReached === true || snapshot.rateLimitReachedType != null) {
    return 'denied';
  }
  if (snapshot.spendControlReached !== false || snapshot.rateLimitReachedType !== null) {
    return 'unknown-capacity';
  }
  const windows = [snapshot.primary, snapshot.secondary];
  if (
    windows.some((window) => isRecord(window) && typeof window.usedPercent === 'number' && window.usedPercent >= 100)
  ) {
    return 'denied';
  }
  if (
    windows.every((window) => window === null) ||
    windows.some((window) => window !== null && !knownAvailableCodexWindow(window, now))
  ) {
    return 'unknown-capacity';
  }
  if (snapshot.individualLimit != null) {
    const individual = snapshot.individualLimit;
    if (
      !(
        isRecord(individual) &&
        typeof individual.remainingPercent === 'number' &&
        Number.isFinite(individual.remainingPercent) &&
        individual.remainingPercent > 0 &&
        individual.remainingPercent <= 100 &&
        futureCodexReset(individual.resetsAt, now)
      )
    ) {
      return 'unknown-capacity';
    }
  }
  return null;
};

/**
 * Launch authority uses complete native snapshots, before display projection loses null windows.
 * The mandatory global capacity and each exact selected-model bucket must independently be known.
 * A different native model is irrelevant; an unknown alias cannot be silently skipped.
 */
export const assessCodexReviewCapacity = (input: {
  readonly result: unknown;
  readonly model: string;
  readonly now: number;
}): CodexReviewCapacity => {
  const unavailable = (reason: CodexCapacityRefusal): CodexReviewCapacity => ({ kind: 'unavailable', reason });
  if (
    !(isRecord(input.result) && isRecord(input.result.rateLimits) && Number.isFinite(input.now)) ||
    nonEmptyString(input.model) === null
  ) {
    return unavailable('unknown-capacity');
  }
  const root = input.result.rateLimits;
  if (!(isRecord(root.credits) && root.credits.hasCredits === false && root.credits.unlimited === false)) {
    return unavailable('credits');
  }
  if (input.result.ordinaryUsageAllowed !== true) {
    return unavailable('included-usage');
  }
  const byId = input.result.rateLimitsByLimitId;
  if (!(byId === null || isRecord(byId))) {
    return unavailable('unknown-capacity');
  }
  const snapshots: unknown[] = [root, ...(isRecord(byId) ? Object.values(byId) : [])];
  let hasGlobal = false;
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot)) {
      return unavailable('unknown-capacity');
    }
    if (
      snapshot.credits != null &&
      !(isRecord(snapshot.credits) && snapshot.credits.hasCredits === false && snapshot.credits.unlimited === false)
    ) {
      return unavailable('credits');
    }
    const scope = codexQuotaScope(snapshot);
    if (scope.kind === 'unknown') {
      return unavailable('unknown-alias');
    }
    if (scope.kind === 'model' && scope.model !== input.model) {
      continue;
    }
    hasGlobal ||= scope.kind === 'global';
    const refusal = codexSnapshotCapacityRefusal(snapshot, input.now);
    if (refusal !== null) {
      return unavailable(refusal);
    }
  }
  return hasGlobal ? { kind: 'available' } : unavailable('unknown-capacity');
};

const codexWindowId = (snapshot: Record<string, unknown>, slot: string): string => {
  const limitId = nonEmptyString(snapshot.limitId) ?? 'root';
  const scope = codexQuotaScope(snapshot);
  if (scope.kind === 'model') {
    return `${CODEX_MODEL_WINDOW_PREFIX}${encodeURIComponent(scope.model)}:${encodeURIComponent(limitId)}:${slot}`;
  }
  return slot === 'availability' ? `${CODEX_AVAILABILITY_PREFIX}${encodeURIComponent(limitId)}` : `${limitId}:${slot}`;
};

const appServerWindow = (
  raw: unknown,
  snapshot: Record<string, unknown>,
  slot: 'primary' | 'secondary',
): ProviderLimitWindow | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const limitSeconds = quotaWindowDurationFromMinutes(raw.windowDurationMins);
  const usedPercent = clampPercent(raw.usedPercent);
  if (usedPercent === null && limitSeconds === null && raw.resetsAt == null) {
    return null;
  }
  const limitName = nonEmptyString(snapshot.limitName);
  const durationLabel = labelForLimitWindow(limitSeconds, slot === 'primary' ? 'Primary' : 'Secondary');
  const label = limitName && limitName !== 'Codex' ? `${limitName} · ${durationLabel}` : durationLabel;
  const blocked = snapshot.spendControlReached === true || snapshot.rateLimitReachedType != null || usedPercent === 100;
  const model = nonEmptyString(snapshot.normalModelSlug);
  return {
    blocked,
    group: windowGroupForLimitSeconds(limitSeconds),
    id: codexWindowId(snapshot, slot),
    label,
    limitSeconds,
    remainingPercent: remainingPercentFromUsed(usedPercent),
    resetsAt: normalizeUnixSecondsTimestamp(raw.resetsAt),
    scope: model === null ? 'provider' : 'model',
    usedPercent,
  };
};

const appendSnapshotWindows = (windows: Map<string, ProviderLimitWindow>, value: unknown, now: number): void => {
  if (!isRecord(value)) {
    return;
  }
  for (const slot of ['primary', 'secondary'] as const) {
    const window = appServerWindow(value[slot], value, slot);
    if (window && (!windows.has(window.id) || window.blocked)) {
      windows.set(window.id, window);
    }
  }
  // Historical snapshots remain readable. Current native snapshots must retain denials and
  // unknown availability even when no numeric window can be displayed.
  if (!('normalModelSlug' in value || 'spendControlReached' in value)) {
    return;
  }
  const scope = codexQuotaScope(value);
  const refusal = scope.kind === 'unknown' ? 'unknown-alias' : codexSnapshotCapacityRefusal(value, now);
  if (refusal === null) {
    return;
  }
  const id = codexWindowId(value, 'availability');
  const previous = windows.get(id);
  windows.set(id, {
    blocked: refusal === 'denied' || previous?.blocked === true,
    group: null,
    id,
    label: `${nonEmptyString(value.limitName) ?? nonEmptyString(value.normalModelSlug) ?? 'Codex'} · ${refusal === 'denied' ? 'unavailable' : 'availability unknown'}`,
    limitSeconds: null,
    remainingPercent: null,
    resetsAt: null,
    scope: scope.kind === 'global' ? 'provider' : scope.kind,
    usedPercent: null,
  });
};

export const normalizeCodexAppServerQuotaObservation = (
  input: NormalizeCodexAppServerQuotaInput,
): ProviderQuotaObservation | null => {
  if (!isRecord(input.result)) {
    return null;
  }
  const observedAt = normalizeIsoTimestamp(input.observedAt);
  if (!(observedAt && nonEmptyString(input.machineId))) {
    return null;
  }
  const root = input.result.rateLimits;
  if (!isRecord(root)) {
    return null;
  }
  const windows = new Map<string, ProviderLimitWindow>();
  appendSnapshotWindows(windows, root, Date.parse(observedAt));
  if (isRecord(input.result.rateLimitsByLimitId)) {
    for (const value of Object.values(input.result.rateLimitsByLimitId)) {
      appendSnapshotWindows(windows, value, Date.parse(observedAt));
    }
  }
  const normalizedWindows = [...windows.values()];
  return {
    accountScope: input.accountScope ?? null,
    machineId: input.machineId,
    machineLabel: input.machineLabel ?? null,
    observedAt,
    plan: nonEmptyString(root.planType),
    providerGeneratedAt: null,
    providerKey: 'codex',
    providerLabel: 'Codex',
    source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
    state:
      normalizedWindows.length === 0 ||
      normalizedWindows.some((window) => window.blocked || isCodexQuotaAvailabilityWindow(window.id))
        ? 'partial'
        : 'ok',
    windows: normalizedWindows,
  };
};

export interface NormalizeClaudeAgentSdkQuotaInput {
  accountScope?: string | null;
  machineId: string;
  machineLabel?: string | null;
  observedAt: Date | string;
  result: unknown;
}

/**
 * The `limits[]` entries the SDK returns are named by `kind`. These are display names only — `kind`
 * is what identifies a window, so an unknown kind still produces a usable window rather than being
 * dropped.
 */
const CLAUDE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  session: '5h',
  weekly_all: 'Weekly',
  weekly_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet',
};

const CLAUDE_WINDOW_GROUPS: Readonly<Record<string, string>> = {
  monthly: 'monthly',
  session: '5h',
  weekly: 'weekly',
};

const FIRST_CHARACTER_PATTERN = /^./;

const humanizeWindowKind = (kind: string): string =>
  kind.replaceAll('_', ' ').replace(FIRST_CHARACTER_PATTERN, (character) => character.toUpperCase());

/**
 * The SDK never reports a window duration, so `limitSeconds` stays null rather than being guessed
 * from the group — an invented duration would flow into labels and history bucketing as if measured.
 */
const claudeWindow = (raw: unknown): ProviderLimitWindow | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const kind = nonEmptyString(raw.kind);
  if (!kind) {
    return null;
  }
  const usedPercent = clampPercent(raw.percent);
  const resetsAt = normalizeIsoTimestamp(raw.resets_at);
  if (usedPercent === null && resetsAt === null) {
    return null;
  }
  const group = nonEmptyString(raw.group);
  const scope = nonEmptyString(raw.scope);
  return {
    // `severity` is graded, not binary — it already reads `warning` around 75% — so it must not drive
    // `blocked`, which the UI renders as critical. Exhaustion is the only unambiguous signal, and on
    // an API this unstable an unrecognised future severity would over-report rather than under-report.
    // The percentage still carries the pressure; the report's own warning band starts at 80%.
    blocked: usedPercent === 100,
    group: group === null ? null : (CLAUDE_WINDOW_GROUPS[group] ?? group),
    id: kind,
    label: CLAUDE_WINDOW_LABELS[kind] ?? humanizeWindowKind(kind),
    limitSeconds: null,
    remainingPercent: remainingPercentFromUsed(usedPercent),
    resetsAt,
    scope: scope === null ? 'global' : 'model',
    usedPercent,
  };
};

/** Repli quand `limits[]` est absent : les membres nommés portent la même donnée, en moins riche. */
const claudeNamedWindow = (raw: unknown, id: string, label: string, group: string): ProviderLimitWindow | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const usedPercent = clampPercent(raw.utilization);
  const resetsAt = normalizeIsoTimestamp(raw.resets_at);
  if (usedPercent === null && resetsAt === null) {
    return null;
  }
  return {
    blocked: usedPercent === 100,
    group,
    id,
    label,
    limitSeconds: null,
    remainingPercent: remainingPercentFromUsed(usedPercent),
    resetsAt,
    scope: 'global',
    usedPercent,
  };
};

const claudeModelScopedWindows = (raw: unknown): ProviderLimitWindow[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const windows: ProviderLimitWindow[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const displayName = nonEmptyString(entry.display_name);
    const usedPercent = clampPercent(entry.utilization);
    const resetsAt = normalizeIsoTimestamp(entry.resets_at);
    if (!displayName || (usedPercent === null && resetsAt === null)) {
      continue;
    }
    windows.push({
      blocked: usedPercent === 100,
      group: 'weekly',
      id: `model:${displayName}`,
      label: `${displayName} · Weekly`,
      limitSeconds: null,
      remainingPercent: remainingPercentFromUsed(usedPercent),
      resetsAt,
      scope: 'model',
      usedPercent,
    });
  }
  return windows;
};

/**
 * Normalises the Agent SDK's experimental usage payload. Everything is treated as untrusted: the API
 * is explicitly unstable, so a renamed or removed field must degrade to a window-less `unsupported`
 * observation rather than throw and take the whole refresh down with it.
 */
export const normalizeClaudeAgentSdkQuotaObservation = (
  input: NormalizeClaudeAgentSdkQuotaInput,
): ProviderQuotaObservation | null => {
  const observedAt = normalizeIsoTimestamp(input.observedAt);
  if (!(observedAt && nonEmptyString(input.machineId))) {
    return null;
  }
  const result = isRecord(input.result) ? input.result : {};
  const root = result.rate_limits;
  const windows = new Map<string, ProviderLimitWindow>();
  if (isRecord(root)) {
    // `limits[]` is preferred: it is the flat, extensible shape, and it alone carries severity.
    for (const entry of Array.isArray(root.limits) ? root.limits : []) {
      const window = claudeWindow(entry);
      if (window && !windows.has(window.id)) {
        windows.set(window.id, window);
      }
    }
    if (windows.size === 0) {
      const named = [
        claudeNamedWindow(root.five_hour, 'session', '5h', '5h'),
        claudeNamedWindow(root.seven_day, 'weekly_all', 'Weekly', 'weekly'),
      ];
      for (const window of named) {
        if (window) {
          windows.set(window.id, window);
        }
      }
    }
    for (const window of claudeModelScopedWindows(root.model_scoped)) {
      if (!windows.has(window.id)) {
        windows.set(window.id, window);
      }
    }
  }
  const normalizedWindows = [...windows.values()];
  const available = result.rate_limits_available !== false && normalizedWindows.length > 0;
  const incomplete = normalizedWindows.length === 0 || normalizedWindows.some((window) => window.blocked);
  const measuredState: ProviderStatusState = incomplete ? 'partial' : 'ok';
  const state: ProviderStatusState = available ? measuredState : 'unsupported';
  return {
    accountScope: input.accountScope ?? null,
    machineId: input.machineId,
    machineLabel: input.machineLabel ?? null,
    observedAt,
    plan: nonEmptyString(result.subscription_type),
    providerGeneratedAt: null,
    providerKey: 'claude',
    providerLabel: 'Claude',
    source: { confidence: 'authoritative', key: 'claude-agent-sdk', mode: 'poll' },
    state,
    windows: normalizedWindows,
  };
};

export interface NormalizeOpenCodeUsageLimitsInput {
  accountScope?: string | null;
  machineId: string;
  machineLabel?: string | null;
  observedAt: Date | string;
  /** The `data` member of `experimental.usage.limits`, already known to be non-null. */
  result: unknown;
}

/**
 * The three OpenCode Go meters, in the order the console shows them. OpenCode documents them as a
 * 5-hour, a weekly and a monthly allowance, but the server never reports a duration, so — as for
 * Claude — `limitSeconds` stays null rather than being invented from the documentation.
 */
const OPENCODE_GO_METERS = [
  { group: '5h', key: 'rolling', label: '5h' },
  { group: 'weekly', key: 'weekly', label: 'Weekly' },
  { group: 'monthly', key: 'monthly', label: 'Monthly' },
] as const;

const openCodeGoWindow = (raw: unknown, meter: (typeof OPENCODE_GO_METERS)[number]): ProviderLimitWindow | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const usedPercent = clampPercent(raw.percent);
  // `resetsAt` is milliseconds since the epoch, which `normalizeIsoTimestamp` reads as such.
  const resetsAt = typeof raw.resetsAt === 'number' ? normalizeIsoTimestamp(raw.resetsAt) : null;
  if (usedPercent === null && resetsAt === null) {
    return null;
  }
  return {
    // `limited` is OpenCode's own binary "Go refuses requests until the window resets".
    blocked: raw.limited === true || usedPercent === 100,
    group: meter.group,
    id: `go:${meter.key}`,
    label: meter.label,
    limitSeconds: null,
    remainingPercent: remainingPercentFromUsed(usedPercent),
    resetsAt,
    scope: 'global',
    usedPercent,
  };
};

/**
 * Normalises the OpenCode server's experimental usage-limits payload. Only the Go allowance becomes
 * windows: Console budgets are monthly spend caps, a different metric kind that must not be drawn as
 * a subscription quota. A signed-in workspace without Go is a normal outcome, recorded as a
 * window-less `unsupported` observation so the UI can say "no quota window" rather than "never read".
 */
export const normalizeOpenCodeUsageLimitsObservation = (
  input: NormalizeOpenCodeUsageLimitsInput,
): ProviderQuotaObservation | null => {
  const observedAt = normalizeIsoTimestamp(input.observedAt);
  if (!(observedAt && nonEmptyString(input.machineId) && isRecord(input.result))) {
    return null;
  }
  const go = input.result.go;
  const windows = isRecord(go)
    ? OPENCODE_GO_METERS.flatMap((meter) => openCodeGoWindow(go[meter.key], meter) ?? [])
    : [];
  const measuredState: ProviderStatusState = windows.some((window) => window.blocked) ? 'partial' : 'ok';
  return {
    accountScope: input.accountScope ?? null,
    machineId: input.machineId,
    machineLabel: input.machineLabel ?? null,
    observedAt,
    plan: isRecord(go) ? 'go' : null,
    providerGeneratedAt: null,
    providerKey: 'opencode',
    providerLabel: 'OpenCode',
    source: { confidence: 'authoritative', key: 'opencode-usage-limits', mode: 'poll' },
    state: windows.length > 0 ? measuredState : 'unsupported',
    windows,
  };
};

const SOURCE_CONFIDENCES = new Set(['authoritative', 'historical', 'derived']);
const SOURCE_MODES = new Set(['poll', 'push', 'backfill']);
const STATUS_STATES = new Set(['ok', 'partial', 'auth-required', 'unsupported', 'stale', 'error']);
const OBSERVATION_KEYS = new Set([
  'accountScope',
  'machineId',
  'machineLabel',
  'observedAt',
  'plan',
  'providerGeneratedAt',
  'providerKey',
  'providerLabel',
  'source',
  'state',
  'windows',
]);
const SOURCE_KEYS = new Set(['confidence', 'key', 'mode']);
const HISTORY_REQUEST_KEYS = new Set(['from', 'machineId', 'maximumPoints', 'providerKey', 'to']);
const HISTORY_RESULT_KEYS = new Set(['coverage', 'generatedAt', 'latest', 'points', 'skipped', 'truncated']);
const HISTORY_POINT_KEYS = new Set([
  'accountScope',
  'blocked',
  'firstObservedAt',
  'group',
  'lastObservedAt',
  'limitSeconds',
  'machineId',
  'machineLabel',
  'providerKey',
  'providerLabel',
  'resetAt',
  'source',
  'usedPercent',
  'windowId',
  'windowLabel',
]);
const COVERAGE_KEYS = new Set([
  'accountScope',
  'firstObservedAt',
  'largestGapMs',
  'lastObservedAt',
  'machineId',
  'pointCount',
  'providerKey',
  'sourceConfidence',
  'sourceKey',
  'windowId',
]);
const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const parseSource = (value: unknown): ProviderQuotaObservationSource | null => {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, SOURCE_KEYS) &&
      SOURCE_CONFIDENCES.has(String(value.confidence)) &&
      SOURCE_MODES.has(String(value.mode)) &&
      nonEmptyString(value.key)
    )
  ) {
    return null;
  }
  return value as unknown as ProviderQuotaObservationSource;
};

export const parseProviderQuotaObservation = (value: unknown): ProviderQuotaObservation | null => {
  if (!(isRecord(value) && hasOnlyKeys(value, OBSERVATION_KEYS))) {
    return null;
  }
  const source = parseSource(value.source);
  const windows = Array.isArray(value.windows) ? value.windows.map(parseProviderLimitWindow) : [];
  if (
    !(
      source &&
      nonEmptyString(value.machineId) &&
      isTimestamp(value.observedAt) &&
      nonEmptyString(value.providerKey) &&
      nonEmptyString(value.providerLabel) &&
      STATUS_STATES.has(String(value.state))
    ) ||
    windows.some((window) => window === null) ||
    (value.accountScope !== null && typeof value.accountScope !== 'string') ||
    (value.machineLabel !== null && typeof value.machineLabel !== 'string') ||
    (value.plan !== null && typeof value.plan !== 'string') ||
    (value.providerGeneratedAt !== null && !isTimestamp(value.providerGeneratedAt))
  ) {
    return null;
  }
  return { ...value, source, windows: windows as ProviderLimitWindow[] } as ProviderQuotaObservation;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

export const providerQuotaObservationFingerprintInput = (observation: ProviderQuotaObservation): string =>
  JSON.stringify(
    canonicalize({
      plan: observation.plan,
      providerKey: observation.providerKey,
      source: observation.source,
      state: observation.state,
      windows: [...observation.windows].sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );

const projectProviderQuotaObservation = (observation: ProviderQuotaObservation): ProviderStatus => ({
  generatedAt: observation.observedAt,
  key: observation.accountScope ? `${observation.providerKey}:${observation.accountScope}` : observation.providerKey,
  label: observation.providerLabel,
  machineId: observation.machineId,
  ...(observation.machineLabel === null ? {} : { machineLabel: observation.machineLabel }),
  plan: observation.plan,
  source: observation.source.confidence === 'authoritative' ? 'live-api' : 'local-history',
  state: observation.state,
  windows: observation.windows,
});

/** A stored latest reading: the first sighting plus the most recent time an identical reading confirmed it. */
export interface LatestProviderQuotaObservation {
  readonly lastObservedAt: string;
  readonly observation: ProviderQuotaObservation;
}

/**
 * Dates a latest reading by its most recent confirmation, not its first sighting. The store merges
 * identical consecutive readings into one row and only advances the last observation time, so a steady
 * provider re-confirmed every few minutes must not look as old as the moment it was first seen.
 */
export const projectLatestProviderQuotaObservation = ({
  lastObservedAt,
  observation,
}: LatestProviderQuotaObservation): ProviderStatus => {
  const provider = projectProviderQuotaObservation(observation);
  const confirmedAt = normalizeIsoTimestamp(lastObservedAt);
  return confirmedAt !== null && Date.parse(confirmedAt) > Date.parse(observation.observedAt)
    ? { ...provider, generatedAt: confirmedAt }
    : provider;
};

/** What the supersession rule reads from a stored latest head; the store maps its rows onto it. */
export interface ProviderQuotaHeadFacts {
  readonly accountScope: string | null;
  /** The most recent confirmation of the head's reading, as the latest read returns `lastObservedAt`. */
  readonly lastObservedAt: string;
  readonly machineId: string;
  readonly providerKey: string;
}

const quotaHeadGroupKey = ({ machineId, providerKey }: ProviderQuotaHeadFacts): string =>
  JSON.stringify([providerKey, machineId]);

/** The store keys the unscoped head by `accountScope ?? ''`, so an empty scope is unscoped too. */
const isUnscopedQuotaHead = ({ accountScope }: ProviderQuotaHeadFacts): boolean => (accountScope ?? '') === '';

/**
 * Drops a superseded unscoped head: for one provider and machine, the head without an account scope
 * is omitted when a scoped head of that provider and machine was confirmed at or after it.
 *
 * A collector that starts attributing its readings to an account (Codex app-server since its
 * fingerprint) leaves its earlier unscoped head behind, and the rollout backfill keeps writing
 * unscoped rows because rollouts carry no account identity, so the unscoped head cannot be deleted:
 * it would come back. Readers therefore apply this rule at the latest-heads read. An unscoped head
 * newer than every scoped head stays, since it may carry a fresher unattributed reading or an
 * auth-required state; a provider with only unscoped heads, and every scoped head, are untouched.
 * The order of `heads` is preserved. A confirmation that does not parse never supersedes and is
 * never superseded.
 */
export const withoutSupersededUnscopedQuotaHeads = <Head>(
  heads: readonly Head[],
  facts: (head: Head) => ProviderQuotaHeadFacts,
): Head[] => {
  const newestScopedConfirmation = new Map<string, number>();
  for (const head of heads) {
    const fact = facts(head);
    const confirmedAt = Date.parse(fact.lastObservedAt);
    if (isUnscopedQuotaHead(fact) || Number.isNaN(confirmedAt)) {
      continue;
    }
    const key = quotaHeadGroupKey(fact);
    newestScopedConfirmation.set(key, Math.max(confirmedAt, newestScopedConfirmation.get(key) ?? confirmedAt));
  }
  return heads.filter((head) => {
    const fact = facts(head);
    if (!isUnscopedQuotaHead(fact)) {
      return true;
    }
    const scopedConfirmedAt = newestScopedConfirmation.get(quotaHeadGroupKey(fact));
    const confirmedAt = Date.parse(fact.lastObservedAt);
    return scopedConfirmedAt === undefined || Number.isNaN(confirmedAt) || scopedConfirmedAt < confirmedAt;
  });
};

export class ProviderQuotaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderQuotaValidationError';
  }
}

export const parseProviderQuotaHistoryRequest = (value: unknown): ProviderQuotaHistoryRequest => {
  if (
    !(isRecord(value) && hasOnlyKeys(value, HISTORY_REQUEST_KEYS) && isTimestamp(value.from) && isTimestamp(value.to))
  ) {
    throw new ProviderQuotaValidationError('Quota history requires valid from and to timestamps');
  }
  if (Date.parse(value.from) > Date.parse(value.to)) {
    throw new ProviderQuotaValidationError('Quota history from must not be after to');
  }
  const maximumPoints = value.maximumPoints ?? PROVIDER_QUOTA_DEFAULT_MAXIMUM_POINTS;
  if (
    !Number.isSafeInteger(maximumPoints) ||
    Number(maximumPoints) < 2 ||
    Number(maximumPoints) > PROVIDER_QUOTA_MAXIMUM_POINTS
  ) {
    throw new ProviderQuotaValidationError(
      `Quota history maximumPoints must be between 2 and ${PROVIDER_QUOTA_MAXIMUM_POINTS}`,
    );
  }
  const machineId = value.machineId === undefined ? undefined : nonEmptyString(value.machineId);
  const providerKey = value.providerKey === undefined ? undefined : nonEmptyString(value.providerKey);
  if ((value.machineId !== undefined && !machineId) || (value.providerKey !== undefined && !providerKey)) {
    throw new ProviderQuotaValidationError('Quota history filters must be non-empty strings');
  }
  return {
    from: value.from,
    to: value.to,
    maximumPoints: Number(maximumPoints),
    ...(machineId ? { machineId } : {}),
    ...(providerKey ? { providerKey } : {}),
  };
};

const parseHistoryPoint = (value: unknown): ProviderQuotaHistoryPoint | null => {
  if (!(isRecord(value) && hasOnlyKeys(value, HISTORY_POINT_KEYS))) {
    return null;
  }
  const source = parseSource(value.source);
  const percentage = value.usedPercent;
  if (
    !(
      source &&
      nonEmptyString(value.machineId) &&
      nonEmptyString(value.providerKey) &&
      nonEmptyString(value.providerLabel) &&
      nonEmptyString(value.windowId) &&
      nonEmptyString(value.windowLabel) &&
      isTimestamp(value.firstObservedAt) &&
      isTimestamp(value.lastObservedAt)
    ) ||
    (percentage !== null && !(typeof percentage === 'number' && percentage >= 0 && percentage <= 100)) ||
    (value.accountScope !== null && typeof value.accountScope !== 'string') ||
    (value.group !== null && !nonEmptyString(value.group)) ||
    (value.limitSeconds !== null && !(typeof value.limitSeconds === 'number' && value.limitSeconds > 0)) ||
    (value.machineLabel !== null && typeof value.machineLabel !== 'string') ||
    (value.resetAt !== null && !isTimestamp(value.resetAt)) ||
    typeof value.blocked !== 'boolean'
  ) {
    return null;
  }
  return { ...value, source } as ProviderQuotaHistoryPoint;
};

const parseCoverage = (value: unknown): ProviderQuotaCoverage | null => {
  if (!(isRecord(value) && hasOnlyKeys(value, COVERAGE_KEYS))) {
    return null;
  }
  if (
    !(
      nonEmptyString(value.machineId) &&
      nonEmptyString(value.providerKey) &&
      nonEmptyString(value.sourceKey) &&
      nonEmptyString(value.windowId) &&
      isTimestamp(value.firstObservedAt) &&
      isTimestamp(value.lastObservedAt) &&
      Number.isSafeInteger(value.pointCount) &&
      Number(value.pointCount) >= 0 &&
      typeof value.largestGapMs === 'number' &&
      Number.isFinite(value.largestGapMs) &&
      value.largestGapMs >= 0 &&
      SOURCE_CONFIDENCES.has(String(value.sourceConfidence))
    ) ||
    (value.accountScope !== null && typeof value.accountScope !== 'string')
  ) {
    return null;
  }
  return value as unknown as ProviderQuotaCoverage;
};

export const parseProviderQuotaHistoryResult = (value: unknown): ProviderQuotaHistoryResult => {
  if (
    !(isRecord(value) && hasOnlyKeys(value, HISTORY_RESULT_KEYS) && isTimestamp(value.generatedAt)) ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new ProviderQuotaValidationError('Invalid quota history result');
  }
  const points = Array.isArray(value.points) ? value.points.map(parseHistoryPoint) : [];
  const coverage = Array.isArray(value.coverage) ? value.coverage.map(parseCoverage) : [];
  const latest = parseProviderStatusDataset({
    generatedAt: value.generatedAt,
    providers: value.latest,
    schemaVersion: 1,
  });
  if (
    !(Array.isArray(value.points) && Array.isArray(value.coverage) && Array.isArray(value.latest)) ||
    points.some((point) => point === null) ||
    coverage.some((row) => row === null) ||
    !latest ||
    !Number.isSafeInteger(value.skipped) ||
    Number(value.skipped) < 0
  ) {
    throw new ProviderQuotaValidationError('Invalid quota history result');
  }
  return {
    coverage: coverage as ProviderQuotaCoverage[],
    generatedAt: value.generatedAt,
    latest: latest.providers,
    points: points as ProviderQuotaHistoryPoint[],
    skipped: Number(value.skipped),
    truncated: value.truncated,
  };
};

const pointTime = (point: ProviderQuotaHistoryPoint): number => Date.parse(point.firstObservedAt);

export const segmentProviderQuotaHistoryPoints = (
  points: ProviderQuotaHistoryPoint[],
  maximumGapMs = PROVIDER_QUOTA_LIVE_GAP_MS,
): ProviderQuotaSegment[] => {
  const sorted = [...points].sort((left, right) => pointTime(left) - pointTime(right));
  const segments: ProviderQuotaSegment[] = [];
  for (const point of sorted) {
    const current = segments.at(-1);
    const previous = current?.points.at(-1);
    let breakReason: ProviderQuotaSegment['breakReason'] = null;
    if (previous && previous.resetAt !== point.resetAt) {
      breakReason = 'reset';
    } else if (previous && pointTime(point) - Date.parse(previous.lastObservedAt) > maximumGapMs) {
      breakReason = 'gap';
    }
    if (current && breakReason === null) {
      current.points.push(point);
    } else {
      segments.push({ breakReason, points: [point] });
    }
  }
  return segments;
};

const requiredPointIndexes = (points: ProviderQuotaHistoryPoint[], gapMs: number): Set<number> => {
  const required = new Set<number>(points.length ? [0, points.length - 1] : []);
  let minimumIndex = 0;
  let maximumIndex = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) {
      continue;
    }
    if (
      (point.usedPercent ?? Number.POSITIVE_INFINITY) < (points[minimumIndex]?.usedPercent ?? Number.POSITIVE_INFINITY)
    ) {
      minimumIndex = index;
    }
    if (
      (point.usedPercent ?? Number.NEGATIVE_INFINITY) > (points[maximumIndex]?.usedPercent ?? Number.NEGATIVE_INFINITY)
    ) {
      maximumIndex = index;
    }
    if (point.blocked) {
      required.add(index);
    }
    const previous = points[index - 1];
    if (
      previous &&
      (previous.resetAt !== point.resetAt || pointTime(point) - Date.parse(previous.lastObservedAt) > gapMs)
    ) {
      required.add(index - 1);
      required.add(index);
    }
  }
  required.add(minimumIndex);
  required.add(maximumIndex);
  return required;
};

export const downsampleProviderQuotaHistoryPoints = (
  input: ProviderQuotaHistoryPoint[],
  maximumPoints: number,
  maximumGapMs = PROVIDER_QUOTA_LIVE_GAP_MS,
): { points: ProviderQuotaHistoryPoint[]; truncated: boolean } => {
  const points = [...input].sort((left, right) => pointTime(left) - pointTime(right));
  if (points.length <= maximumPoints) {
    return { points, truncated: false };
  }
  const required = requiredPointIndexes(points, maximumGapMs);
  if (required.size < maximumPoints) {
    const slots = maximumPoints - required.size;
    for (let slot = 1; slot <= slots; slot++) {
      required.add(Math.round((slot * (points.length - 1)) / (slots + 1)));
    }
  }
  const selected = [...required].sort((left, right) => left - right).slice(0, maximumPoints);
  return { points: selected.map((index) => points[index]).filter((point) => point !== undefined), truncated: true };
};
