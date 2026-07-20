import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import type { SessionDetailTokenCounts } from '@ai-usage/report-core/session-detail';
import type { UsageModelSegment } from '@ai-usage/report-core/types';
import {
  addNonNegativeFiniteNumbers,
  addNonNegativeSafeIntegers,
  parseFiniteTimestamp,
  parseOptionalNonNegativeFiniteNumber,
  parseOptionalNonNegativeSafeInteger,
} from './metric-validation';
import { dominant, isJsonObject } from './text';

export interface OpenCodeMessageFact {
  completedMs: number | null;
  cost: number;
  createdMs: number | null;
  effort: string | null;
  id: string | null;
  model: string;
  modelId: string;
  parentId: string | null;
  providerId: string;
  reportedCostKnown: boolean;
  tokens: SessionDetailTokenCounts;
}

export type OpenCodeMessageDecodeResult =
  | { kind: 'fact'; value: OpenCodeMessageFact }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

export interface OpenCodeProjectionSummary {
  calls: number;
  costApprox: number;
  costKnown: boolean;
  dominantModelId: string;
  dominantProviderId: string;
  durationMs: number;
  endMs: number | null;
  modelSegments: UsageModelSegment[];
  models: string[];
  partial: boolean;
  providerCosts: ReadonlyMap<string, number>;
  providerCostsKnown: ReadonlyMap<string, boolean>;
  reportedCost: number;
  reportedCostKnown: boolean;
  startMs: number | null;
  tokens: SessionDetailTokenCounts;
}

export interface OpenCodeMillisecondInterval {
  endMs: number;
  startMs: number;
}

export type OpenCodeParentKind = 'human' | 'internal' | 'unresolved';

const MAX_OPEN_CODE_FACT_STRING_LENGTH = 512;
const OPEN_CODE_FLAT_TOKEN_KEYS = [
  'token_input',
  'token_output',
  'token_reasoning',
  'token_cache_read',
  'token_cache_write',
] as const;

const boundedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_OPEN_CODE_FACT_STRING_LENGTH ? normalized : null;
};

const timestampMs = (value: unknown): number | null => {
  const parsed = parseFiniteTimestamp(value);
  return parsed.ok ? parsed.value.getTime() : null;
};

const tokenValue = (tokens: Record<string, unknown>, flat: Record<string, unknown>, key: string): unknown => {
  if (key === 'cacheRead' || key === 'cacheWrite') {
    const cache = isJsonObject(tokens.cache) ? tokens.cache : null;
    return key === 'cacheRead' ? (cache?.read ?? flat.token_cache_read) : (cache?.write ?? flat.token_cache_write);
  }
  return tokens[key] ?? flat[`token_${key}`];
};

export const decodeOpenCodeMessageRow = (value: unknown): OpenCodeMessageDecodeResult => {
  if (!isJsonObject(value)) {
    return { kind: 'invalid' };
  }
  if (value.role !== 'assistant') {
    return { kind: 'ignored' };
  }
  const nestedTokens = isJsonObject(value.tokens) ? value.tokens : null;
  const hasFlatTokens = OPEN_CODE_FLAT_TOKEN_KEYS.some((key) => value[key] !== undefined && value[key] !== null);
  if (!(nestedTokens || hasFlatTokens)) {
    return { kind: 'ignored' };
  }
  const tokens = nestedTokens ?? value;
  const input = parseOptionalNonNegativeSafeInteger(tokenValue(tokens, value, 'input'));
  const output = parseOptionalNonNegativeSafeInteger(tokenValue(tokens, value, 'output'));
  const reasoning = parseOptionalNonNegativeSafeInteger(tokenValue(tokens, value, 'reasoning'));
  const cacheRead = parseOptionalNonNegativeSafeInteger(tokenValue(tokens, value, 'cacheRead'));
  const cacheWrite = parseOptionalNonNegativeSafeInteger(tokenValue(tokens, value, 'cacheWrite'));
  const cost = parseOptionalNonNegativeFiniteNumber(value.cost);
  if (!(input.ok && output.ok && reasoning.ok && cacheRead.ok && cacheWrite.ok && cost.ok)) {
    return { kind: 'invalid' };
  }
  const outputWithReasoning = addNonNegativeSafeIntegers(output.value, reasoning.value);
  const inputAndOutput = outputWithReasoning.ok
    ? addNonNegativeSafeIntegers(input.value, outputWithReasoning.value)
    : outputWithReasoning;
  const caches = addNonNegativeSafeIntegers(cacheRead.value, cacheWrite.value);
  if (!(outputWithReasoning.ok && inputAndOutput.ok && caches.ok)) {
    return { kind: 'invalid' };
  }
  const total = addNonNegativeSafeIntegers(inputAndOutput.value, caches.value);
  if (!total.ok) {
    return { kind: 'invalid' };
  }
  const time = isJsonObject(value.time) ? value.time : null;
  const providerId = boundedString(value.providerID ?? value.provider_id) ?? '?';
  const modelId = boundedString(value.modelID ?? value.model_id) ?? '?';
  return {
    kind: 'fact',
    value: {
      completedMs: timestampMs(time?.completed ?? value.completed),
      cost: cost.value,
      createdMs: timestampMs(time?.created ?? value.created),
      effort: boundedString(value.variant),
      id: boundedString(value.id),
      model: `${providerId}/${modelId}`,
      modelId,
      parentId: boundedString(value.parentID ?? value.parent_id),
      providerId,
      reportedCostKnown: value.cost !== undefined && value.cost !== null,
      tokens: {
        cacheRead: cacheRead.value,
        cacheWrite: cacheWrite.value,
        input: input.value,
        output: outputWithReasoning.value,
        total: total.value,
      },
    },
  };
};

