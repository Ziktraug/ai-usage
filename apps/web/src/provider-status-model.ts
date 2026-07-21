import {
  compareProviderStatusStates,
  earliestResetCreditExpiry,
  type ProviderLimitWindow,
  type ProviderStatus,
  parseProviderStatusDataset,
  providerStatusKeyForUsage,
  providerStatusScopeKey,
  providerStatusWithFreshness,
} from '@ai-usage/report-core/provider-status';
import type { DashboardRow } from './shared';

interface ProviderStatusPayload {
  datasets?: Record<string, unknown>;
  facets?: Record<string, unknown>;
  generatedAt: string;
}

export type ProviderWindowGroupKey = '5h' | 'weekly' | 'monthly' | 'other';
export type ProviderStatusTone = 'critical' | 'warning' | 'muted' | 'ok';

export interface ProviderStatusWindowGroup {
  key: ProviderWindowGroupKey;
  label: string;
  windows: ProviderLimitWindow[];
}

export interface ProviderStatusView {
  accountContext: string | null;
  creditsSummary: string | null;
  machineContext: string | null;
  nextResetAt: string | null;
  provider: ProviderStatus;
  sourceLabel: string;
  tone: ProviderStatusTone;
  windowGroups: ProviderStatusWindowGroup[];
  worstUsedPercent: number | null;
}

export const providerHistoryAvailable = (fixturePointCount: number | undefined, sourceAvailable: boolean): boolean =>
  fixturePointCount === undefined ? sourceAvailable : fixturePointCount > 0;

const KNOWN_PROVIDER_KEYS = new Set(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'rtk']);

const providerKeyFromRow = (row: DashboardRow) => providerStatusKeyForUsage(row.harness, row.provider);

