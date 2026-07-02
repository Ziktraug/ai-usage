import { isRecord } from './datasets';

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

const STATE_RANK: Record<ProviderStatusState, number> = {
  error: 0,
  'auth-required': 1,
  stale: 2,
  partial: 3,
  unsupported: 4,
  ok: 5,
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
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return normalizeIsoTimestamp(value);
  }
  return normalizeIsoTimestamp(value * 1000);
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

const windowGroupForLimitSeconds = (limitSeconds: number | null): string | null => {
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
  const resetsAt = normalizeIsoTimestamp(input.raw.reset_at) ?? normalizeUnixSecondsTimestamp(input.raw.resets_at);
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
  typeof value === 'string' && value in STATE_RANK;

const isProviderLimitWindow = (value: unknown): value is ProviderLimitWindow => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.blocked === 'boolean' &&
    (value.usedPercent === null || typeof value.usedPercent === 'number') &&
    (value.remainingPercent === null || typeof value.remainingPercent === 'number') &&
    (value.resetsAt === null || typeof value.resetsAt === 'string') &&
    (value.limitSeconds === null || typeof value.limitSeconds === 'number') &&
    (value.group === null || typeof value.group === 'string')
  );
};

export const isProviderStatusDataset = (value: unknown): value is ProviderStatusDataset => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === PROVIDER_STATUS_SCHEMA_VERSION &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.providers) &&
    value.providers.every((provider) => {
      if (!isRecord(provider)) {
        return false;
      }
      return (
        typeof provider.key === 'string' &&
        typeof provider.label === 'string' &&
        typeof provider.generatedAt === 'string' &&
        isProviderStatusState(provider.state) &&
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

export const providerStatusWorstState = (providers: ProviderStatus[]): ProviderStatusState =>
  providers.reduce<ProviderStatusState>(
    (worst, provider) => (STATE_RANK[provider.state] < STATE_RANK[worst] ? provider.state : worst),
    'ok',
  );
