import { activeFilterButton } from '@ai-usage/design-system/report';
import type { FieldFilterKey, FieldFilters } from './dashboard-search';
import type { DashboardRow } from './shared';

export const fieldValueForRow = (row: DashboardRow, key: FieldFilterKey) => {
  if (key === 'provider') return row.providerDisplay;
  if (key === 'model') return row.modelKey;
  return row.projectKey;
};

export type FilterSnapshot = {
  fieldEntries: [FieldFilterKey, string][];
  harness: string;
  query: string;
};

export const createFilterSnapshot = (query: string, harness: string, filters: FieldFilters): FilterSnapshot => ({
  fieldEntries: Object.entries(filters) as [FieldFilterKey, string][],
  harness,
  query: query.trim().toLowerCase(),
});

export const matchesFilterSnapshot = (row: DashboardRow, filters: FilterSnapshot) =>
  row.searchText.includes(filters.query) &&
  (filters.harness === 'all' || row.harness === filters.harness) &&
  filters.fieldEntries.every(([key, value]) => fieldValueForRow(row, key) === value);

export const fieldFilterLabels: Record<FieldFilterKey, string> = {
  provider: 'Provider',
  model: 'Model',
  project: 'Project',
};

export const FilterPill = (props: { label: string; value: string; onClear: () => void }) => (
  <button
    class={activeFilterButton}
    type="button"
    title={`Clear ${props.label} filter`}
    onClick={() => props.onClear()}
  >
    {props.label}: {props.value} ×
  </button>
);
