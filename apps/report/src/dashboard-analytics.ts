import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { DashboardRow } from './shared';
import { median } from './shared';

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

type MutableAnalyticsGroup = AnalyticsGroup & { costs: number[] };

const createAnalyticsGroup = (key: string, row: DashboardRow): MutableAnalyticsGroup => ({
  key,
  harness: row.harness,
  provider: row.provider,
  sessions: 0,
  priced: 0,
  unpriced: 0,
  usageUnavailable: 0,
  fresh: 0,
  inp: 0,
  cache: 0,
  cacheHitPct: 0,
  costSum: 0,
  costPerSession: null,
  medianCost: null,
  linesA: 0,
  linesD: 0,
  lineCount: 0,
  costPer100Lines: null,
  costPercent: 0,
  turns: 0,
  tools: 0,
  costs: [],
});

const addAnalyticsRow = (groups: Map<string, MutableAnalyticsGroup>, key: string, row: DashboardRow) => {
  let group = groups.get(key);
  if (!group) {
    group = createAnalyticsGroup(key, row);
    groups.set(key, group);
  }

  group.sessions++;
  if (row.usageUnavailable) group.usageUnavailable++;
  group.fresh += row.freshTokens;
  group.inp += row.tokIn;
  group.cache += row.tokCr;
  group.linesA += row.linesAdded ?? 0;
  group.linesD += row.linesDeleted ?? 0;
  group.turns += row.turns;
  group.tools += row.tools;
  if (row.costKnown) {
    group.priced++;
    group.costSum += row.costApprox;
    group.costs.push(row.costApprox);
  } else {
    group.unpriced++;
  }
};

const finalizeAnalyticsGroups = (groups: Map<string, MutableAnalyticsGroup>, totalCost: number): AnalyticsGroup[] =>
  [...groups.values()]
    .map((group) => {
      const lineCount = group.linesA + group.linesD;
      return {
        ...group,
        cacheHitPct: group.inp + group.cache > 0 ? (group.cache / (group.inp + group.cache)) * 100 : 0,
        costPerSession: group.priced ? group.costSum / group.priced : null,
        medianCost: group.priced ? median(group.costs) : null,
        lineCount,
        costPer100Lines: lineCount && group.priced ? (group.costSum / lineCount) * 100 : null,
        costPercent: totalCost > 0 ? (group.costSum / totalCost) * 100 : 0,
      };
    })
    .sort((a, b) => b.costSum - a.costSum);

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
) => {
  const groups = new Map<string, MutableAnalyticsGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addAnalyticsRow(groups, keyForRow(row), row);
  }

  return finalizeAnalyticsGroups(groups, totalCost);
};

export const buildProjectGroups = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
  const projects = new Map<string, ProjectGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addProjectRow(projects, row);
  }

  return [...projects.values()].sort((a, b) => b.cost - a.cost || b.fresh - a.fresh);
};
