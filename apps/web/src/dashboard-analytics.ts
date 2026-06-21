import { type AnalyticsRowInput, groupAnalytics } from '@ai-usage/report-core/analytics';
import type { DashboardRow } from './shared';

export type ProjectGroup = {
  key: string;
  sessions: number;
  fresh: number;
  cache: number;
  cost: number;
  priced: number;
  turns: number;
  tools: number;
  linesAdded: number;
  linesDeleted: number;
};

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
});

const createProjectGroup = (key: string): ProjectGroup => ({
  key,
  sessions: 0,
  fresh: 0,
  cache: 0,
  cost: 0,
  priced: 0,
  turns: 0,
  tools: 0,
  linesAdded: 0,
  linesDeleted: 0,
});

const addProjectRow = (groups: Map<string, ProjectGroup>, row: DashboardRow) => {
  let group = groups.get(row.projectKey);
  if (!group) {
    group = createProjectGroup(row.projectKey);
    groups.set(row.projectKey, group);
  }

  group.sessions++;
  group.fresh += row.freshTokens;
  group.cache += row.tokCr;
  group.turns += row.turns;
  group.tools += row.tools;
  group.linesAdded += row.linesAdded ?? 0;
  group.linesDeleted += row.linesDeleted ?? 0;
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

export const buildProjectGroups = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
  const projects = new Map<string, ProjectGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addProjectRow(projects, row);
  }

  return [...projects.values()].sort((a, b) => b.cost - a.cost || b.fresh - a.fresh);
};
