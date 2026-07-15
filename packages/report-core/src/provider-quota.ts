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

const appServerWindow = (
  raw: unknown,
  snapshot: Record<string, unknown>,
  slot: 'primary' | 'secondary',
): ProviderLimitWindow | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const durationMinutes = Number(raw.windowDurationMins);
  const limitSeconds = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes * 60 : null;
  const usedPercent = clampPercent(raw.usedPercent);
  if (usedPercent === null && limitSeconds === null && raw.resetsAt == null) {
    return null;
  }
  const limitId = nonEmptyString(snapshot.limitId) ?? 'root';
  const limitName = nonEmptyString(snapshot.limitName);
  const durationLabel = labelForLimitWindow(limitSeconds, slot === 'primary' ? 'Primary' : 'Secondary');
  const label = limitName && limitName !== 'Codex' ? `${limitName} · ${durationLabel}` : durationLabel;
  const blocked = snapshot.rateLimitReachedType != null || usedPercent === 100;
  return {
    blocked,
    group: windowGroupForLimitSeconds(limitSeconds),
    id: `${limitId}:${slot}`,
    label,
    limitSeconds,
    remainingPercent: remainingPercentFromUsed(usedPercent),
    resetsAt: normalizeUnixSecondsTimestamp(raw.resetsAt),
    scope: 'provider',
    usedPercent,
  };
};

const appendSnapshotWindows = (windows: Map<string, ProviderLimitWindow>, value: unknown): void => {
  if (!isRecord(value)) {
    return;
  }
  for (const slot of ['primary', 'secondary'] as const) {
    const window = appServerWindow(value[slot], value, slot);
    if (window && !windows.has(window.id)) {
      windows.set(window.id, window);
    }
  }
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
  appendSnapshotWindows(windows, root);
  if (isRecord(input.result.rateLimitsByLimitId)) {
    for (const value of Object.values(input.result.rateLimitsByLimitId)) {
      appendSnapshotWindows(windows, value);
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
    state: normalizedWindows.length === 0 || normalizedWindows.some((window) => window.blocked) ? 'partial' : 'ok',
    windows: normalizedWindows,
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

export const projectProviderQuotaObservation = (observation: ProviderQuotaObservation): ProviderStatus => ({
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
