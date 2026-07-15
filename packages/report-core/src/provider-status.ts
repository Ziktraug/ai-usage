import { isRecord } from './datasets';

const CODEX_PROVIDER_PATTERN = /codex/i;
const CLAUDE_PROVIDER_PATTERN = /claude/i;
const CURSOR_PROVIDER_PATTERN = /cursor/i;
const OPENCODE_PROVIDER_PATTERN = /opencode/i;
const RTK_PROVIDER_PATTERN = /rtk/i;
const GEMINI_PROVIDER_PATTERN = /gemini/i;
const PROVIDER_KEY_PATTERNS: { key: string; pattern: RegExp }[] = [
  { key: 'codex', pattern: CODEX_PROVIDER_PATTERN },
  { key: 'claude', pattern: CLAUDE_PROVIDER_PATTERN },
  { key: 'cursor', pattern: CURSOR_PROVIDER_PATTERN },
  { key: 'opencode', pattern: OPENCODE_PROVIDER_PATTERN },
  { key: 'rtk', pattern: RTK_PROVIDER_PATTERN },
  { key: 'gemini', pattern: GEMINI_PROVIDER_PATTERN },
];

export const providerStatusKeyForUsage = (harness: string, provider: string): string => {
  const text = `${harness} ${provider}`;
  return PROVIDER_KEY_PATTERNS.find(({ pattern }) => pattern.test(text))?.key ?? text.toLowerCase().trim();
};

export const providerStatusScopeKey = (providerKey: string, machineId?: string): string =>
  `${providerKey.split(':')[0] ?? providerKey}|${machineId ?? ''}`;

export type ProviderStatusState = 'ok' | 'partial' | 'auth-required' | 'unsupported' | 'stale' | 'error';

export type ProviderLimitWindowScope = 'global' | 'model' | 'provider' | 'unknown';

export interface ProviderLimitWindow {
  blocked: boolean;
  group: string | null;
  id: string;
  label: string;
  limitSeconds: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  scope: ProviderLimitWindowScope;
  usedPercent: number | null;
}

export interface ProviderResetCredit {
  daysLeft: number | null;
  expiresAt: string | null;
  grantedAt: string | null;
  status: string;
  title: string;
}

export interface ProviderStatus {
  accountLabel?: string | null;
  creditsBalance?: string | null;
  generatedAt: string;
  key: string;
  label: string;
  machineId?: string;
  machineLabel?: string;
  plan?: string | null;
  resetCredits?: ProviderResetCredit[];
  resetCreditsAvailable?: number | null;
  source: 'local-history' | 'live-api' | 'manual' | 'unsupported';
  state: ProviderStatusState;
  warnings?: string[];
  windows: ProviderLimitWindow[];
}

export interface ProviderStatusDataset {
  generatedAt: string;
  providers: ProviderStatus[];
  schemaVersion: 1;
}

export type ProviderStatusFacet = ProviderStatusDataset;

export interface CodexRateLimitStatusInput {
  accountId?: string | null;
  generatedAt: Date | string;
  machineId?: string;
  machineLabel?: string;
  rateLimits: unknown;
  source: ProviderStatus['source'];
}

export const PROVIDER_STATUS_SCHEMA_VERSION = 1 as const;
export const LIVE_PROVIDER_STATUS_MAX_AGE_MS = 15 * 60 * 1000;

const STATE_RANK: Record<ProviderStatusState, number> = {
  error: 0,
  'auth-required': 1,
  stale: 2,
  partial: 3,
  unsupported: 4,
  ok: 5,
};

const PROVIDER_STATUS_SOURCES: Record<ProviderStatus['source'], true> = {
  'local-history': true,
  'live-api': true,
  manual: true,
  unsupported: true,
};

const PROVIDER_LIMIT_WINDOW_SCOPES: Record<ProviderLimitWindowScope, true> = {
  global: true,
  model: true,
  provider: true,
  unknown: true,
};

export const normalizeIsoTimestamp = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numericValue = typeof value === 'number' ? value : Number.NaN;
  const date = typeof value === 'number' ? new Date(numericValue) : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export const normalizeUnixSecondsTimestamp = (value: unknown): string | null => {
  const numericValue =
    typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(numericValue) ? normalizeIsoTimestamp(numericValue * 1000) : normalizeIsoTimestamp(value);
};

