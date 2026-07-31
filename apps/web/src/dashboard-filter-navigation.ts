import { isSessionOrigin, type SessionOrigin } from '@ai-usage/report-core/session-query';
import { type DashboardSearch, type FieldFilterKey, toggleExactFieldFilter } from './dashboard-search';
import type { TimelineDimension } from './overview-model';

const toggleValue = <Value extends string>(values: readonly Value[], value: Value): Value[] =>
  values.includes(value) ? values.filter((current) => current !== value) : [...values, value];

const toggleField = (search: DashboardSearch, key: FieldFilterKey, value: string): DashboardSearch => ({
  ...search,
  filters: toggleExactFieldFilter(search.filters, key, value),
});

export const applyTimelineDimensionFilter = (
  search: DashboardSearch,
  dimension: TimelineDimension,
  value: string,
): DashboardSearch => {
  switch (dimension) {
    case 'campaign': {
      const campaignPrefix = 'campaign:';
      return toggleField(
        search,
        'campaign',
        value.startsWith(campaignPrefix) ? value.slice(campaignPrefix.length) : value,
      );
    }
    case 'origin': {
      if (!isSessionOrigin(value)) {
        return search;
      }
      const origin: SessionOrigin[] =
        search.origin.length === 0 || !search.origin.includes(value) ? [value] : toggleValue(search.origin, value);
      return { ...search, origin };
    }
    case 'harness':
      return { ...search, harness: toggleValue(search.harness, value) };
    case 'machine':
      return { ...search, machine: toggleValue(search.machine, value) };
    case 'model':
    case 'project':
    case 'provider':
      return toggleField(search, dimension, value);
    default:
      return search;
  }
};
