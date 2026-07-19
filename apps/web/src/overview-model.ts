import { compareAnalyticsKeys } from '@ai-usage/report-core/analytics';
import { usageRowModelContributions } from '@ai-usage/report-core/usage-row';
import { type CampaignView, fieldValueForRow } from './dashboard-model';
import type { FieldFilterKey } from './dashboard-search';
import { DAY_MS, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
import type { DashboardRow, ReportSummary } from './shared';

export interface OverviewHeroData {
  actualSpend: number;
  actualSpendKnownSessions: number;
  apiEquivalentValue: number;
  apiPricedSessions: number;
  sessionCount: number;
  subscriptionValue: number;
}

export const buildOverviewHeroData = (summary: ReportSummary): OverviewHeroData | null => {
  if (summary.totalCost <= 0) {
    return null;
  }
  return {
    actualSpend: summary.actualCost,
    actualSpendKnownSessions: Math.max(0, summary.sessionCount - summary.unknownActual),
    apiEquivalentValue: summary.totalCost,
    apiPricedSessions: summary.pricedSessions,
    sessionCount: summary.sessionCount,
    subscriptionValue: summary.costQuota,
  };
};

export const nextHeatmapFocusIndex = (currentIndex: number, itemCount: number, key: string): number | null => {
  if (itemCount <= 0) {
    return null;
  }
  const lastIndex = itemCount - 1;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, currentIndex - 7);
    case 'ArrowRight':
      return Math.min(lastIndex, currentIndex + 7);
    case 'ArrowUp':
      return Math.max(0, currentIndex - 1);
    case 'ArrowDown':
      return Math.min(lastIndex, currentIndex + 1);
    case 'Home':
      return 0;
    case 'End':
      return lastIndex;
    default:
      return null;
  }
};

export interface HeatDay {
  cost: number;
  date: Date;
  level: number;
  sessions: number;
}
export interface HeatWeek {
  days: (HeatDay | null)[];
}
export interface CalendarHeatmapData {
  monthLabels: string[];
  todayKey: string;
  weeks: HeatWeek[];
}

export const buildCalendarHeatmapData = (rows: DashboardRow[], now = new Date()): CalendarHeatmapData | null => {
  const byDay = new Map<string, { cost: number; sessions: number }>();
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.activeTime == null) {
      continue;
    }
    minTime = Math.min(minTime, row.activeTime);
    maxTime = Math.max(maxTime, row.activeTime);
    const key = toDateInputValue(startOfDay(new Date(row.activeTime)));
    let entry = byDay.get(key);
    if (!entry) {
      entry = { cost: 0, sessions: 0 };
      byDay.set(key, entry);
    }
    if (row.costKnown) {
      entry.cost += row.costApprox;
    }
    entry.sessions++;
  }
  if (!byDay.size) {
    return null;
  }

  const last = startOfDay(new Date(maxTime));
  let first = startOfDay(new Date(minTime));
  if ((last.getTime() - first.getTime()) / DAY_MS > 730) {
    first = shiftCalendarDays(last, -730);
  }
  const gridStart = shiftCalendarDays(first, -((first.getDay() + 6) % 7));

  const sorted = [...byDay.values()]
    .map((entry) => entry.sessions)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const quantile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];

  const todayKey = toDateInputValue(startOfDay(now));
  const weeks: HeatWeek[] = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;
  for (let cursor = gridStart; cursor <= last; cursor = shiftCalendarDays(cursor, 7)) {
    const days: (HeatDay | null)[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = shiftCalendarDays(cursor, offset);
      if (date < first || date > last) {
        days.push(null);
        continue;
      }
      const entry = byDay.get(toDateInputValue(date));
      const value = entry?.sessions ?? 0;
      days.push({
        date,
        cost: entry?.cost ?? 0,
        sessions: entry?.sessions ?? 0,
        level: value <= 0 ? 0 : 1 + thresholds.filter((threshold) => value > threshold).length,
      });
    }
    weeks.push({ days });
    const month = cursor.getMonth();
    monthLabels.push(month === previousMonth ? '' : cursor.toLocaleDateString('en', { month: 'short' }));
    previousMonth = month;
  }

  return { weeks, monthLabels, todayKey };
};

export type TimelineDimension = 'harness' | 'model' | 'project' | 'provider';
export type TimelineValue = 'cost' | 'sessions' | 'share';

