import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { ApiPriceMeasurementState } from '@ai-usage/report-core/provenance';
import type { BreakdownSort } from './dashboard-search';

export type BreakdownPriceState = ApiPriceMeasurementState | 'unavailable';

export interface BreakdownBarPresentation {
  state: BreakdownPriceState;
  widthPercent: number | null;
}

interface BreakdownPriceInput {
  knownCost: number;
  unpricedCount: number;
  usageUnavailable: boolean;
}

interface BreakdownBarInput extends BreakdownPriceInput {
  maxKnownCost: number;
}

type BreakdownGroupComparator = (left: AnalyticsGroup, right: AnalyticsGroup) => number;

const breakdownSortComparators: Record<BreakdownSort, BreakdownGroupComparator> = {
  sessions: (left, right) => right.sessions - left.sessions || right.fresh - left.fresh,
  tokens: (left, right) => right.fresh - left.fresh || right.costSum - left.costSum,
  value: (left, right) => right.costSum - left.costSum || right.fresh - left.fresh,
};

export const sortBreakdownGroups = (groups: readonly AnalyticsGroup[], sort: BreakdownSort): AnalyticsGroup[] =>
  [...groups].sort((left, right) => breakdownSortComparators[sort](left, right) || left.key.localeCompare(right.key));

type BreakdownGroupLabel = (group: AnalyticsGroup) => string;

const defaultBreakdownGroupLabel: BreakdownGroupLabel = (group) => group.key;
const normalizeBreakdownSearchText = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase();

export const filterAndSortBreakdownGroups = (
  groups: readonly AnalyticsGroup[],
  query: string,
  sort: BreakdownSort,
  labelFor: BreakdownGroupLabel = defaultBreakdownGroupLabel,
): AnalyticsGroup[] => {
  const normalizedQuery = normalizeBreakdownSearchText(query);
  const matchingGroups =
    normalizedQuery.length === 0
      ? groups
      : groups.filter((group) => normalizeBreakdownSearchText(labelFor(group)).includes(normalizedQuery));
  return sortBreakdownGroups(matchingGroups, sort);
};
const MAX_PERCENT = 100;

export const breakdownPriceState = ({
  knownCost,
  unpricedCount,
  usageUnavailable,
}: BreakdownPriceInput): BreakdownPriceState => {
  if (usageUnavailable) {
    return 'unavailable';
  }
  if (unpricedCount > 0) {
    return 'partially measured';
  }
  return knownCost === 0 ? 'zero' : 'measured';
};

export const breakdownBarPresentation = ({
  knownCost,
  maxKnownCost,
  unpricedCount,
  usageUnavailable,
}: BreakdownBarInput): BreakdownBarPresentation => {
  const state = breakdownPriceState({ knownCost, unpricedCount, usageUnavailable });
  if (state === 'unavailable') {
    return { state, widthPercent: null };
  }
  const widthPercent =
    maxKnownCost > 0 ? Math.min(MAX_PERCENT, Math.max(0, (knownCost / maxKnownCost) * MAX_PERCENT)) : 0;
  return { state, widthPercent };
};

export const breakdownPriceStateLabel = (state: BreakdownPriceState): string => {
  if (state === 'unavailable') {
    return 'Unavailable';
  }
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
