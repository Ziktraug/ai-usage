import type { Row } from './types';
import {
  usageRowCacheReadTokens,
  usageRowFreshTokens,
  usageRowIsRecent,
  usageRowLineDelta,
  usageRowModelContributions,
  usageRowPricedCost,
} from './usage-row';

export interface AnalyticsGroup {
  ambiguous: number;
  cache: number;
  cacheHitPct: number;
  costPer100Lines: number | null;
  costPercent: number;
  costPerSession: number | null;
  costSum: number;
  fresh: number;
  harness: string;
  inp: number;
  key: string;
  lineCount: number;
  linesA: number;
  linesD: number;
  medianCost: number | null;
  priced: number;
  provider: string;
  sessions: number;
  tools: number;
  turns: number;
  unpriced: number;
  usageUnavailable: number;
}

/**
 * The minimal per-row shape the grouping engine accumulates. Callers project
 * their own row type onto it, so the finalize formulas live in exactly one
 * place instead of being re-derived per output adapter.
 */
export interface AnalyticsRowInput {
  ambiguous?: boolean;
  cache: number;
  /** Known subtotal retained when the complete price is unavailable. */
  costLowerBound?: number;
  fresh: number;
  harness: string;
  inp: number;
  linesAdded: number;
  linesDeleted: number;
  pricedCost: number | null;
  provider: string;
  tools: number;
  turns: number;
  usageUnavailable?: boolean;
}

export interface AnalyticsSummary {
  averageDurationMs: number | null;
  byHarness: AnalyticsGroup[];
  byModel: AnalyticsGroup[];
  byProvider: AnalyticsGroup[];
  costPer100Lines: number | null;
  durationMs: number;
  durationRows: number;
  lineCount: number;
  linesA: number;
  linesD: number;
  meanCost: number;
  medianCost: number;
  pricedCount: number;
  recentSessions: number;
  sessionCount: number;
  tools: number;
  totalCost: number;
  turns: number;
  unpricedCount: number;
}

type GroupDraft = Omit<
  AnalyticsGroup,
  'cacheHitPct' | 'costPerSession' | 'medianCost' | 'lineCount' | 'costPer100Lines' | 'costPercent'
> & {
  costs: number[];
  pricedCostSum: number;
};

/** Stable, locale-independent ordering for analytics and timeline tie-breaks. */
export const compareAnalyticsKeys = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const median = (values: number[]) => {
  if (!values.length) {
    return 0;
  }
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
    usageUnavailable: group.usageUnavailable,
    ambiguous: group.ambiguous,
    fresh: group.fresh,
    inp: group.inp,
    cache: group.cache,
    cacheHitPct: group.inp + group.cache > 0 ? (group.cache / (group.inp + group.cache)) * 100 : 0,
    costSum: group.costSum,
    costPerSession: group.priced ? group.pricedCostSum / group.priced : null,
    medianCost: group.priced ? median(group.costs) : null,
    linesA: group.linesA,
    linesD: group.linesD,
    lineCount,
    costPer100Lines: lineCount && group.priced ? (group.pricedCostSum / lineCount) * 100 : null,
    costPercent: totalCost > 0 ? (group.costSum / totalCost) * 100 : 0,
    turns: group.turns,
    tools: group.tools,
  };
};

/**
 * Group rows of any shape into analytics groups. The caller supplies a
 * projection onto {@link AnalyticsRowInput} and a key selector; accumulation
 * and the finalize formulas stay behind this one interface.
 */
export const groupAnalytics = <T>(
  rows: readonly T[],
  toInput: (row: T) => AnalyticsRowInput,
  keyFn: (row: T) => string,
  totalCost: number,
): AnalyticsGroup[] => {
  const groups = new Map<string, GroupDraft>();
  for (const row of rows) {
    const input = toInput(row);
    const key = keyFn(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        harness: input.harness,
        provider: input.provider,
        sessions: 0,
        priced: 0,
        unpriced: 0,
        usageUnavailable: 0,
        ambiguous: 0,
        fresh: 0,
        inp: 0,
        cache: 0,
        costs: [],
        costSum: 0,
        pricedCostSum: 0,
        linesA: 0,
        linesD: 0,
        turns: 0,
        tools: 0,
      };
      groups.set(key, group);
    }
    group.sessions++;
    if (input.usageUnavailable) {
      group.usageUnavailable++;
    }
    if (input.ambiguous) {
      group.ambiguous++;
    }
    group.fresh += input.fresh;
    group.inp += input.inp;
    group.cache += input.cache;
    group.linesA += input.linesAdded;
    group.linesD += input.linesDeleted;
    group.turns += input.turns;
    group.tools += input.tools;
    if (input.pricedCost == null) {
      group.unpriced++;
      group.costSum += input.costLowerBound ?? 0;
    } else {
      group.priced++;
      group.costs.push(input.pricedCost);
      group.costSum += input.pricedCost;
      group.pricedCostSum += input.pricedCost;
    }
  }

  return [...groups.values()]
    .map((group) => finishGroup(group, totalCost))
    .sort((a, b) => b.costSum - a.costSum || compareAnalyticsKeys(a.key, b.key));
};