export interface TimelineDomain {
  maxDay: Date;
  minDay: Date;
}

export interface TimelineBucketEntry {
  cost: number;
  sessions: number;
}

export interface TimelineBucket {
  byKey: Map<string, TimelineBucketEntry>;
  date: Date;
  sessions: number;
  total: number;
}
export type MigrationGranularity = 'day' | 'month' | 'week';
export interface TimelineSeries {
  key: string;
  label: string;
  memberKeys?: readonly string[];
  sessions: number;
  total: number;
}
export type MigrationSeries = TimelineSeries;
export interface TimelineData {
  buckets: TimelineBucket[];
  dimension: TimelineDimension;
  first: Date;
  grandSessions: number;
  grandTotal: number;
  granularity: MigrationGranularity;
  last: Date;
  maxBucketSessions: number;
  maxBucketTotal: number;
  series: TimelineSeries[];
}
export interface MigrationBucket extends TimelineBucket {
  byModel: Map<string, number>;
}
export interface ModelMigrationData extends Omit<TimelineData, 'buckets' | 'dimension'> {
  buckets: MigrationBucket[];
  dimension: 'model';
}

const bucketStartFor = (date: Date, granularity: MigrationGranularity) => {
  const day = startOfDay(date);
  if (granularity === 'week') {
    return shiftCalendarDays(day, -((day.getDay() + 6) % 7));
  }
  if (granularity === 'month') {
    return new Date(day.getFullYear(), day.getMonth(), 1);
  }
  return day;
};

const nextBucketStart = (date: Date, granularity: MigrationGranularity) => {
  if (granularity === 'week') {
    return shiftCalendarDays(date, 7);
  }
  if (granularity === 'month') {
    return new Date(date.getFullYear(), date.getMonth() + 1, 1);
  }
  return shiftCalendarDays(date, 1);
};

export const buildModelMigrationData = (
  rows: DashboardRow[],
  granularity: MigrationGranularity = 'day',
): ModelMigrationData | null => {
  const pricedRows = rows.filter((row) => row.activeTime != null && row.costKnown && row.costApprox > 0);
  if (pricedRows.length < 2) {
    return null;
  }
  const data = buildTimelineData(pricedRows, { dimension: 'model', granularity });
  if (!data) {
    return null;
  }
  return {
    ...data,
    buckets: data.buckets.map((bucket) => {
      const byModel = new Map<string, number>();
      for (const [key, entry] of bucket.byKey) {
        byModel.set(key, entry.cost);
      }
      return { ...bucket, byModel };
    }),
    dimension: 'model',
  };
};

const fieldKeyForTimelineDimension = (dimension: TimelineDimension): FieldFilterKey | null =>
  dimension === 'harness' ? null : dimension;

const timelineKeyForRow = (row: DashboardRow, dimension: TimelineDimension) => {
  const fieldKey = fieldKeyForTimelineDimension(dimension);
  return fieldKey ? fieldValueForRow(row, fieldKey) : row.harness;
};

const timelineContributionsForRow = (row: DashboardRow, dimension: TimelineDimension) => {
  if (dimension !== 'model') {
    return [
      {
        cost: row.costKnown ? row.costApprox : 0,
        key: timelineKeyForRow(row, dimension),
        sessions: 1,
      },
    ];
  }
  const contributions = usageRowModelContributions(row);
  const sessionKey = contributions.some(({ key }) => key === row.modelKey) ? row.modelKey : contributions[0]?.key;
  return contributions.map(({ costApprox, key }) => ({
    cost: row.costKnown ? costApprox : 0,
    key,
    sessions: key === sessionKey ? 1 : 0,
  }));
};

const MAX_TIMELINE_SERIES = 12;
const OTHER_TIMELINE_SERIES_KEY = '__ai_usage_other__';

