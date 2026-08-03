import {
  type AnalyticsRowInput,
  accumulateLineMeasurement,
  createLineMeasurementAccumulator,
  groupAnalytics,
  groupModelAnalytics,
  harnessProviderAnalyticsKey,
  type LineMeasurementAccumulator,
} from '@ai-usage/report-core/analytics';
import { usageRowApiPriceMeasurement } from '@ai-usage/report-core/usage-row';
import type { DashboardRow } from './lib/foundation/presentation/report-value';

export interface ProjectGroup extends LineMeasurementAccumulator {
  cache: number;
  cost: number;
  fresh: number;
  key: string;
  label: string;
  priced: number;
  sessions: number;
  tools: number;
  turns: number;
}

const dashboardRowToAnalyticsInput = (row: DashboardRow): AnalyticsRowInput => ({
  harness: row.harness,
  provider: row.provider,
  usageUnavailable: row.usageUnavailable ?? false,
  ambiguous: row.ambiguous ?? false,
  fresh: row.freshTokens,
  inp: row.tokIn,
  cache: row.tokCr,
  linesAdded: row.linesAdded ?? 0,
  linesDeleted: row.linesDeleted ?? 0,
  turns: row.turns,
  tools: row.tools,
  pricedCost: row.costKnown ? row.costApprox : null,
  unpricedFreshTokens:
    row.priceMeasurement?.unpricedFreshTokens ?? usageRowApiPriceMeasurement(row).unpricedFreshTokens,
});

const createProjectGroup = (key: string, label: string): ProjectGroup => ({
  ...createLineMeasurementAccumulator(),
  key,
  label,
  sessions: 0,
  fresh: 0,
  cache: 0,
  cost: 0,
  priced: 0,
  turns: 0,
  tools: 0,
});

const addProjectRow = (groups: Map<string, ProjectGroup>, row: DashboardRow) => {
  let group = groups.get(row.projectKey);
  if (!group) {
    group = createProjectGroup(row.projectKey, row.projectLabel);
    groups.set(row.projectKey, group);
  }

  group.sessions++;
  group.fresh += row.freshTokens;
  group.cache += row.tokCr;
  group.turns += row.turns;
  group.tools += row.tools;
  accumulateLineMeasurement(group, row.linesAdded, row.linesDeleted);
  if (row.costKnown) {
    group.cost += row.costApprox;
    group.priced++;
  }
};

export const buildAnalyticsGroups = (
  rows: DashboardRow[],
  acceptsRow: (row: DashboardRow) => boolean,
  keyForRow: (row: DashboardRow) => string,
  totalCost: number,
) => groupAnalytics(rows.filter(acceptsRow), dashboardRowToAnalyticsInput, keyForRow, totalCost);

export const buildHarnessProviderAnalyticsGroups = (
  rows: DashboardRow[],
  acceptsRow: (row: DashboardRow) => boolean,
  totalCost: number,
) =>
  groupAnalytics(
    rows.filter(acceptsRow),
    (row) => ({ ...dashboardRowToAnalyticsInput(row), provider: row.providerDisplay }),
    (row) => harnessProviderAnalyticsKey(row.harness, row.providerDisplay),
    totalCost,
  );

export const buildModelAnalyticsGroups = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) =>
  groupModelAnalytics(rows.filter(acceptsRow));

export const buildProjectGroups = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
  const projects = new Map<string, ProjectGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) {
      continue;
    }
    addProjectRow(projects, row);
  }

  return [...projects.values()].sort((a, b) => b.cost - a.cost || b.fresh - a.fresh);
};
