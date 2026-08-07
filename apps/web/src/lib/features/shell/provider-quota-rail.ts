import { type HarnessKey, harnessKeys } from '@ai-usage/report-core/harness-metadata';
import {
  type ProviderLimitWindow,
  type ProviderStatus,
  type ProviderStatusDataset,
  type ProviderStatusState,
  providerStatusWithFreshness,
} from '@ai-usage/report-core/provider-status';

/**
 * The rail always lists every harness, including the ones no collector can measure. A provider that
 * silently disappears from a fixed slot reads as "nothing to report" when the truth is "nothing is
 * being read" — so absence is rendered, not hidden.
 */
export type ProviderQuotaSeverity = 'ok' | 'warning' | 'danger' | 'unknown';

export interface ProviderQuotaRailWindow {
  blocked: boolean;
  id: string;
  label: string;
  resetsAt: string | null;
  usedPercent: number | null;
}

export interface ProviderQuotaRailEntry {
  key: HarnessKey;
  label: string;
  machineLabel: string | null;
  measured: boolean;
  nextResetAt: string | null;
  planLabel: string | null;
  reason: string;
  severity: ProviderQuotaSeverity;
  usedPercent: number | null;
  windows: ProviderQuotaRailWindow[];
}

/**
 * Shared with the Overview panel's `toneFor`, deliberately: two readouts of the same number must not
 * turn amber at different points.
 */
const WARNING_USED_PERCENT = 80;

const RAIL_PROVIDER_LABELS: Record<HarnessKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const providerFamily = (key: string): string => key.split(':')[0] ?? key;

const worstUsedPercent = (windows: readonly ProviderLimitWindow[]): number | null => {
  const measured = windows.map((window) => window.usedPercent).filter((value) => value !== null);
  return measured.length > 0 ? Math.max(...measured) : null;
};

const nextResetAt = (windows: readonly ProviderLimitWindow[], now: Date): string | null => {
  let next: number | null = null;
  let nextIso: string | null = null;
  for (const window of windows) {
    if (!window.resetsAt) {
      continue;
    }
    const resetAt = new Date(window.resetsAt).getTime();
    if (resetAt > now.getTime() && (next === null || resetAt < next)) {
      next = resetAt;
      nextIso = window.resetsAt;
    }
  }
  return nextIso;
};

const severityFor = (state: ProviderStatusState, windows: readonly ProviderLimitWindow[]): ProviderQuotaSeverity => {
  if (state === 'error' || state === 'auth-required' || windows.some((window) => window.blocked)) {
    return 'danger';
  }
  const used = worstUsedPercent(windows);
  if (used === null) {
    return 'unknown';
  }
  return used >= WARNING_USED_PERCENT ? 'warning' : 'ok';
};

const reasonFor = (status: ProviderStatus, windows: readonly ProviderLimitWindow[]): string => {
  switch (status.state) {
    case 'auth-required':
      return 'Sign in to read this quota';
    case 'error':
      return status.warnings?.[0] ?? 'The quota source failed';
    case 'stale':
      return 'Last reading is out of date';
    case 'unsupported':
      return 'No quota source';
    default:
      return windows.length > 0 ? 'Live quota' : 'No quota window reported';
  }
};

/**
 * A provider can hold several heads at once — one per machine and account scope. The rail shows one
 * ring, so it prefers a head that actually carries windows over a bare state, then the most recent.
 */
const preferredStatus = (candidates: readonly ProviderStatus[]): ProviderStatus | null => {
  let best: ProviderStatus | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const candidateMeasures = candidate.windows.length > 0;
    if (candidateMeasures !== best.windows.length > 0) {
      best = candidateMeasures ? candidate : best;
      continue;
    }
    if (new Date(candidate.generatedAt).getTime() > new Date(best.generatedAt).getTime()) {
      best = candidate;
    }
  }
  return best;
};

const unmeasuredEntry = (key: HarnessKey): ProviderQuotaRailEntry => ({
  key,
  label: RAIL_PROVIDER_LABELS[key],
  machineLabel: null,
  measured: false,
  nextResetAt: null,
  planLabel: null,
  reason: 'No quota source',
  severity: 'unknown',
  usedPercent: null,
  windows: [],
});

const toRailWindow = (window: ProviderLimitWindow): ProviderQuotaRailWindow => ({
  blocked: window.blocked,
  id: window.id,
  label: window.label,
  resetsAt: window.resetsAt,
  usedPercent: window.usedPercent,
});

const toRailEntry = (key: HarnessKey, status: ProviderStatus, now: Date): ProviderQuotaRailEntry => {
  const fresh = providerStatusWithFreshness(status, now);
  const planParts = [fresh.plan, fresh.accountLabel].filter((value) => value?.trim());
  return {
    key,
    label: RAIL_PROVIDER_LABELS[key],
    machineLabel: fresh.machineLabel ?? null,
    measured: fresh.windows.length > 0,
    nextResetAt: nextResetAt(fresh.windows, now),
    planLabel: planParts.length > 0 ? planParts.join(' · ') : null,
    reason: reasonFor(fresh, fresh.windows),
    severity: severityFor(fresh.state, fresh.windows),
    usedPercent: worstUsedPercent(fresh.windows),
    windows: fresh.windows.map(toRailWindow),
  };
};

export const buildProviderQuotaRail = (
  dataset: ProviderStatusDataset | null,
  now: Date | string,
): ProviderQuotaRailEntry[] => {
  const at = new Date(now);
  const byFamily = new Map<string, ProviderStatus[]>();
  for (const provider of dataset?.providers ?? []) {
    const family = providerFamily(provider.key);
    const bucket = byFamily.get(family);
    if (bucket) {
      bucket.push(provider);
    } else {
      byFamily.set(family, [provider]);
    }
  }
  return harnessKeys.map((key) => {
    const status = preferredStatus(byFamily.get(key) ?? []);
    return status === null ? unmeasuredEntry(key) : toRailEntry(key, status, at);
  });
};

/** True when at least one provider reports a real percentage — the rail is worth its slot. */
export const providerQuotaRailIsMeasured = (entries: readonly ProviderQuotaRailEntry[]): boolean =>
  entries.some((entry) => entry.measured);