const timelineSeriesFrom = (ranked: [string, TimelineBucketEntry][], buckets: TimelineBucket[]): TimelineSeries[] => {
  if (ranked.length <= MAX_TIMELINE_SERIES) {
    return ranked.map(([key, value]) => ({ key, label: key, sessions: value.sessions, total: value.cost }));
  }

  const retained = ranked.slice(0, MAX_TIMELINE_SERIES - 1);
  const aggregated = ranked.slice(MAX_TIMELINE_SERIES - 1);
  let aggregateKey = OTHER_TIMELINE_SERIES_KEY;
  while (ranked.some(([key]) => key === aggregateKey)) {
    aggregateKey = `_${aggregateKey}`;
  }

  const memberKeys = aggregated.map(([key]) => key);
  for (const bucket of buckets) {
    const aggregateEntry = { cost: 0, sessions: 0 };
    for (const key of memberKeys) {
      const entry = bucket.byKey.get(key);
      if (!entry) {
        continue;
      }
      aggregateEntry.cost += entry.cost;
      aggregateEntry.sessions += entry.sessions;
      bucket.byKey.delete(key);
    }
    if (aggregateEntry.sessions > 0 || aggregateEntry.cost > 0) {
      bucket.byKey.set(aggregateKey, aggregateEntry);
    }
  }

  const aggregateTotal = aggregated.reduce(
    (total, [, value]) => ({
      cost: total.cost + value.cost,
      sessions: total.sessions + value.sessions,
    }),
    { cost: 0, sessions: 0 },
  );
  return [
    ...retained.map(([key, value]) => ({ key, label: key, sessions: value.sessions, total: value.cost })),
    {
      key: aggregateKey,
      label: 'Other',
      memberKeys,
      sessions: aggregateTotal.sessions,
      total: aggregateTotal.cost,
    },
  ];
};

export const buildTimelineData = (
  rows: DashboardRow[],
  options: {
    dimension: TimelineDimension;
    domain?: TimelineDomain | null;
    granularity: MigrationGranularity;
  },
): TimelineData | null => {
  const dated = rows.filter((row): row is DashboardRow & { activeTime: number } => row.activeTime != null);
  if (!dated.length) {
    return null;
  }

  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const row of dated) {
    minTime = Math.min(minTime, row.activeTime);
    maxTime = Math.max(maxTime, row.activeTime);
  }
  const bucketStart = (date: Date) => bucketStartFor(date, options.granularity);

  const firstBucket = bucketStart(options.domain?.minDay ?? new Date(minTime));
  const lastBucket = bucketStart(options.domain?.maxDay ?? new Date(maxTime));
  const buckets: TimelineBucket[] = [];
  const bucketIndex = new Map<string, number>();
  for (let cursor = firstBucket; cursor <= lastBucket; cursor = nextBucketStart(cursor, options.granularity)) {
    bucketIndex.set(toDateInputValue(cursor), buckets.length);
    buckets.push({ date: cursor, byKey: new Map(), sessions: 0, total: 0 });
  }
  if (buckets.length === 0) {
    return null;
  }

  const totals = new Map<string, TimelineBucketEntry>();
  for (const row of dated) {
    const index = bucketIndex.get(toDateInputValue(bucketStart(new Date(row.activeTime))));
    if (index === undefined) {
      continue;
    }
    const bucket = buckets[index];
    if (!bucket) {
      continue;
    }
    for (const { cost, key, sessions } of timelineContributionsForRow(row, options.dimension)) {
      const entry = bucket.byKey.get(key) ?? { cost: 0, sessions: 0 };
      entry.cost += cost;
      entry.sessions += sessions;
      bucket.byKey.set(key, entry);
      bucket.total += cost;
      bucket.sessions += sessions;

      const totalEntry = totals.get(key) ?? { cost: 0, sessions: 0 };
      totalEntry.cost += cost;
      totalEntry.sessions += sessions;
      totals.set(key, totalEntry);
    }
  }

  // Largest total first so the dominant model sits at the base of every
  // stacked bar. Dense additive tails share one honest aggregate.
  const ranked = [...totals.entries()].sort(
    (a, b) => b[1].cost - a[1].cost || b[1].sessions - a[1].sessions || compareAnalyticsKeys(a[0], b[0]),
  );
  const grandTotal = ranked.reduce((sum, [, value]) => sum + value.cost, 0);
  const grandSessions = ranked.reduce((sum, [, value]) => sum + value.sessions, 0);
  const series = timelineSeriesFrom(ranked, buckets);
  const maxBucketTotal = buckets.reduce((max, bucket) => Math.max(max, bucket.total), 0);
  const maxBucketSessions = buckets.reduce((max, bucket) => Math.max(max, bucket.sessions), 0);

  return {
    buckets,
    dimension: options.dimension,
    grandTotal,
    grandSessions,
    granularity: options.granularity,
    maxBucketSessions,
    maxBucketTotal,
    series,
    first: buckets[0]?.date ?? firstBucket,
    last: buckets.at(-1)?.date ?? lastBucket,
  };
};

