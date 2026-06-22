import { approxCost, priceFor } from './pricing';
import type { Row, TitleSource } from './types';

export interface TokenCounts {
  cr: number;
  cw: number;
  in: number;
  out: number;
}

export type UsageCostInput =
  | { readonly _tag: 'ActualCost'; readonly amount: number | null }
  | { readonly _tag: 'ApproximateApiCost' };

export const actualCost = (amount: number | null): UsageCostInput => ({ _tag: 'ActualCost', amount });
export const approximateApiCost: UsageCostInput = { _tag: 'ApproximateApiCost' };

export interface UsageRowInput {
  ambiguous?: boolean;
  calls: number;
  cost: UsageCostInput;
  costApprox?: number;
  costKnown?: boolean;
  costQuota?: number | null;
  date: Date | null;
  durationMs?: number | null;
  endDate: Date | null;
  harness: string;
  linesAdded?: number | null;
  linesDeleted?: number | null;
  model: string;
  models?: string[];
  name: string;
  partial?: boolean;
  pricingModel?: string;
  project?: string | null;
  provider: string;
  subagent?: boolean;
  titleSource?: TitleSource;
  tokens: TokenCounts;
  tools?: number;
  turns?: number;
  usageUnavailable?: boolean;
}

export interface UsageRowLineDelta {
  added: number;
  deleted: number;
  present: boolean;
  total: number;
}

export const tokenTotal = (tokens: TokenCounts) => tokens.in + tokens.out + tokens.cr + tokens.cw;

const costActual = (cost: UsageCostInput, costApprox: number) =>
  cost._tag === 'ApproximateApiCost' ? costApprox : cost.amount;

export const normalizeUsageRow = (input: UsageRowInput): Row => {
  const { rates, known } = priceFor(input.pricingModel ?? input.model);
  const costApprox = input.costApprox ?? approxCost(rates, input.tokens);
  const durationMs =
    input.durationMs ?? (input.date && input.endDate ? input.endDate.getTime() - input.date.getTime() : null);

  return {
    date: input.date,
    endDate: input.endDate,
    harness: input.harness,
    provider: input.provider,
    name: input.name,
    model: input.model,
    ...(input.models === undefined ? {} : { models: input.models }),
    project: input.project ?? '',
    tokIn: input.tokens.in,
    tokOut: input.tokens.out,
    tokCr: input.tokens.cr,
    tokCw: input.tokens.cw,
    costActual: costActual(input.cost, costApprox),
    ...(input.costQuota === undefined ? {} : { costQuota: input.costQuota }),
    costApprox,
    costKnown: input.costKnown ?? known,
    calls: input.calls,
    durationMs,
    turns: input.turns ?? 0,
    tools: input.tools ?? 0,
    linesAdded: input.linesAdded ?? null,
    linesDeleted: input.linesDeleted ?? null,
    ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
    ...(input.partial === undefined ? {} : { partial: input.partial }),
    ...(input.usageUnavailable === undefined ? {} : { usageUnavailable: input.usageUnavailable }),
    ...(input.ambiguous === undefined ? {} : { ambiguous: input.ambiguous }),
    ...(input.titleSource === undefined ? {} : { titleSource: input.titleSource }),
  };
};

export const usageRowTokens = (row: Row): TokenCounts => ({
  in: row.tokIn,
  out: row.tokOut,
  cr: row.tokCr,
  cw: row.tokCw,
});

export const usageRowTokenTotal = (row: Row) => tokenTotal(usageRowTokens(row));
export const usageRowFreshTokens = (row: Row) => row.tokIn + row.tokOut + row.tokCw;
export const usageRowCacheReadTokens = (row: Row) => row.tokCr;
export const usageRowActiveDate = (row: Row) => row.endDate ?? row.date;

export const usageRowIsRecent = (row: Row, now = Date.now(), windowMs = 5 * 60_000) => {
  const activeAt = usageRowActiveDate(row)?.getTime() ?? 0;
  return activeAt >= now - windowMs;
};

export const usageRowLineDelta = (row: Row): UsageRowLineDelta => {
  const present = row.linesAdded != null || row.linesDeleted != null;
  const added = row.linesAdded ?? 0;
  const deleted = row.linesDeleted ?? 0;
  return { present, added, deleted, total: added + deleted };
};

export const usageRowPricedCost = (row: Row) => (row.costKnown ? row.costApprox : null);

export const usageRowMarkers = (row: Row) => ({
  partial: row.partial ?? false,
  subagent: row.subagent ?? false,
  usageUnavailable: row.usageUnavailable ?? false,
  ambiguous: row.ambiguous ?? false,
});

export const usageRowSessionLabel = (row: Row) => {
  const markers = usageRowMarkers(row);
  return (
    row.name +
    (markers.partial ? ' ~' : '') +
    (markers.subagent ? ' ↳' : '') +
    (markers.ambiguous ? ' ?' : '') +
    (markers.usageUnavailable ? ' (usage unavailable)' : '')
  );
};
