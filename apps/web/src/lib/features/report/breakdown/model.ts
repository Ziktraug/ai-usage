import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { AnalyticsExportRow } from '@ai-usage/report-core/csv';
import type { BreakdownSort } from '../../../../dashboard-search';
import {
  breakdownBarPresentation,
  breakdownModelLabel,
  breakdownPriceStateLabel,
  filterAndSortBreakdownGroups,
} from '../../../../group-panel-presentation';

export interface BreakdownRowView {
  readonly ariaLabel: string;
  readonly group: AnalyticsGroup;
  readonly label: string;
  readonly priceState: 'measured' | 'partially measured' | 'unavailable' | 'zero';
  readonly widthPercent: number | null;
}

const usageUnavailableOnly = (group: AnalyticsGroup): boolean => group.usageUnavailable === group.sessions;

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
  return visible.map((group) => {
    const presentation = breakdownBarPresentation({
      knownCost: group.costSum,
      maxKnownCost,
      unpricedCount: group.unpriced,
      usageUnavailable: usageUnavailableOnly(group),
    });
    return {
      ariaLabel: `${breakdownPriceStateLabel(presentation.state)} API-value bar`,
      group,
      label: labelFor(group),
      priceState: presentation.state,
      widthPercent: presentation.widthPercent,
    };
  });
};

export const analyticsExportRows = (rows: readonly BreakdownRowView[]): readonly AnalyticsExportRow[] =>
  rows.map(({ group, label }) => ({ group, label }));

export { breakdownLabelMatchesSearch } from '../../../../group-panel-presentation';