type ModelAnalyticsSourceRow = Pick<
  Row,
  | 'ambiguous'
  | 'costApprox'
  | 'costKnown'
  | 'harness'
  | 'model'
  | 'modelSegments'
  | 'models'
  | 'provider'
  | 'tokCr'
  | 'tokCw'
  | 'tokIn'
  | 'tokOut'
  | 'usageUnavailable'
>;

interface ModelAnalyticsItem {
  key: string;
  row: ModelAnalyticsSourceRow;
  segment: {
    costApprox: number;
    costKnown: boolean;
    tokCr: number;
    tokCw: number;
    tokIn: number;
    tokOut: number;
  };
}

const modelAnalyticsItemsForRow = (row: ModelAnalyticsSourceRow): ModelAnalyticsItem[] =>
  usageRowModelContributions(row).map(({ key, ...segment }) => ({ key, row, segment }));

/** Groups tokens and API value by the model segment that produced them. */
export const groupModelAnalytics = <T extends ModelAnalyticsSourceRow>(rows: readonly T[]): AnalyticsGroup[] => {
  const items = rows.flatMap(modelAnalyticsItemsForRow);
  const totalCost = items.reduce((total, { segment }) => total + segment.costApprox, 0);
  return groupAnalytics(
    items,
    ({ row, segment }) => ({
      ambiguous: row.ambiguous ?? false,
      cache: segment.tokCr,
      costLowerBound: segment.costApprox,
      fresh: segment.tokIn + segment.tokOut + segment.tokCw,
      harness: row.harness,
      inp: segment.tokIn,
      linesAdded: 0,
      linesDeleted: 0,
      pricedCost: segment.costKnown ? segment.costApprox : null,
      provider: row.provider,
      tools: 0,
      turns: 0,
      usageUnavailable: row.usageUnavailable ?? false,
    }),
    ({ key }) => key,
    totalCost,
  );
};

export const rowToAnalyticsInput = (row: Row): AnalyticsRowInput => {
  const lineDelta = usageRowLineDelta(row);
  return {
    harness: row.harness,
    provider: row.provider,
    usageUnavailable: row.usageUnavailable ?? false,
    ambiguous: row.ambiguous ?? false,
    fresh: usageRowFreshTokens(row),
    inp: row.tokIn,
    cache: usageRowCacheReadTokens(row),
    linesAdded: lineDelta.added,
    linesDeleted: lineDelta.deleted,
    turns: row.turns,
    tools: row.tools,
    pricedCost: usageRowPricedCost(row),
  };
};

const groupBy = (rows: Row[], keyFn: (row: Row) => string, totalCost: number): AnalyticsGroup[] =>
  groupAnalytics(rows, rowToAnalyticsInput, keyFn, totalCost);

export const calculateAnalytics = (rows: Row[], now = Date.now()): AnalyticsSummary => {
  const pricedCosts = rows.flatMap((row) => {
    const cost = usageRowPricedCost(row);
    return cost == null ? [] : [cost];
  });
  const totalCost = pricedCosts.reduce((total, cost) => total + cost, 0);
  const lines = rows.map(usageRowLineDelta);
  const linesA = lines.reduce((total, line) => total + line.added, 0);
  const linesD = lines.reduce((total, line) => total + line.deleted, 0);
  const lineCount = linesA + linesD;
  const turns = rows.reduce((total, row) => total + row.turns, 0);
  const tools = rows.reduce((total, row) => total + row.tools, 0);
  const durationRows = rows.filter((row) => row.durationMs && row.durationMs > 0);
  const durationMs = durationRows.reduce((total, row) => total + (row.durationMs || 0), 0);
  const recentSessions = rows.filter((row) => usageRowIsRecent(row, now)).length;

  return {
    sessionCount: rows.length,
    totalCost,
    pricedCount: pricedCosts.length,
    unpricedCount: rows.length - pricedCosts.length,
    meanCost: totalCost / (pricedCosts.length || 1),
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
    byModel: groupModelAnalytics(rows),
    byProvider: groupBy(rows, (row) => row.provider, totalCost),
    byHarness: groupBy(rows, (row) => row.harness, totalCost),
  };
};