export const DURATION_TICKS = [
  { value: 60_000, label: '1m' },
  { value: 600_000, label: '10m' },
  { value: 3_600_000, label: '1h' },
  { value: 14_400_000, label: '4h' },
] as const;

export const COST_TICKS = [
  { value: 0.01, label: '$0.01' },
  { value: 0.1, label: '$0.10' },
  { value: 1, label: '$1' },
  { value: 10, label: '$10' },
  { value: 100, label: '$100' },
] as const;

export type OverviewSessionItem =
  | {
      kind: 'session';
      row: DashboardRow;
      label: string;
      harness: string;
      costApprox: number;
      costKnown: boolean;
      durationMs: number | null;
      sessionCount: 1;
    }
  | {
      kind: 'campaign';
      row: DashboardRow;
      campaign: CampaignView;
      label: string;
      harness: string;
      costApprox: number;
      costKnown: boolean;
      durationMs: number | null;
      sessionCount: number;
    };

type TimedOverviewSessionItem = OverviewSessionItem & { durationMs: number };

const isTimedPricedSession = (item: OverviewSessionItem): item is TimedOverviewSessionItem =>
  item.costKnown && item.durationMs !== null && item.durationMs > 0 && item.costApprox > 0;

export const buildOverviewSessionItems = (
  rows: DashboardRow[],
  campaigns: CampaignView[] = [],
): OverviewSessionItem[] => {
  const campaignRowIds = new Set(campaigns.flatMap((campaign) => campaign.visibleRows.map((row) => row.rowId)));
  const campaignItems: OverviewSessionItem[] = campaigns.map((campaign) => ({
    kind: 'campaign',
    row: campaign.root,
    campaign,
    label: campaign.root.sessionLabel,
    harness: campaign.root.harness,
    costApprox: campaign.visibleTotals.totalCost,
    costKnown: campaign.visibleTotals.costKnown,
    durationMs: campaign.visibleTotals.durationMs,
    sessionCount: campaign.visibleCount,
  }));
  const sessionItems: OverviewSessionItem[] = rows
    .filter((row) => !campaignRowIds.has(row.rowId))
    .map((row) => ({
      kind: 'session',
      row,
      label: row.sessionLabel,
      harness: row.harness,
      costApprox: row.costApprox,
      costKnown: row.costKnown,
      durationMs: row.durationMs,
      sessionCount: 1,
    }));

  return [...campaignItems, ...sessionItems];
};

export interface SessionShapeData {
  harnesses: string[];
  harnessSummaries: SessionShapeHarnessSummary[];
  outliers: TimedOverviewSessionItem[];
  points: (TimedOverviewSessionItem & { aggregateCount: number })[];
  totalPoints: number;
  xPct: (value: number) => number;
  xTicks: (typeof DURATION_TICKS)[number][];
  yPct: (value: number) => number;
  yTicks: (typeof COST_TICKS)[number][];
}

export interface SessionShapeHarnessSummary {
  costMax: number;
  costMin: number;
  durationMax: number;
  durationMin: number;
  groups: number;
  harness: string;
  sessions: number;
}