export const clampPercent = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.min(100, Math.max(0, numeric));
};

export const remainingPercentFromUsed = (usedPercent: number | null): number | null =>
  usedPercent === null ? null : Math.max(0, 100 - usedPercent);

export const labelForLimitWindow = (limitSeconds: number | null, fallback = 'Quota window') => {
  if (!limitSeconds || limitSeconds <= 0) {
    return fallback;
  }
  const hours = limitSeconds / 3600;
  if (hours === 5) {
    return '5h';
  }
  const days = limitSeconds / 86_400;
  if (days === 7) {
    return 'Weekly';
  }
  if (days >= 28 && days <= 31) {
    return 'Monthly';
  }
  if (Number.isInteger(hours) && hours < 24) {
    return `${hours}h`;
  }
  if (Number.isInteger(days)) {
    return `${days}d`;
  }
  return fallback;
};

export const windowGroupForLimitSeconds = (limitSeconds: number | null): string | null => {
  if (limitSeconds === 18_000) {
    return '5h';
  }
  if (limitSeconds === 604_800) {
    return 'weekly';
  }
  if (limitSeconds !== null && limitSeconds >= 2_419_200 && limitSeconds <= 2_678_400) {
    return 'monthly';
  }
  return null;
};

const optionalString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

const limitSecondsFromWindow = (record: Record<string, unknown>): number | null => {
  const value = record.limit_window_seconds ?? record.window_seconds ?? record.window_minutes;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return record.window_minutes === value ? numeric * 60 : numeric;
};

const blockedFromWindow = (record: Record<string, unknown>): boolean =>
  record.limit_reached === true || record.allowed === false || record.blocked === true;

export const normalizeProviderLimitWindow = (input: {
  blocked?: boolean;
  fallbackLabel?: string;
  fallbackLimitSeconds?: number | null;
  id: string;
  raw: unknown;
  scope?: ProviderLimitWindowScope;
}): ProviderLimitWindow | null => {
  if (!isRecord(input.raw)) {
    return null;
  }
  const limitSeconds = limitSecondsFromWindow(input.raw) ?? input.fallbackLimitSeconds ?? null;
  const usedPercent = clampPercent(input.raw.used_percent);
  const resetsAt =
    normalizeUnixSecondsTimestamp(input.raw.reset_at) ?? normalizeUnixSecondsTimestamp(input.raw.resets_at);
  const explicitLabel = optionalString(input.raw.label) ?? optionalString(input.raw.title);
  const blocked = input.blocked === true || blockedFromWindow(input.raw) || usedPercent === 100;
  return {
    id: input.id,
    label: explicitLabel ?? labelForLimitWindow(limitSeconds, input.fallbackLabel ?? input.id),
    group: windowGroupForLimitSeconds(limitSeconds),
    limitSeconds,
    resetsAt,
    usedPercent,
    remainingPercent: remainingPercentFromUsed(usedPercent),
    blocked,
    scope: input.scope ?? 'unknown',
  };
};

const normalizeCodexWindow = (
  id: string,
  raw: unknown,
  fallbackLabel: string,
  scope: ProviderLimitWindowScope,
  blocked = false,
): ProviderLimitWindow | null => normalizeProviderLimitWindow({ id, raw, fallbackLabel, scope, blocked });

const additionalRateLimits = (rateLimits: Record<string, unknown>): ProviderLimitWindow[] => {
  const additional = rateLimits.additional_rate_limits;
  if (!Array.isArray(additional)) {
    return [];
  }
  const windows: ProviderLimitWindow[] = [];
  for (const [index, item] of additional.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const group =
      optionalString(item.limit_name) ??
      optionalString(item.model) ??
      optionalString(item.group) ??
      optionalString(item.name) ??
      `additional-${index + 1}`;
    const rateLimit = isRecord(item.rate_limit) ? item.rate_limit : item;
    const blocked = blockedFromWindow(rateLimit);
    const primary = normalizeCodexWindow(
      `${group}:primary`,
      rateLimit.primary_window ?? rateLimit.primary,
      `${group} primary`,
      'model',
      blocked,
    );
    const secondary = normalizeCodexWindow(
      `${group}:secondary`,
      rateLimit.secondary_window ?? rateLimit.secondary,
      `${group} secondary`,
      'model',
      blocked,
    );
    for (const window of [primary, secondary]) {
      if (window) {
        windows.push({ ...window, group });
      }
    }
  }
  return windows;
};