export const mergeOpenCodeActivityIntervals = (
  intervals: readonly OpenCodeMillisecondInterval[],
): OpenCodeMillisecondInterval[] => {
  const ordered = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const first = ordered[0];
  if (!first) {
    return [];
  }
  const merged: OpenCodeMillisecondInterval[] = [];
  let currentStart = first.startMs;
  let currentEnd = first.endMs;
  for (const interval of ordered.slice(1)) {
    if (interval.startMs > currentEnd) {
      merged.push({ endMs: currentEnd, startMs: currentStart });
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      continue;
    }
    currentEnd = Math.max(currentEnd, interval.endMs);
  }
  merged.push({ endMs: currentEnd, startMs: currentStart });
  return merged;
};

export const openCodeActivityDuration = (intervals: readonly OpenCodeMillisecondInterval[]): number =>
  mergeOpenCodeActivityIntervals(intervals).reduce((total, interval) => total + interval.endMs - interval.startMs, 0);

export const openCodeParentKind = (
  parentId: string | null,
  userMessageIds: ReadonlySet<string>,
  directUserMessageIds: ReadonlySet<string>,
): OpenCodeParentKind => {
  if (parentId === null || !userMessageIds.has(parentId)) {
    return 'unresolved';
  }
  return directUserMessageIds.has(parentId) ? 'human' : 'internal';
};