export const buildSessionShapeData = (
  rows: DashboardRow[],
  campaigns: CampaignView[] = [],
): SessionShapeData | null => {
  const points = buildOverviewSessionItems(rows, campaigns).filter(isTimedPricedSession);
  if (points.length < 3) {
    return null;
  }

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const row of points) {
    xMin = Math.min(xMin, row.durationMs);
    xMax = Math.max(xMax, row.durationMs);
    yMin = Math.min(yMin, row.costApprox);
    yMax = Math.max(yMax, row.costApprox);
  }
  const lx = (value: number) => Math.log10(value);
  const xLo = lx(xMin) - 0.08;
  const xHi = lx(xMax) + 0.08;
  const yLo = lx(yMin) - 0.12;
  const yHi = lx(yMax) + 0.12;
  const xPct = (value: number) => 4 + ((lx(value) - xLo) / Math.max(1e-9, xHi - xLo)) * 92;
  const yPct = (value: number) => 92 - ((lx(value) - yLo) / Math.max(1e-9, yHi - yLo)) * 84;

  const xSpan = Math.max(1e-9, xHi - xLo);
  const ySpan = Math.max(1e-9, yHi - yLo);
  const normalizedX = (item: OverviewSessionItem & { durationMs: number }) => (lx(item.durationMs) - xLo) / xSpan;
  const normalizedY = (item: OverviewSessionItem & { durationMs: number }) => (lx(item.costApprox) - yLo) / ySpan;
  const outlierScore = (item: OverviewSessionItem & { durationMs: number }) => normalizedX(item) + normalizedY(item);

  const harnesses = [...new Set(points.map((item) => item.harness))];
  const MAX_SCATTER_MARKS = 240;
  const binsPerHarness = Math.max(1, Math.floor(MAX_SCATTER_MARKS / Math.max(1, harnesses.length)));
  const scatterColumns = Math.max(1, Math.floor(Math.sqrt(binsPerHarness * 1.6)));
  const scatterRows = Math.max(1, Math.floor(binsPerHarness / scatterColumns));
  interface ShapeBin {
    count: number;
    representative: OverviewSessionItem & { durationMs: number };
  }
  const bins = new Map<string, ShapeBin>();
  for (const point of points) {
    const column = Math.min(scatterColumns - 1, Math.max(0, Math.floor(normalizedX(point) * scatterColumns)));
    const row = Math.min(scatterRows - 1, Math.max(0, Math.floor(normalizedY(point) * scatterRows)));
    const key = `${point.harness}:${column}:${row}`;
    const bin = bins.get(key);
    if (!bin) {
      bins.set(key, { count: point.sessionCount, representative: point });
      continue;
    }
    bin.count += point.sessionCount;
    if (outlierScore(point) > outlierScore(bin.representative)) {
      bin.representative = point;
    }
  }

  const plotPoints = [...bins.values()].map((bin) => ({ ...bin.representative, aggregateCount: bin.count }));
  const rankings = [
    [...points].sort((left, right) => right.costApprox - left.costApprox || right.durationMs - left.durationMs),
    [...points].sort((left, right) => right.durationMs - left.durationMs || right.costApprox - left.costApprox),
    [...points].sort((left, right) => outlierScore(right) - outlierScore(left) || right.costApprox - left.costApprox),
  ];
  const outliers: (OverviewSessionItem & { durationMs: number })[] = [];
  const selectedOutlierRows = new Set<string>();
  for (let rank = 0; outliers.length < 6 && rank < points.length; rank++) {
    for (const ranking of rankings) {
      const point = ranking[rank];
      if (!point || selectedOutlierRows.has(point.row.rowId)) {
        continue;
      }
      selectedOutlierRows.add(point.row.rowId);
      outliers.push(point);
      if (outliers.length === 6) {
        break;
      }
    }
  }

  const harnessSummaries = harnesses
    .map((harness): SessionShapeHarnessSummary => {
      const harnessPoints = points.filter((point) => point.harness === harness);
      return {
        costMax: Math.max(...harnessPoints.map((point) => point.costApprox)),
        costMin: Math.min(...harnessPoints.map((point) => point.costApprox)),
        durationMax: Math.max(...harnessPoints.map((point) => point.durationMs)),
        durationMin: Math.min(...harnessPoints.map((point) => point.durationMs)),
        groups: harnessPoints.length,
        harness,
        sessions: harnessPoints.reduce((sum, point) => sum + point.sessionCount, 0),
      };
    })
    .sort((left, right) => right.sessions - left.sessions || left.harness.localeCompare(right.harness));

  return {
    harnessSummaries,
    points: plotPoints,
    outliers,
    totalPoints: points.reduce((sum, point) => sum + point.sessionCount, 0),
    xPct,
    yPct,
    xTicks: DURATION_TICKS.filter((tick) => tick.value >= xMin && tick.value <= xMax),
    yTicks: COST_TICKS.filter((tick) => tick.value >= yMin && tick.value <= yMax),
    harnesses,
  };
};

export const PUNCH_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export interface PunchCell {
  cost: number;
  sessions: number;
}
export interface PunchcardData {
  cells: PunchCell[][];
  maxSessions: number;
}

