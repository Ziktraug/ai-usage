import { isSessionOrigin, type SessionOrigin } from '@ai-usage/report-core/session-query';
import { type DashboardSearch, type FieldFilterKey, toggleExactFieldFilter } from './dashboard-search';
import type { TimelineDimension } from './overview-model';

const toggleValue = <Value extends string>(values: readonly Value[], value: Value): Value[] =>
  values.includes(value) ? values.filter((current) => current !== value) : [...values, value];

const toggleField = (search: DashboardSearch, key: FieldFilterKey, value: string): DashboardSearch => ({
  ...search,
  filters: toggleExactFieldFilter(search.filters, key, value),
});

type TimelineDimensionFilterHandler = (search: DashboardSearch, value: string) => DashboardSearch;

const timelineDimensionFilterHandlers: Record<TimelineDimension, TimelineDimensionFilterHandler> = {
  campaign: (search, value) => {
    const campaignPrefix = 'campaign:';
    return toggleField(
      search,
      'campaign',
      value.startsWith(campaignPrefix) ? value.slice(campaignPrefix.length) : value,
    );
  },
  harness: (search, value) => ({ ...search, harness: toggleValue(search.harness, value) }),
  machine: (search, value) => ({ ...search, machine: toggleValue(search.machine, value) }),
  model: (search, value) => toggleField(search, 'model', value),
  origin: (search, value) => {
    if (!isSessionOrigin(value)) {
      return search;
    }
    const origin: SessionOrigin[] =
      search.origin.length === 0 || !search.origin.includes(value) ? [value] : toggleValue(search.origin, value);
    return { ...search, origin };
  },
  project: (search, value) => toggleField(search, 'project', value),
  provider: (search, value) => toggleField(search, 'provider', value),
};

export const applyTimelineDimensionFilter = (
  search: DashboardSearch,
  dimension: TimelineDimension,
  value: string,
): DashboardSearch => timelineDimensionFilterHandlers[dimension](search, value);