const rootRateLimitRecord = (payload: unknown): Record<string, unknown> | null => {
  if (!isRecord(payload)) {
    return null;
  }
  return isRecord(payload.rate_limit) ? payload.rate_limit : payload;
};

const deriveState = (windows: ProviderLimitWindow[], warnings: string[] = []): ProviderStatusState => {
  if (warnings.length && !windows.length) {
    return 'partial';
  }
  if (windows.some((window) => window.blocked)) {
    return 'partial';
  }
  return windows.length ? 'ok' : 'partial';
};

export const normalizeCodexRateLimitStatus = (input: CodexRateLimitStatusInput): ProviderStatus | null => {
  const payload = isRecord(input.rateLimits) ? input.rateLimits : null;
  const rateLimits = rootRateLimitRecord(input.rateLimits);
  if (!rateLimits) {
    return null;
  }
  const generatedAt = normalizeIsoTimestamp(input.generatedAt) ?? new Date().toISOString();
  const accountId = optionalString(input.accountId);
  const blocked = blockedFromWindow(rateLimits);
  const primary = normalizeCodexWindow(
    'primary',
    rateLimits.primary_window ?? rateLimits.primary,
    '5h',
    'global',
    blocked,
  );
  const secondary = normalizeCodexWindow(
    'secondary',
    rateLimits.secondary_window ?? rateLimits.secondary,
    'Weekly',
    'global',
    blocked,
  );
  const windows = [
    primary,
    secondary,
    ...additionalRateLimits(rateLimits),
    ...(payload && payload !== rateLimits ? additionalRateLimits(payload) : []),
  ].filter((window) => window !== null);
  const creditsValue = rateLimits.credits == null ? null : Number(rateLimits.credits);
  const warnings = windows.length ? [] : ['No quota windows were present in the latest Codex rate limit payload.'];
  return {
    key: accountId ? `codex:${accountId}` : 'codex',
    label: 'Codex',
    generatedAt,
    source: input.source,
    state: deriveState(windows, warnings),
    plan: optionalString(rateLimits.plan_type) ?? optionalString(payload?.plan_type) ?? null,
    ...(accountId ? { accountLabel: accountId } : {}),
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    ...(input.machineLabel === undefined ? {} : { machineLabel: input.machineLabel }),
    ...(Number.isFinite(creditsValue)
      ? { creditsBalance: String(creditsValue), resetCreditsAvailable: creditsValue }
      : {}),
    ...(warnings.length ? { warnings } : {}),
    windows,
  };
};

export const daysLeftUntil = (expiresAt: string | null, now = new Date()): number | null => {
  if (!expiresAt) {
    return null;
  }
  const expiresTime = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresTime)) {
    return null;
  }
  return Math.max(0, Math.ceil((expiresTime - now.getTime()) / 86_400_000));
};

export const normalizeProviderResetCredit = (value: unknown, now = new Date()): ProviderResetCredit | null => {
  if (!isRecord(value)) {
    return null;
  }
  const expiresAt = normalizeIsoTimestamp(value.expires_at ?? value.expiresAt);
  return {
    title: optionalString(value.title) ?? 'Reset credit',
    status: optionalString(value.status) ?? 'unknown',
    grantedAt: normalizeIsoTimestamp(value.granted_at ?? value.grantedAt),
    expiresAt,
    daysLeft: daysLeftUntil(expiresAt, now),
  };
};

const resetCreditRowsFromPayload = (payload: unknown): unknown[] | null => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return null;
  }
  const nested = isRecord(payload) ? payload.rate_limit_reset_credits : null;
  if (Array.isArray(nested)) {
    return nested;
  }
  if (isRecord(nested) && Array.isArray(nested.credits)) {
    return nested.credits;
  }
  return Array.isArray(payload.credits) ? payload.credits : null;
};

