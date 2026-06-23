import type { CampaignView } from './dashboard-model';
import { DAY_MS, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
import type { DashboardRow } from './shared';

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
  useCost: boolean;
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

  const useCost = [...byDay.values()].some((entry) => entry.cost > 0);
  const sorted = [...byDay.values()]
    .map((entry) => (useCost ? entry.cost : entry.sessions))
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
      const value = heatDayValue(entry, useCost);
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

  return { weeks, monthLabels, useCost, todayKey };
};

const heatDayValue = (entry: { cost: number; sessions: number } | undefined, useCost: boolean) => {
  if (!entry) {
    return 0;
  }
  return useCost ? entry.cost : entry.sessions;
};

export interface MigrationBucket {
  byModel: Map<string, number>;
  date: Date;
  total: number;
}
export type MigrationGranularity = 'day' | 'month' | 'week';
export interface MigrationSeries {
  key: string;
  total: number;
}
export interface ModelMigrationData {
  buckets: MigrationBucket[];
  first: Date;
  grandTotal: number;
  granularity: MigrationGranularity;
  last: Date;
  maxBucketTotal: number;
  series: MigrationSeries[];
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
  const dated = rows.filter((row) => row.activeTime != null && row.costKnown && row.costApprox > 0) as (DashboardRow & {
    activeTime: number;
  })[];
  if (dated.length < 2) {
    return null;
  }

  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const row of dated) {
    minTime = Math.min(minTime, row.activeTime);
    maxTime = Math.max(maxTime, row.activeTime);
  }
  const bucketStart = (date: Date) => bucketStartFor(date, granularity);

  const firstBucket = bucketStart(new Date(minTime));
  const lastBucket = bucketStart(new Date(maxTime));
  const buckets: MigrationBucket[] = [];
  const bucketIndex = new Map<string, number>();
  for (let cursor = firstBucket; cursor <= lastBucket; cursor = nextBucketStart(cursor, granularity)) {
    bucketIndex.set(toDateInputValue(cursor), buckets.length);
    buckets.push({ date: cursor, byModel: new Map(), total: 0 });
  }
  if (buckets.length === 0) {
    return null;
  }

  const totals = new Map<string, number>();
  for (const row of dated) {
    const index = bucketIndex.get(toDateInputValue(bucketStart(new Date(row.activeTime))));
    if (index === undefined) {
      continue;
    }
    const bucket = buckets[index];
    if (!bucket) {
      continue;
    }
    bucket.byModel.set(row.modelKey, (bucket.byModel.get(row.modelKey) ?? 0) + row.costApprox);
    bucket.total += row.costApprox;
    totals.set(row.modelKey, (totals.get(row.modelKey) ?? 0) + row.costApprox);
  }

  // Every model gets its own series — no "other" bucket. Largest total first so
  // the dominant model sits at the base of every stacked bar.
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const grandTotal = ranked.reduce((sum, [, value]) => sum + value, 0);
  const series: MigrationSeries[] = ranked.map(([key, total]) => ({ key, total }));
  const maxBucketTotal = buckets.reduce((max, bucket) => Math.max(max, bucket.total), 0);

  return {
    buckets,
    granularity,
    grandTotal,
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
      durationMs: number | null;
      sessionCount: number;
    };

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
      durationMs: row.durationMs,
      sessionCount: 1,
    }));

  return [...campaignItems, ...sessionItems];
};

export interface SessionShapeData {
  harnesses: string[];
  points: (OverviewSessionItem & { durationMs: number })[];
  xPct: (value: number) => number;
  xTicks: (typeof DURATION_TICKS)[number][];
  yPct: (value: number) => number;
  yTicks: (typeof COST_TICKS)[number][];
}

export const buildSessionShapeData = (
  rows: DashboardRow[],
  campaigns: CampaignView[] = [],
): SessionShapeData | null => {
  const points = buildOverviewSessionItems(rows, campaigns).filter(
    (item) => (item.durationMs ?? 0) > 0 && item.costApprox > 0,
  ) as (OverviewSessionItem & { durationMs: number })[];
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

  return {
    points: points.slice(0, 2000),
    xPct,
    yPct,
    xTicks: DURATION_TICKS.filter((tick) => tick.value >= xMin && tick.value <= xMax),
    yTicks: COST_TICKS.filter((tick) => tick.value >= yMin && tick.value <= yMax),
    harnesses: [...new Set(points.map((item) => item.harness))],
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
