import {
  PROVIDER_QUOTA_LIVE_GAP_MS,
  type ProviderQuotaHistoryPoint,
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  type ProviderQuotaSegment,
  segmentProviderQuotaHistoryPoints,
} from '@ai-usage/report-core/provider-quota';

export type ProviderQuotaHistoryRange = '24h' | '7d' | '30d';

export interface ProviderQuotaHistoryWindow {
  readonly from: string;
  readonly to: string;
}

export interface ProviderQuotaHistorySeries {
  accountScope: string | null;
  carriedIn: ProviderQuotaHistoryPoint | null;
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
  window: ProviderQuotaHistoryWindow;
}

const confidenceRank: Record<ProviderQuotaHistoryPoint['source']['confidence'], number> = {
  authoritative: 3,
  derived: 2,
  historical: 1,
};

const rangeDurationMs: Record<ProviderQuotaHistoryRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const providerQuotaHistoryWindow = (
  range: ProviderQuotaHistoryRange,
  to: string,
): ProviderQuotaHistoryWindow => ({
  from: new Date(Date.parse(to) - rangeDurationMs[range]).toISOString(),
  to,
});

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

const largestGapWithin = (points: ProviderQuotaHistoryPoint[]): number => {
  let largestGapMs = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) {
      largestGapMs = Math.max(largestGapMs, Date.parse(current.firstObservedAt) - Date.parse(previous.lastObservedAt));
    }
  }
  return largestGapMs;
};

/**
 * The store deliberately prepends one observation from before the requested range per stream so a
 * reader can tell what the value was when the window opened. Rendering that anchor as an ordinary
 * point makes "last 24h" start days ago — the defect the CLI fixed with `withoutPreRangePoints`.
 * Here the anchor survives as `carriedIn` (a held value, drawn at the left edge) and never as an
 * endpoint, and a stream whose held run ended before the window opened says nothing about it at all.
 */
const buildSeries = (
  points: ProviderQuotaHistoryPoint[],
  window: ProviderQuotaHistoryWindow,
): ProviderQuotaHistorySeries | null => {
  const sorted = dedupePoints(points);
  const inRange = sorted.filter((point) => point.firstObservedAt >= window.from && point.firstObservedAt <= window.to);
  const carriedIn =
    sorted.findLast((point) => point.firstObservedAt < window.from && point.lastObservedAt >= window.from) ?? null;
  const first = inRange[0] ?? carriedIn;
  const last = inRange.at(-1) ?? carriedIn;
  if (!(first && last)) {
    return null;
  }
  const segments = segmentProviderQuotaHistoryPoints(inRange, PROVIDER_QUOTA_LIVE_GAP_MS);
  const gapCount = segments.filter(({ breakReason }) => breakReason === 'gap').length;
  const resetCount = segments.filter(({ breakReason }) => breakReason === 'reset').length;
  return {
    accountScope: first.accountScope,
    carriedIn,
    currentPercent: last.usedPercent,
    firstObservedAt: first.firstObservedAt,
    gapCount,
    key: seriesKey(first),
    label: first.windowLabel,
    largestGapMs: largestGapWithin(inRange),
    lastObservedAt: last.lastObservedAt,
    machineId: first.machineId,
    machineLabel: first.machineLabel,
    nextResetAt: last.resetAt,
    points: inRange,
    providerKey: first.providerKey,
    providerLabel: first.providerLabel,
    resetCount,
    segments,
    sourceConfidence: last.source.confidence,
    sourceKey: last.source.key,
    summary: `${inRange.length} points · ${formatBoundaryCount(resetCount, 'reset')} · ${formatBoundaryCount(gapCount, 'collection gap')}`,
  };
};

const emptyMessageFor = (storedPointCount: number, seriesCount: number): string | null => {
  if (storedPointCount === 0) {
    return 'No quota history yet.';
  }
  return seriesCount === 0 ? 'No quota observations in this window.' : null;
};

export const buildProviderQuotaHistoryModel = (
  result: ProviderQuotaHistoryResult,
  window: ProviderQuotaHistoryWindow,
): ProviderQuotaHistoryModel => {
  const groups = new Map<string, ProviderQuotaHistoryPoint[]>();
  for (const point of result.points) {
    const key = seriesKey(point);
    const rows = groups.get(key) ?? [];
    rows.push(point);
    groups.set(key, rows);
  }
  const series = [...groups.values()]
    .map((group) => buildSeries(group, window))
    .filter((entry): entry is ProviderQuotaHistorySeries => entry !== null)
    .sort((left, right) => left.label.localeCompare(right.label));
  return {
    emptyMessage: emptyMessageFor(result.points.length, series.length),
    generatedAt: result.generatedAt,
    partial: result.truncated || result.skipped > 0,
    series,
    skipped: result.skipped,
    window,
  };
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
