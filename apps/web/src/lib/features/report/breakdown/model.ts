import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { AnalyticsExportRow } from '@ai-usage/report-core/csv';
import { PARTIALLY_MEASURED_LABEL } from '@ai-usage/report-core/provenance';
import type { BreakdownSort } from '../../../../dashboard-search';
import {
  breakdownBarPresentation,
  breakdownModelLabel,
  breakdownPriceStateLabel,
  filterAndSortBreakdownGroups,
} from '../../../../group-panel-presentation';
import { fmtCompact, fmtNum, fmtPct } from '../../../foundation/presentation/format';
import { aggregateApiValuePresentation, USAGE_UNAVAILABLE_HINT } from '../../../foundation/presentation/report-value';

export interface BreakdownRowView {
  readonly ariaLabel: string;
  readonly cacheLabel: string;
  readonly freshLabel: string;
  readonly freshTitle: string;
  readonly group: AnalyticsGroup;
  readonly label: string;
  readonly priceState: 'measured' | 'partially measured' | 'unavailable' | 'zero';
  readonly pricingCoverage: string;
  readonly sessionSummary: string;
  readonly valueLabel: string;
  readonly valueTitle: string;
  readonly widthPercent: number | null;
}

const usageUnavailableOnly = (group: AnalyticsGroup): boolean => group.usageUnavailable === group.sessions;

export const projectBreakdownRow = (group: AnalyticsGroup, label: string, maxKnownCost: number): BreakdownRowView => {
  const unavailable = usageUnavailableOnly(group);
  const presentation = breakdownBarPresentation({
    knownCost: group.costSum,
    maxKnownCost,
    unpricedCount: group.unpriced,
    usageUnavailable: unavailable,
  });
  const value = aggregateApiValuePresentation({
    knownCost: group.costSum,
    state: presentation.state === 'partially measured' ? 'partially measured' : 'measured',
    unpricedFreshTokens: group.unpricedFreshTokens,
  });
  return {
    ariaLabel: `${breakdownPriceStateLabel(presentation.state)} API-value bar`,
    cacheLabel: unavailable ? '— cache' : `${fmtPct(group.cacheHitPct)} cache`,
    freshLabel: unavailable ? '— fresh' : `${fmtCompact(group.fresh)} fresh`,
    freshTitle: unavailable ? USAGE_UNAVAILABLE_HINT : `${fmtNum(group.fresh)} fresh tokens`,
    group,
    label,
    priceState: presentation.state,
    pricingCoverage:
      group.unpriced > 0
        ? ` · ${PARTIALLY_MEASURED_LABEL} (${fmtNum(group.priced)}/${fmtNum(group.sessions)} fully priced)`
        : '',
    sessionSummary: `${fmtNum(group.sessions)} ${group.sessions === 1 ? 'session' : 'sessions'}${
      group.ambiguous ? ` · ${fmtNum(group.ambiguous)} ambiguous` : ''
    }`,
    valueLabel: unavailable ? '—' : value.label,
    valueTitle: unavailable ? USAGE_UNAVAILABLE_HINT : value.title,
    widthPercent: presentation.widthPercent,
  };
};

export const breakdownRows = (
  groups: readonly AnalyticsGroup[],
  query: string,
  sort: BreakdownSort,
  dimension: 'harnesses' | 'models' | 'providers',
): readonly BreakdownRowView[] => {
  const labelFor = (group: AnalyticsGroup): string =>
    dimension === 'models' ? breakdownModelLabel(group.key) : group.key;
  const visible = filterAndSortBreakdownGroups(groups, query, sort, labelFor);
  const maxKnownCost = Math.max(0, ...visible.map((group) => group.costSum));
  return visible.map((group) => projectBreakdownRow(group, labelFor(group), maxKnownCost));
};

export const analyticsExportRows = (rows: readonly BreakdownRowView[]): readonly AnalyticsExportRow[] =>
  rows.map(({ group, label }) => ({ group, label }));

export { breakdownLabelMatchesSearch } from '../../../../group-panel-presentation';
