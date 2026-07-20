import { modelGroupKey } from './model-identity';
import { approxCost, priceFor } from './pricing';
import type { Row, TitleSource, UsageModelSegment } from './types';

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
  /** Sum of segments with known API pricing; a lower bound when costKnown is false. */
  costApprox?: number;
  /** True only when every token-bearing segment has known API pricing. */
  costKnown?: boolean;
  costQuota?: number | null;
  date: Date | null;
  durationMs?: number | null;
  endDate: Date | null;
  harness: string;
  linesAdded?: number | null;
  linesDeleted?: number | null;
  model: string;
  modelSegments?: UsageModelSegment[];
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

export const MAX_USAGE_MODEL_SEGMENTS = 64;
export const UNSEGMENTED_MULTI_MODEL_LABEL = '(multi-model, unsegmented)';

type ModelSegmentRow = Pick<
  Row,
  'costApprox' | 'costKnown' | 'model' | 'modelSegments' | 'models' | 'tokCr' | 'tokCw' | 'tokIn' | 'tokOut'
>;

const fallbackModelSegment = (row: ModelSegmentRow): UsageModelSegment => ({
  costApprox: row.costApprox,
  costKnown: row.costKnown,
  model: row.models && new Set(row.models).size > 1 ? UNSEGMENTED_MULTI_MODEL_LABEL : (row.models?.[0] ?? row.model),
  tokCr: row.tokCr,
  tokCw: row.tokCw,
  tokIn: row.tokIn,
  tokOut: row.tokOut,
});

/**
 * Returns truthful model contributions for analytics. Legacy multi-model rows
 * without segment attribution stay in an explicit unsegmented bucket instead
 * of assigning all of their usage to the dominant model.
 */
export const usageRowModelSegments = (row: ModelSegmentRow): readonly UsageModelSegment[] =>
  row.modelSegments?.length ? row.modelSegments : [fallbackModelSegment(row)];

const segmentCostKnown = (segment: UsageModelSegment): boolean =>
  tokenTotal({ cr: segment.tokCr, cw: segment.tokCw, in: segment.tokIn, out: segment.tokOut }) === 0 ||
  segment.costKnown;

const combineModelSegments = (model: string, segments: readonly UsageModelSegment[]): UsageModelSegment => {
  const combined: UsageModelSegment = {
    costApprox: 0,
    costKnown: true,
    model,
    tokCr: 0,
    tokCw: 0,
    tokIn: 0,
    tokOut: 0,
  };
  for (const segment of segments) {
    combined.costApprox += segment.costApprox;
    combined.costKnown = combined.costKnown && segmentCostKnown(segment);
    combined.tokCr += segment.tokCr;
    combined.tokCw += segment.tokCw;
    combined.tokIn += segment.tokIn;
    combined.tokOut += segment.tokOut;
  }
  return combined;
};

const mergeDuplicateModelSegments = (segments: readonly UsageModelSegment[]): UsageModelSegment[] => {
  const segmentsByModel = new Map<string, UsageModelSegment[]>();
  for (const segment of segments) {
    const matchingSegments = segmentsByModel.get(segment.model) ?? [];
    matchingSegments.push(segment);
    segmentsByModel.set(segment.model, matchingSegments);
  }
  return [...segmentsByModel].map(([model, matchingSegments]) => combineModelSegments(model, matchingSegments));
};

const boundedModelSegments = (segments: readonly UsageModelSegment[], dominantModel: string): UsageModelSegment[] => {
  const mergedSegments = mergeDuplicateModelSegments(segments);
  if (mergedSegments.length <= MAX_USAGE_MODEL_SEGMENTS) {
    return mergedSegments;
  }

  const explicitSegmentLimit = MAX_USAGE_MODEL_SEGMENTS - 1;
  const explicitCandidates = mergedSegments.filter((segment) => segment.model !== UNSEGMENTED_MULTI_MODEL_LABEL);
  const retainedSegments = explicitCandidates.slice(0, explicitSegmentLimit);
  const dominantSegment = explicitCandidates.find((segment) => segment.model === dominantModel);
  if (dominantSegment && !retainedSegments.some((segment) => segment.model === dominantModel)) {
    retainedSegments[retainedSegments.length - 1] = dominantSegment;
  }
  const retainedModels = new Set(retainedSegments.map((segment) => segment.model));
  const overflowSegments = mergedSegments.filter((segment) => !retainedModels.has(segment.model));
  return [...retainedSegments, combineModelSegments(UNSEGMENTED_MULTI_MODEL_LABEL, overflowSegments)];
};

