import {
  PROVIDER_QUOTA_LIVE_GAP_MS,
  type ProviderQuotaHistoryPoint,
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  type ProviderQuotaSegment,
  segmentProviderQuotaHistoryPoints,
} from '@ai-usage/report-core/provider-quota';

export type ProviderQuotaHistoryRange = '24h' | '7d' | '30d';

export interface ProviderQuotaHistorySeries {
  accountScope: string | null;
  currentPercent: number | null;
  firstObservedAt: string;
  gapCount: number;
  key: string;
  label: string;
  largestGapMs: number;
  lastObservedAt: string;
  machineId: string;
  machineLabel: string | null;
  nextResetAt: string | null;
  points: ProviderQuotaHistoryPoint[];
  providerKey: string;
  providerLabel: string;
  resetCount: number;
  segments: ProviderQuotaSegment[];
  sourceConfidence: ProviderQuotaHistoryPoint['source']['confidence'];
  sourceKey: string;
  summary: string;
}

export interface ProviderQuotaHistoryModel {
  emptyMessage: string | null;
  generatedAt: string;
  partial: boolean;
  series: ProviderQuotaHistorySeries[];
  skipped: number;
}

const confidenceRank: Record<ProviderQuotaHistoryPoint['source']['confidence'], number> = {
  authoritative: 3,
  derived: 2,
  historical: 1,
};

const seriesKey = (point: ProviderQuotaHistoryPoint): string =>
  [point.providerKey, point.machineId, point.accountScope ?? '', point.windowId].join('|');

const dedupePoints = (points: ProviderQuotaHistoryPoint[]): ProviderQuotaHistoryPoint[] => {
  const selected = new Map<string, ProviderQuotaHistoryPoint>();
  for (const point of points) {
    const key = `${seriesKey(point)}|${point.firstObservedAt}`;
    const current = selected.get(key);
    if (!current || confidenceRank[point.source.confidence] > confidenceRank[current.source.confidence]) {
      selected.set(key, point);
    }
  }
  return [...selected.values()].sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
};

const formatBoundaryCount = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? '' : 's'}`;

const buildSeries = (points: ProviderQuotaHistoryPoint[]): ProviderQuotaHistorySeries => {
  const sorted = dedupePoints(points);
  const first = sorted[0] as ProviderQuotaHistoryPoint;
  const last = sorted.at(-1) as ProviderQuotaHistoryPoint;
  const segments = segmentProviderQuotaHistoryPoints(sorted, PROVIDER_QUOTA_LIVE_GAP_MS);
  const gapCount = segments.filter(({ breakReason }) => breakReason === 'gap').length;
  const resetCount = segments.filter(({ breakReason }) => breakReason === 'reset').length;
  let largestGapMs = 0;
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current) {
      largestGapMs = Math.max(largestGapMs, Date.parse(current.firstObservedAt) - Date.parse(previous.lastObservedAt));
    }
  }
  return {
    accountScope: first.accountScope,
    currentPercent: last.usedPercent,
    firstObservedAt: first.firstObservedAt,
    gapCount,
    key: seriesKey(first),
    label: first.windowLabel,
    largestGapMs,
    lastObservedAt: last.lastObservedAt,
    machineId: first.machineId,
    machineLabel: first.machineLabel,
    nextResetAt: last.resetAt,
    points: sorted,
    providerKey: first.providerKey,
    providerLabel: first.providerLabel,
    resetCount,
    segments,
    sourceConfidence: last.source.confidence,
    sourceKey: last.source.key,
    summary: `${sorted.length} points · ${formatBoundaryCount(resetCount, 'reset')} · ${formatBoundaryCount(gapCount, 'collection gap')}`,
  };
};

export const buildProviderQuotaHistoryModel = (result: ProviderQuotaHistoryResult): ProviderQuotaHistoryModel => {
  const groups = new Map<string, ProviderQuotaHistoryPoint[]>();
  for (const point of result.points) {
    const key = seriesKey(point);
    const rows = groups.get(key) ?? [];
    rows.push(point);
    groups.set(key, rows);
  }
  const series = [...groups.values()].map(buildSeries).sort((left, right) => left.label.localeCompare(right.label));
  return {
    emptyMessage: series.length ? null : 'No quota history yet.',
    generatedAt: result.generatedAt,
    partial: result.truncated || result.skipped > 0,
    series,
    skipped: result.skipped,
  };
};

const rangeDurationMs: Record<ProviderQuotaHistoryRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const providerQuotaHistoryRequest = (
  range: ProviderQuotaHistoryRange,
  now: Date,
  filters: Pick<ProviderQuotaHistoryRequest, 'machineId' | 'providerKey'> = {},
): ProviderQuotaHistoryRequest => ({
  from: new Date(now.getTime() - rangeDurationMs[range]).toISOString(),
  maximumPoints: 1200,
  to: now.toISOString(),
  ...(filters.machineId === undefined ? {} : { machineId: filters.machineId }),
  ...(filters.providerKey === undefined ? {} : { providerKey: filters.providerKey }),
});
