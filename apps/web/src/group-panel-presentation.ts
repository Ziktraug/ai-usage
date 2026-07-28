import type { ApiPriceMeasurementState } from '@ai-usage/report-core/provenance';

export interface BreakdownBarPresentation {
  state: ApiPriceMeasurementState;
  widthPercent: number;
}

interface BreakdownPriceInput {
  knownCost: number;
  unpricedCount: number;
}

interface BreakdownBarInput extends BreakdownPriceInput {
  maxKnownCost: number;
}

const MAX_PERCENT = 100;

export const breakdownPriceState = ({ knownCost, unpricedCount }: BreakdownPriceInput): ApiPriceMeasurementState => {
  if (unpricedCount > 0) {
    return 'partially measured';
  }
  return knownCost === 0 ? 'zero' : 'measured';
};

export const breakdownBarPresentation = ({
  knownCost,
  maxKnownCost,
  unpricedCount,
}: BreakdownBarInput): BreakdownBarPresentation => {
  const state = breakdownPriceState({ knownCost, unpricedCount });
  const widthPercent =
    maxKnownCost > 0 ? Math.min(MAX_PERCENT, Math.max(0, (knownCost / maxKnownCost) * MAX_PERCENT)) : 0;
  return { state, widthPercent };
};

export const breakdownPriceStateLabel = (state: ApiPriceMeasurementState): string => {
  if (state === 'partially measured') {
    return 'Partially measured';
  }
  return state === 'zero' ? 'Zero' : 'Measured';
};

export const breakdownModelLabel = (modelKey: string): string => {
  const normalized = modelKey.trim().toLowerCase();
  if (normalized === '<synthetic>') {
    return 'Unattributed model';
  }
  if (normalized === 'codex') {
    return 'Unspecified Codex model';
  }
  return modelKey;
};