export interface UsageModelContribution extends UsageModelSegment {
  key: string;
}

/** Combines source model variants that share the same presentation key. */
export const usageRowModelContributions = (row: ModelSegmentRow): UsageModelContribution[] => {
  const contributions = new Map<string, UsageModelContribution>();
  for (const segment of usageRowModelSegments(row)) {
    const key = modelGroupKey(segment.model);
    const current = contributions.get(key) ?? {
      costApprox: 0,
      costKnown: true,
      key,
      model: segment.model,
      tokCr: 0,
      tokCw: 0,
      tokIn: 0,
      tokOut: 0,
    };
    current.costApprox += segment.costApprox;
    current.costKnown = current.costKnown && segmentCostKnown(segment);
    current.tokCr += segment.tokCr;
    current.tokCw += segment.tokCw;
    current.tokIn += segment.tokIn;
    current.tokOut += segment.tokOut;
    contributions.set(key, current);
  }
  return [...contributions.values()];
};

const segmentTokenCounts = (segments: readonly UsageModelSegment[]): TokenCounts => {
  const tokens: TokenCounts = { cr: 0, cw: 0, in: 0, out: 0 };
  for (const segment of segments) {
    tokens.cr += segment.tokCr;
    tokens.cw += segment.tokCw;
    tokens.in += segment.tokIn;
    tokens.out += segment.tokOut;
  }
  return tokens;
};

const costActual = (cost: UsageCostInput, costApprox: number, costKnown: boolean) => {
  if (cost._tag !== 'ApproximateApiCost') {
    return cost.amount;
  }
  return costKnown ? costApprox : null;
};

export const normalizeUsageRow = (input: UsageRowInput): Row => {
  const { rates, known } = priceFor(input.pricingModel ?? input.model, { at: input.endDate ?? input.date });
  const segments = input.modelSegments?.length ? boundedModelSegments(input.modelSegments, input.model) : undefined;
  const segmentModels = segments?.map((segment) => segment.model);
  const model = segmentModels?.includes(input.model) ? input.model : (segmentModels?.[0] ?? input.model);
  const models = input.models === undefined ? undefined : (segmentModels ?? [...new Set([model, ...input.models])]);
  const tokens = segments ? segmentTokenCounts(segments) : input.tokens;
  const costApprox = segments
    ? segments.reduce((total, segment) => total + segment.costApprox, 0)
    : (input.costApprox ?? approxCost(rates, input.tokens));
  const normalizedCostKnown = segments ? segments.every(segmentCostKnown) : (input.costKnown ?? known);
  let computedDurationMs = input.durationMs;
  if (computedDurationMs === undefined) {
    computedDurationMs = input.date && input.endDate ? input.endDate.getTime() - input.date.getTime() : null;
  }
  // A duration where the end precedes the start is not a real elapsed time (clock skew or
  // reversed source timestamps); treat it as unknown so it never persists as a negative metric.
  const durationMs = computedDurationMs !== null && computedDurationMs >= 0 ? computedDurationMs : null;

  return {
    date: input.date,
    endDate: input.endDate,
    harness: input.harness,
    provider: input.provider,
    name: input.name,
    model,
    ...(segments === undefined ? {} : { modelSegments: segments }),
    ...(models === undefined ? {} : { models }),
    project: input.project ?? '',
    tokIn: tokens.in,
    tokOut: tokens.out,
    tokCr: tokens.cr,
    tokCw: tokens.cw,
    costActual: costActual(input.cost, costApprox, normalizedCostKnown),
    ...(input.costQuota === undefined ? {} : { costQuota: input.costQuota }),
    costApprox,
    costKnown: normalizedCostKnown,
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