const providerLabelFromKey = (key: string, fallback: string) => {
  if (!KNOWN_PROVIDER_KEYS.has(key)) {
    return fallback;
  }
  return key === 'rtk' ? 'RTK' : `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
};

const providerFamily = (key: string) => key.split(':')[0] ?? key;

const inferredProviderStatus = (row: DashboardRow, generatedAt: string): ProviderStatus => {
  const key = providerKeyFromRow(row);
  const machineId = row.source?.machineId;
  const machineLabel = row.source?.machineLabel;
  return {
    key,
    label: providerLabelFromKey(key, row.providerDisplay || row.provider || row.harness),
    generatedAt,
    source: 'unsupported',
    state: key === 'claude' ? 'unsupported' : 'partial',
    ...(machineId === undefined ? {} : { machineId }),
    ...(machineLabel === undefined ? {} : { machineLabel }),
    windows: [],
  };
};

const groupKeyForWindow = (window: ProviderLimitWindow): ProviderWindowGroupKey => {
  if (window.group === '5h') {
    return '5h';
  }
  if (window.group === 'weekly') {
    return 'weekly';
  }
  if (window.group === 'monthly') {
    return 'monthly';
  }
  return 'other';
};

const GROUP_LABELS: Record<ProviderWindowGroupKey, string> = {
  '5h': '5h',
  weekly: 'Weekly',
  monthly: 'Monthly',
  other: 'Other windows',
};

const expiryDateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
});

const formatExpiryDate = (value: string) => expiryDateFormatter.format(new Date(value));

const windowGroupsFor = (windows: ProviderLimitWindow[]): ProviderStatusWindowGroup[] => {
  const groups = new Map<ProviderWindowGroupKey, ProviderLimitWindow[]>();
  for (const window of windows) {
    const key = groupKeyForWindow(window);
    const group = groups.get(key);
    if (group) {
      group.push(window);
    } else {
      groups.set(key, [window]);
    }
  }
  return (['5h', 'weekly', 'monthly', 'other'] as const)
    .map((key) => ({ key, label: GROUP_LABELS[key], windows: groups.get(key) ?? [] }))
    .filter((group) => group.windows.length > 0);
};

const nextResetAtFor = (windows: ProviderLimitWindow[], now: Date | string) => {
  let next: string | null = null;
  const nowTime = new Date(now).getTime();
  for (const window of windows) {
    if (!window.resetsAt) {
      continue;
    }
    const resetTime = new Date(window.resetsAt).getTime();
    if (resetTime > nowTime && (!next || resetTime < new Date(next).getTime())) {
      next = window.resetsAt;
    }
  }
  return next;
};

const worstUsedPercentFor = (windows: ProviderLimitWindow[]) => {
  const values = windows.map((window) => window.usedPercent).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
};

const toneFor = (provider: ProviderStatus, worstUsedPercent: number | null): ProviderStatusTone => {
  if (
    provider.state === 'error' ||
    provider.state === 'auth-required' ||
    provider.windows.some((window) => window.blocked)
  ) {
    return 'critical';
  }
  if (
    provider.state === 'stale' ||
    provider.state === 'partial' ||
    (worstUsedPercent !== null && worstUsedPercent >= 80)
  ) {
    return 'warning';
  }
  if (provider.state === 'unsupported') {
    return 'muted';
  }
  return 'ok';
};

const sourceLabelFor = (provider: ProviderStatus) => {
  switch (provider.source) {
    case 'live-api':
      return provider.state === 'stale' ? 'Stale live status' : 'Live status';
    case 'local-history':
      return 'Local history';
    case 'manual':
      return 'Manual status';
    case 'unsupported':
      return 'No quota source';
    default:
      return 'Provider status';
  }
};

const creditsSummaryFor = (provider: ProviderStatus) => {
  const resetCreditExpiry = earliestResetCreditExpiry(provider.resetCredits ?? []);
  const expiryLabel = resetCreditExpiry ? ` · expires ${formatExpiryDate(resetCreditExpiry)}` : '';
  if (provider.resetCreditsAvailable !== undefined && provider.resetCreditsAvailable !== null) {
    const label = provider.resetCreditsAvailable === 1 ? 'reset credit' : 'reset credits';
    return `${provider.resetCreditsAvailable} ${label}${expiryLabel}`;
  }
  if (provider.creditsBalance) {
    return `${provider.creditsBalance} credits`;
  }
  if (provider.resetCredits?.length) {
    const label = provider.resetCredits.length === 1 ? 'reset credit' : 'reset credits';
    return `${provider.resetCredits.length} ${label}${expiryLabel}`;
  }
  return null;
};

const toProviderStatusView = (input: ProviderStatus, now: Date | string): ProviderStatusView => {
  const provider = providerStatusWithFreshness(input, now);
  const worstUsedPercent = worstUsedPercentFor(provider.windows);
  const accountParts = [provider.plan, provider.accountLabel].filter((value) => value?.trim());
  return {
    provider,
    worstUsedPercent,
    windowGroups: windowGroupsFor(provider.windows),
    nextResetAt: nextResetAtFor(provider.windows, now),
    tone: toneFor(provider, worstUsedPercent),
    sourceLabel: sourceLabelFor(provider),
    accountContext: accountParts.length ? accountParts.join(' · ') : null,
    machineContext: provider.machineLabel ?? null,
    creditsSummary: creditsSummaryFor(provider),
  };
};

const explicitProviderStatuses = (payload: ProviderStatusPayload): ProviderStatus[] => {
  const dataset =
    parseProviderStatusDataset(payload.datasets?.providerStatus) ??
    parseProviderStatusDataset(payload.facets?.providerStatus);
  return dataset?.providers ?? [];
};

const providerFamilyScopeKey = (family: string, machineId: string | null | undefined) =>
  providerStatusScopeKey(family, machineId ?? undefined);

const sortRankFor = (view: ProviderStatusView) => {
  if (view.tone === 'critical') {
    return 0;
  }
  if (view.windowGroups.length || view.creditsSummary) {
    return 1;
  }
  if (view.provider.state === 'stale') {
    return 2;
  }
  if (view.provider.state === 'partial') {
    return 3;
  }
  if (view.provider.state === 'unsupported') {
    return 4;
  }
  return 5;
};

export const buildProviderStatusViews = (
  payload: ProviderStatusPayload,
  rows: DashboardRow[],
  now: Date | string,
): ProviderStatusView[] => {
  const explicit = explicitProviderStatuses(payload);
  const explicitGlobalFamilies = new Set(
    explicit.filter((provider) => !provider.machineId).map((provider) => providerFamily(provider.key)),
  );
  const explicitFamilyScopes = new Set(
    explicit.map((provider) => providerFamilyScopeKey(providerFamily(provider.key), provider.machineId)),
  );
  const inferred = new Map<string, ProviderStatus>();
  for (const row of rows) {
    const key = providerKeyFromRow(row);
    const family = providerFamily(key);
    const machineId = row.source?.machineId;
    const inferredKey = providerFamilyScopeKey(key, machineId);
    if (
      explicitGlobalFamilies.has(family) ||
      explicitFamilyScopes.has(providerFamilyScopeKey(family, machineId)) ||
      inferred.has(inferredKey)
    ) {
      continue;
    }
    inferred.set(inferredKey, inferredProviderStatus(row, payload.generatedAt));
  }
  return [...explicit, ...inferred.values()]
    .map((provider) => toProviderStatusView(provider, now))
    .sort(
      (a, b) =>
        sortRankFor(a) - sortRankFor(b) ||
        compareProviderStatusStates(a.provider.state, b.provider.state) ||
        a.provider.label.localeCompare(b.provider.label) ||
        (a.machineContext ?? '').localeCompare(b.machineContext ?? ''),
    );
};