export const buildOpenCodeProjectionSummary = (
  facts: readonly OpenCodeMessageFact[],
): OpenCodeProjectionSummary | null => {
  if (facts.length === 0) {
    return null;
  }
  const modelSegments = new Map<string, UsageModelSegment>();
  const modelWeights = new Map<string, number>();
  const providerCosts = new Map<string, number>();
  const providerCostsKnown = new Map<string, boolean>();
  const models: string[] = [];
  const tokens: SessionDetailTokenCounts = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 };
  let reportedCost = 0;
  let reportedCostKnown = true;
  let startMs: number | null = null;
  let endMs: number | null = null;
  let partial = false;
  const intervals: OpenCodeMillisecondInterval[] = [];
  for (const fact of facts) {
    const nextValues = {
      cacheRead: addNonNegativeSafeIntegers(tokens.cacheRead, fact.tokens.cacheRead),
      cacheWrite: addNonNegativeSafeIntegers(tokens.cacheWrite, fact.tokens.cacheWrite),
      input: addNonNegativeSafeIntegers(tokens.input, fact.tokens.input),
      output: addNonNegativeSafeIntegers(tokens.output, fact.tokens.output),
      total: addNonNegativeSafeIntegers(tokens.total, fact.tokens.total),
      reportedCost: addNonNegativeFiniteNumbers(reportedCost, fact.cost),
      providerCost: addNonNegativeFiniteNumbers(providerCosts.get(fact.providerId) ?? 0, fact.cost),
      modelWeight: addNonNegativeSafeIntegers(modelWeights.get(fact.model) ?? 0, fact.tokens.total),
    };
    if (
      !(
        nextValues.cacheRead.ok &&
        nextValues.cacheWrite.ok &&
        nextValues.input.ok &&
        nextValues.output.ok &&
        nextValues.total.ok &&
        nextValues.reportedCost.ok &&
        nextValues.providerCost.ok &&
        nextValues.modelWeight.ok
      )
    ) {
      return null;
    }
    tokens.cacheRead = nextValues.cacheRead.value;
    tokens.cacheWrite = nextValues.cacheWrite.value;
    tokens.input = nextValues.input.value;
    tokens.output = nextValues.output.value;
    tokens.total = nextValues.total.value;
    reportedCost = nextValues.reportedCost.value;
    reportedCostKnown = reportedCostKnown && fact.reportedCostKnown;
    providerCosts.set(fact.providerId, nextValues.providerCost.value);
    providerCostsKnown.set(
      fact.providerId,
      (providerCostsKnown.get(fact.providerId) ?? true) && fact.reportedCostKnown,
    );
    modelWeights.set(fact.model, nextValues.modelWeight.value);
    if (!models.includes(fact.model)) {
      models.push(fact.model);
    }
    const pricingAt = fact.completedMs ?? fact.createdMs;
    const pricing = priceFor(fact.modelId, { at: pricingAt === null ? null : new Date(pricingAt) });
    const current = modelSegments.get(fact.model) ?? {
      costApprox: 0,
      costKnown: true,
      model: fact.model,
      tokCr: 0,
      tokCw: 0,
      tokIn: 0,
      tokOut: 0,
    };
    const costApprox = addNonNegativeFiniteNumbers(
      current.costApprox,
      pricing.known
        ? approxCost(pricing.rates, {
            cr: fact.tokens.cacheRead,
            cw: fact.tokens.cacheWrite,
            in: fact.tokens.input,
            out: fact.tokens.output,
          })
        : 0,
    );
    const segmentValues = {
      cr: addNonNegativeSafeIntegers(current.tokCr, fact.tokens.cacheRead),
      cw: addNonNegativeSafeIntegers(current.tokCw, fact.tokens.cacheWrite),
      in: addNonNegativeSafeIntegers(current.tokIn, fact.tokens.input),
      out: addNonNegativeSafeIntegers(current.tokOut, fact.tokens.output),
    };
    if (!(costApprox.ok && segmentValues.cr.ok && segmentValues.cw.ok && segmentValues.in.ok && segmentValues.out.ok)) {
      return null;
    }
    modelSegments.set(fact.model, {
      ...current,
      costApprox: costApprox.value,
      costKnown: current.costKnown && (fact.tokens.total === 0 || pricing.known),
      tokCr: segmentValues.cr.value,
      tokCw: segmentValues.cw.value,
      tokIn: segmentValues.in.value,
      tokOut: segmentValues.out.value,
    });
    if (fact.createdMs === null) {
      partial = true;
    } else {
      startMs = startMs === null ? fact.createdMs : Math.min(startMs, fact.createdMs);
      const observedEnd = fact.completedMs ?? fact.createdMs;
      endMs = endMs === null ? observedEnd : Math.max(endMs, observedEnd);
      if (fact.completedMs !== null && fact.completedMs >= fact.createdMs) {
        intervals.push({ endMs: fact.completedMs, startMs: fact.createdMs });
      } else {
        partial = true;
      }
    }
  }
  const dominantModel = dominant(modelWeights) ?? models[0] ?? '?/?';
  const separator = dominantModel.indexOf('/');
  return {
    calls: facts.length,
    costApprox: [...modelSegments.values()].reduce((total, segment) => total + segment.costApprox, 0),
    costKnown: [...modelSegments.values()].every((segment) => segment.costKnown),
    dominantModelId: dominantModel.slice(separator + 1),
    dominantProviderId: dominantModel.slice(0, separator),
    durationMs: openCodeActivityDuration(intervals),
    endMs,
    modelSegments: models.flatMap((model) => {
      const segment = modelSegments.get(model);
      return segment ? [segment] : [];
    }),
    models,
    partial,
    providerCosts,
    providerCostsKnown,
    reportedCost,
    reportedCostKnown,
    startMs,
    tokens,
  };
};