export const normalizeProviderResetCredits = (payload: unknown, now = new Date()): ProviderResetCredit[] => {
  const rows = resetCreditRowsFromPayload(payload);
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => normalizeProviderResetCredit(row, now)).filter((row) => row !== null);
};

export const earliestResetCreditExpiry = (credits: ProviderResetCredit[]): string | null => {
  let earliest: string | null = null;
  for (const credit of credits) {
    if (!credit.expiresAt) {
      continue;
    }
    if (!earliest || new Date(credit.expiresAt).getTime() < new Date(earliest).getTime()) {
      earliest = credit.expiresAt;
    }
  }
  return earliest;
};

export const createProviderStatusDataset = (
  providers: ProviderStatus[],
  generatedAt = new Date(),
): ProviderStatusDataset => ({
  schemaVersion: PROVIDER_STATUS_SCHEMA_VERSION,
  generatedAt: generatedAt.toISOString(),
  providers,
});

const isProviderStatusState = (value: unknown): value is ProviderStatusState =>
  typeof value === 'string' && Object.hasOwn(STATE_RANK, value);

const isProviderStatusSource = (value: unknown): value is ProviderStatus['source'] =>
  typeof value === 'string' && Object.hasOwn(PROVIDER_STATUS_SOURCES, value);

const isProviderLimitWindowScope = (value: unknown): value is ProviderLimitWindowScope =>
  typeof value === 'string' && Object.hasOwn(PROVIDER_LIMIT_WINDOW_SCOPES, value);

const rfc3339TimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
};

const isValidTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = value.match(rfc3339TimestampPattern);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return day >= 1 && day <= daysInMonth(year, month) && Number.isFinite(new Date(value).getTime());
};

const isNullableTimestamp = (value: unknown): value is string | null => value === null || isValidTimestamp(value);

const isFiniteNumberInRange = (value: unknown, minimum: number, maximum = Number.POSITIVE_INFINITY) =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

const isNullablePercentage = (value: unknown): value is number | null =>
  value === null || isFiniteNumberInRange(value, 0, 100);

const isNullablePositiveNumber = (value: unknown): value is number | null =>
  value === null || isFiniteNumberInRange(value, Number.MIN_VALUE);

const isNullableNonNegativeNumber = (value: unknown): value is number | null =>
  value === null || isFiniteNumberInRange(value, 0);

const isOptionalNullableString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const isOptionalNonEmptyString = (value: unknown): value is string | undefined =>
  value === undefined || isNonEmptyString(value);

const isOptionalNonEmptyStringArray = (value: unknown): value is string[] | undefined =>
  value === undefined || (Array.isArray(value) && value.every(isNonEmptyString));

const PROVIDER_STATUS_DATASET_KEYS = new Set(['generatedAt', 'providers', 'schemaVersion']);
const PROVIDER_STATUS_KEYS = new Set([
  'accountLabel',
  'creditsBalance',
  'generatedAt',
  'key',
  'label',
  'machineId',
  'machineLabel',
  'plan',
  'resetCredits',
  'resetCreditsAvailable',
  'source',
  'state',
  'warnings',
  'windows',
]);
const PROVIDER_RESET_CREDIT_KEYS = new Set(['daysLeft', 'expiresAt', 'grantedAt', 'status', 'title']);
const PROVIDER_LIMIT_WINDOW_KEYS = new Set([
  'blocked',
  'group',
  'id',
  'label',
  'limitSeconds',
  'remainingPercent',
  'resetsAt',
  'scope',
  'usedPercent',
]);
const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const isProviderResetCredit = (value: unknown): value is ProviderResetCredit => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, PROVIDER_RESET_CREDIT_KEYS) &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    isNullableTimestamp(value.grantedAt) &&
    isNullableTimestamp(value.expiresAt) &&
    isNullableNonNegativeNumber(value.daysLeft)
  );
};

const isProviderLimitWindow = (value: unknown): value is ProviderLimitWindow => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, PROVIDER_LIMIT_WINDOW_KEYS) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    typeof value.blocked === 'boolean' &&
    isProviderLimitWindowScope(value.scope) &&
    isNullablePercentage(value.usedPercent) &&
    isNullablePercentage(value.remainingPercent) &&
    isNullableTimestamp(value.resetsAt) &&
    isNullablePositiveNumber(value.limitSeconds) &&
    (value.group === null || isNonEmptyString(value.group))
  );
};

