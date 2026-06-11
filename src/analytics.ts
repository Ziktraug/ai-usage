import type { Row } from './types';

export interface AnalyticsGroup {
  key: string;
  harness: string;
  provider: string;
  sessions: number;
  priced: number;
  unpriced: number;
  fresh: number;
  inp: number;
  cache: number;
  cacheHitPct: number;
  costSum: number;
  costPerSession: number | null;
  medianCost: number | null;
  linesA: number;
  linesD: number;
  lineCount: number;
  costPer100Lines: number | null;
  costPercent: number;
  turns: number;
  tools: number;
}

export interface AnalyticsSummary {
  sessionCount: number;
  totalCost: number;
  pricedCount: number;
  unpricedCount: number;
  meanCost: number;
  medianCost: number;
  linesA: number;
  linesD: number;
  lineCount: number;
  costPer100Lines: number | null;
  turns: number;
  tools: number;
  durationMs: number;
  durationRows: number;
  averageDurationMs: number | null;
  recentSessions: number;
  byModel: AnalyticsGroup[];
  byProvider: AnalyticsGroup[];
  byHarness: AnalyticsGroup[];
}

type GroupDraft = Omit<
  AnalyticsGroup,
  'cacheHitPct' | 'costPerSession' | 'medianCost' | 'lineCount' | 'costPer100Lines' | 'costPercent'
> & {
  costs: number[];
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return value ?? 0;
};

const finishGroup = (group: GroupDraft, totalCost: number): AnalyticsGroup => {
  const lineCount = group.linesA + group.linesD;
  return {
    key: group.key,
    harness: group.harness,
    provider: group.provider,
    sessions: group.sessions,
    priced: group.priced,
    unpriced: group.unpriced,
    fresh: group.fresh,
    inp: group.inp,
    cache: group.cache,
    cacheHitPct: group.inp + group.cache > 0 ? (group.cache / (group.inp + group.cache)) * 100 : 0,
    costSum: group.costSum,
    costPerSession: group.priced ? group.costSum / group.priced : null,
    medianCost: group.priced ? median(group.costs) : null,
    linesA: group.linesA,
    linesD: group.linesD,
    lineCount,
    costPer100Lines: lineCount && group.priced ? (group.costSum / lineCount) * 100 : null,
    costPercent: totalCost > 0 ? (group.costSum / totalCost) * 100 : 0,
    turns: group.turns,
    tools: group.tools,
  };
};

const groupBy = (rows: Row[], keyFn: (row: Row) => string, totalCost: number): AnalyticsGroup[] => {
  const groups = new Map<string, GroupDraft>();
  for (const row of rows) {
    const key = keyFn(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        harness: row.harness,
        provider: row.provider,
        sessions: 0,
        priced: 0,
        unpriced: 0,
        fresh: 0,
        inp: 0,
        cache: 0,
        costs: [],
        costSum: 0,
        linesA: 0,
        linesD: 0,
        turns: 0,
        tools: 0,
      };
      groups.set(key, group);
    }
    group.sessions++;
    group.fresh += row.tokIn + row.tokOut + row.tokCw;
    group.inp += row.tokIn;
    group.cache += row.tokCr;
    group.linesA += row.linesAdded || 0;
    group.linesD += row.linesDeleted || 0;
    group.turns += row.turns;
    group.tools += row.tools;
    if (row.costKnown) {
      group.priced++;
      group.costs.push(row.costApprox);
      group.costSum += row.costApprox;
    } else {
      group.unpriced++;
    }
  }

  return [...groups.values()].map((group) => finishGroup(group, totalCost)).sort((a, b) => b.costSum - a.costSum);
};

export const calculateAnalytics = (rows: Row[], now = Date.now()): AnalyticsSummary => {
  const totalCost = rows.reduce((total, row) => total + row.costApprox, 0);
  const priced = rows.filter((row) => row.costKnown);
  const pricedCosts = priced.map((row) => row.costApprox);
  const linesA = rows.reduce((total, row) => total + (row.linesAdded || 0), 0);
  const linesD = rows.reduce((total, row) => total + (row.linesDeleted || 0), 0);
  const lineCount = linesA + linesD;
  const turns = rows.reduce((total, row) => total + row.turns, 0);
  const tools = rows.reduce((total, row) => total + row.tools, 0);
  const durationRows = rows.filter((row) => row.durationMs && row.durationMs > 0);
  const durationMs = durationRows.reduce((total, row) => total + (row.durationMs || 0), 0);
  const recentCutoff = now - 5 * 60_000;
  const recentSessions = rows.filter((row) => (row.endDate?.getTime() ?? 0) >= recentCutoff).length;

  return {
    sessionCount: rows.length,
    totalCost,
    pricedCount: priced.length,
    unpricedCount: rows.length - priced.length,
    meanCost: totalCost / (priced.length || 1),
    medianCost: median(pricedCosts),
    linesA,
    linesD,
    lineCount,
    costPer100Lines: lineCount ? (totalCost / lineCount) * 100 : null,
    turns,
    tools,
    durationMs,
    durationRows: durationRows.length,
    averageDurationMs: durationRows.length ? durationMs / durationRows.length : null,
    recentSessions,
    byModel: groupBy(rows, (row) => row.model, totalCost),
    byProvider: groupBy(rows, (row) => row.provider, totalCost),
    byHarness: groupBy(rows, (row) => row.harness, totalCost),
  };
};
