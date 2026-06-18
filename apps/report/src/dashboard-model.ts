import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { SortingState } from '@tanstack/solid-table';
import { buildAnalyticsGroups, buildProjectGroups, type ProjectGroup } from './dashboard-analytics';
import type { Metric, MetricDelta } from './dashboard-metrics';
import { compareRows } from './dashboard-sort';
import type { FieldFilterKey, FieldFilters } from './dashboard-search';
import { DAY_MS, type DateBounds, endOfDay, rowMatchesDateBounds } from './date-range';
import {
  buildReportSummary,
  type DashboardRow,
  fmtCompact,
  fmtMoney,
  fmtNum,
  fmtPct,
  type ReportSummary,
} from './shared';

export const fieldValueForRow = (row: DashboardRow, key: FieldFilterKey) => {
  if (key === 'provider') return row.providerDisplay;
  if (key === 'model') return row.modelKey;
  return row.projectKey;
};

export type FilterSnapshot = {
  fieldEntries: [FieldFilterKey, string][];
  harness: string;
  query: string;
};

export const createFilterSnapshot = (query: string, harness: string, filters: FieldFilters): FilterSnapshot => ({
  fieldEntries: Object.entries(filters) as [FieldFilterKey, string][],
  harness,
  query: query.trim().toLowerCase(),
});

export const matchesFilterSnapshot = (row: DashboardRow, filters: FilterSnapshot) =>
  row.searchText.includes(filters.query) &&
  (filters.harness === 'all' || row.harness === filters.harness) &&
  filters.fieldEntries.every(([key, value]) => fieldValueForRow(row, key) === value);

export const filterTimelineRows = (rows: DashboardRow[], filters: FilterSnapshot) =>
  rows.filter((row) => matchesFilterSnapshot(row, filters));

export const filterRowsByDateBounds = (rows: DashboardRow[], bounds: DateBounds) =>
  rows.filter((row) => rowMatchesDateBounds(row, bounds));

export const buildSortedDashboardRows = (rows: DashboardRow[], sorting: SortingState) => [...rows].sort(compareRows(sorting));

export const buildVisibleSummary = (rows: DashboardRow[], bounds: DateBounds) =>
  buildReportSummary(rows, (row) => rowMatchesDateBounds(row, bounds));

export const buildPreviousPeriodBounds = (bounds: DateBounds, generatedAt: Date): DateBounds | null => {
  if (!bounds.from) return null;
  const from = bounds.from.getTime();
  const to = (bounds.to ?? endOfDay(generatedAt)).getTime();
  const span = Math.max(DAY_MS, to - from);
  return { from: new Date(from - span), to: new Date(from - 1) };
};

export const buildPreviousPeriodSummary = (rows: DashboardRow[], bounds: DateBounds, generatedAt: Date) => {
  const previousBounds = buildPreviousPeriodBounds(bounds, generatedAt);
  if (!previousBounds) return null;
  const summary = buildVisibleSummary(rows, previousBounds);
  return summary.sessionCount > 0 ? summary : null;
};

export const hiddenSessionCount = (totalRows: number, visibleRows: number) => totalRows - visibleRows;

export const buildModelGroups = (rows: DashboardRow[], bounds: DateBounds, totalCost: number): AnalyticsGroup[] =>
  buildAnalyticsGroups(rows, (row) => rowMatchesDateBounds(row, bounds), (row) => row.modelKey, totalCost);

export const buildProviderGroups = (rows: DashboardRow[], bounds: DateBounds, totalCost: number): AnalyticsGroup[] =>
  buildAnalyticsGroups(rows, (row) => rowMatchesDateBounds(row, bounds), (row) => row.providerDisplay, totalCost);

export const buildHarnessGroups = (rows: DashboardRow[], bounds: DateBounds, totalCost: number): AnalyticsGroup[] =>
  buildAnalyticsGroups(rows, (row) => rowMatchesDateBounds(row, bounds), (row) => row.harness, totalCost);

export const buildProjectGroupRows = (rows: DashboardRow[], bounds: DateBounds): ProjectGroup[] =>
  buildProjectGroups(rows, (row) => rowMatchesDateBounds(row, bounds));

export const deltaVs = (
  current: number,
  previous: number | undefined,
  fmt: (value: number) => string,
): MetricDelta | null => {
  if (previous == null || previous <= 0) return null;
  return {
    pct: ((current - previous) / previous) * 100,
    hint: `Previous period of equal length: ${fmt(previous)}`,
  };
};

export const buildDashboardMetrics = (summary: ReportSummary, previous?: ReportSummary | null): Metric[] => {
  const prev = previous ?? undefined;
  const metrics: Metric[] = [
    {
      label: 'Sessions',
      value: fmtNum(summary.sessionCount),
      hint: 'Sessions in the current filter',
      delta: deltaVs(summary.sessionCount, prev?.sessionCount, fmtNum),
    },
    {
      label: 'API value',
      value: fmtMoney(summary.totalCost),
      hint: 'Estimated cost at standard API prices, including usage covered by subscriptions',
      delta: deltaVs(summary.totalCost, prev?.totalCost, fmtMoney),
    },
    {
      label: 'Actual cost',
      value: fmtMoney(summary.actualCost),
      hint: `Out-of-pocket spend reported by harnesses; subscription usage counts as $0${
        summary.unknownActual ? ` (${fmtNum(summary.unknownActual)} sessions unknown)` : ''
      }`,
      delta: deltaVs(summary.actualCost, prev?.actualCost, fmtMoney),
    },
  ];

  if (summary.costQuota) {
    metrics.push({
      label: 'Sub value',
      value: fmtMoney(summary.costQuota),
      hint: 'Cursor export value covered by the subscription quota',
      delta: deltaVs(summary.costQuota, prev?.costQuota, fmtMoney),
    });
  }

  metrics.push(
    { label: 'Mean / sess', value: fmtMoney(summary.meanCost), hint: 'Mean API value per priced session' },
    {
      label: 'Fresh tokens',
      value: fmtCompact(summary.fresh),
      hint: `Tokens processed without cache: ${fmtNum(summary.fresh)}`,
      delta: deltaVs(summary.fresh, prev?.fresh, fmtCompact),
    },
  );

  if (summary.rtkSaved) {
    metrics.push({
      label: 'RTK savings',
      value: fmtPct(summary.rtkInput ? (summary.rtkSaved / summary.rtkInput) * 100 : 0),
      hint: [
        `${fmtNum(summary.rtkSaved)} tokens saved in matched sessions`,
        `${fmtNum(summary.rtkInput)} RTK input tokens before filtering`,
        `${fmtNum(summary.rtkOutput)} RTK output tokens after filtering`,
      ].join('\n'),
    });
  }

  metrics.push(
    {
      label: 'Turns',
      value: fmtNum(summary.turns),
      hint: 'Assistant turns across the filtered sessions',
      delta: deltaVs(summary.turns, prev?.turns, fmtNum),
    },
    {
      label: 'Tool calls',
      value: fmtNum(summary.tools),
      hint: 'Tool invocations across the filtered sessions',
      delta: deltaVs(summary.tools, prev?.tools, fmtNum),
    },
  );

  return metrics;
};