export const buildPunchcardData = (rows: DashboardRow[]): PunchcardData | null => {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ cost: 0, sessions: 0 })));
  let maxSessions = 0;
  for (const row of rows) {
    if (row.activeTime == null) {
      continue;
    }
    const date = new Date(row.activeTime);
    const cell = cells[(date.getDay() + 6) % 7]?.[date.getHours()];
    if (!cell) {
      continue;
    }
    cell.sessions++;
    if (row.costKnown) {
      cell.cost += row.costApprox;
    }
    maxSessions = Math.max(maxSessions, cell.sessions);
  }
  return maxSessions > 0 ? { cells, maxSessions } : null;
};

export interface AdvancedAnalysisSummary {
  hasPunchcard: boolean;
  hasSessionShape: boolean;
  summary: string;
}

export const buildAdvancedAnalysisSummary = (
  rows: DashboardRow[],
  campaigns: CampaignView[] = [],
): AdvancedAnalysisSummary | null => {
  const availableAnalyses: string[] = [];
  const hasSessionShape = buildOverviewSessionItems(rows, campaigns).filter(isTimedPricedSession).length >= 3;
  const hasPunchcard = rows.some((row) => row.activeTime !== null);
  if (hasSessionShape) {
    availableAnalyses.push('Duration/value patterns');
  }
  if (hasPunchcard) {
    availableAnalyses.push('weekly/hourly activity');
  }
  if (availableAnalyses.length === 0) {
    return null;
  }

  const sessionLabel = rows.length === 1 ? 'session' : 'sessions';
  const analysisSummary = availableAnalyses.join(' and ');
  return {
    hasPunchcard,
    hasSessionShape,
    summary: `${analysisSummary.charAt(0).toUpperCase()}${analysisSummary.slice(1)} · ${rows.length} ${sessionLabel}`,
  };
};

export interface OverviewRecords {
  busiest: { cost: number; date: Date; sessions: number } | null;
  longest: DashboardRow | null;
  streak: number;
  streakEnd: Date | null;
  topCost: DashboardRow | null;
}

export const buildOverviewRecords = (rows: DashboardRow[], timelineRows: DashboardRow[]): OverviewRecords | null => {
  const priced = rows.filter((row) => row.costKnown && row.costApprox > 0);
  const topCost = priced.reduce<DashboardRow | null>(
    (best, row) => (best == null || row.costApprox > best.costApprox ? row : best),
    null,
  );
  const longest = rows.reduce<DashboardRow | null>(
    (best, row) =>
      (row.durationMs ?? 0) > 0 && (best == null || (row.durationMs ?? 0) > (best.durationMs ?? 0)) ? row : best,
    null,
  );

  const byDay = new Map<string, { cost: number; date: Date; sessions: number }>();
  for (const row of rows) {
    if (row.activeTime == null) {
      continue;
    }
    const day = startOfDay(new Date(row.activeTime));
    const key = toDateInputValue(day);
    let entry = byDay.get(key);
    if (!entry) {
      entry = { cost: 0, date: day, sessions: 0 };
      byDay.set(key, entry);
    }
    if (row.costKnown) {
      entry.cost += row.costApprox;
    }
    entry.sessions++;
  }
  const busiest = [...byDay.values()].reduce<{ cost: number; date: Date; sessions: number } | null>(
    (best, entry) =>
      best == null || entry.cost > best.cost || (entry.cost === best.cost && entry.sessions > best.sessions)
        ? entry
        : best,
    null,
  );

  const streakDays = new Set<string>();
  let lastDay: Date | null = null;
  for (const row of timelineRows) {
    if (row.activeTime == null) {
      continue;
    }
    const day = startOfDay(new Date(row.activeTime));
    streakDays.add(toDateInputValue(day));
    if (!lastDay || day > lastDay) {
      lastDay = day;
    }
  }
  let streak = 0;
  if (lastDay) {
    for (let cursor = lastDay; streakDays.has(toDateInputValue(cursor)); cursor = shiftCalendarDays(cursor, -1)) {
      streak++;
    }
  }

  if (!(topCost || longest || busiest) && streak === 0) {
    return null;
  }
  return { topCost, longest, busiest, streak, streakEnd: lastDay };
};

export const buildTopSessions = (rows: DashboardRow[], limit = 5, campaigns: CampaignView[] = []) =>
  buildOverviewSessionItems(rows, campaigns)
    .filter((item) => item.costApprox > 0)
    .sort((a, b) => b.costApprox - a.costApprox)
    .slice(0, limit);