export const parseProviderLimitWindow = (value: unknown): ProviderLimitWindow | null =>
  isProviderLimitWindow(value) ? value : null;

export const isProviderStatusDataset = (value: unknown): value is ProviderStatusDataset => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, PROVIDER_STATUS_DATASET_KEYS) &&
    value.schemaVersion === PROVIDER_STATUS_SCHEMA_VERSION &&
    isValidTimestamp(value.generatedAt) &&
    Array.isArray(value.providers) &&
    value.providers.every((provider) => {
      if (!isRecord(provider)) {
        return false;
      }
      return (
        hasOnlyKeys(provider, PROVIDER_STATUS_KEYS) &&
        isNonEmptyString(provider.key) &&
        isNonEmptyString(provider.label) &&
        isValidTimestamp(provider.generatedAt) &&
        isProviderStatusSource(provider.source) &&
        isProviderStatusState(provider.state) &&
        isOptionalNullableString(provider.accountLabel) &&
        isOptionalNullableString(provider.creditsBalance) &&
        isOptionalNullableString(provider.plan) &&
        isOptionalNonEmptyString(provider.machineId) &&
        isOptionalNonEmptyString(provider.machineLabel) &&
        isOptionalNonEmptyStringArray(provider.warnings) &&
        (provider.resetCredits === undefined ||
          (Array.isArray(provider.resetCredits) && provider.resetCredits.every(isProviderResetCredit))) &&
        (provider.resetCreditsAvailable === undefined || isNullableNonNegativeNumber(provider.resetCreditsAvailable)) &&
        Array.isArray(provider.windows) &&
        provider.windows.every(isProviderLimitWindow)
      );
    })
  );
};

export const parseProviderStatusDataset = (value: unknown): ProviderStatusDataset | null =>
  isProviderStatusDataset(value) ? value : null;

export const mergeProviderStatusDatasets = (
  datasets: (ProviderStatusDataset | undefined)[],
): ProviderStatusDataset | undefined => {
  const providersByKey = new Map<string, ProviderStatus>();
  let generatedAt: string | null = null;
  for (const dataset of datasets) {
    if (!dataset) {
      continue;
    }
    generatedAt = latestIso(generatedAt, dataset.generatedAt);
    for (const provider of dataset.providers) {
      const key = `${provider.machineId ?? ''}|${provider.key}`;
      const current = providersByKey.get(key);
      if (!current || new Date(provider.generatedAt).getTime() >= new Date(current.generatedAt).getTime()) {
        providersByKey.set(key, provider);
      }
    }
  }
  if (!(providersByKey.size && generatedAt)) {
    return;
  }
  return { schemaVersion: PROVIDER_STATUS_SCHEMA_VERSION, generatedAt, providers: [...providersByKey.values()] };
};

const latestIso = (a: string | null, b: string) => {
  if (!a) {
    return b;
  }
  return new Date(b).getTime() >= new Date(a).getTime() ? b : a;
};

export const providerStatusWithFreshness = (
  provider: ProviderStatus,
  now: Date | string,
  maximumAgeMs = LIVE_PROVIDER_STATUS_MAX_AGE_MS,
): ProviderStatus => {
  if (
    provider.source !== 'live-api' ||
    provider.state === 'error' ||
    provider.state === 'auth-required' ||
    provider.state === 'stale'
  ) {
    return provider;
  }
  const ageMs = new Date(now).getTime() - new Date(provider.generatedAt).getTime();
  return Number.isFinite(ageMs) && ageMs > maximumAgeMs ? { ...provider, state: 'stale' } : provider;
};

export const compareProviderStatusStates = (left: ProviderStatusState, right: ProviderStatusState): number =>
  STATE_RANK[left] - STATE_RANK[right];

export const providerStatusWorstState = (providers: ProviderStatus[]): ProviderStatusState =>
  providers.reduce<ProviderStatusState>(
    (worst, provider) => (compareProviderStatusStates(provider.state, worst) < 0 ? provider.state : worst),
    'ok',
  );
