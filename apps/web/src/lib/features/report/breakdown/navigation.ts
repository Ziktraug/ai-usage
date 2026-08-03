import type { LocalTimeCell, SessionOrigin } from '@ai-usage/report-core/session-query';
import { applyTimelineDimensionFilter } from '../../../../dashboard-filter-navigation';
import {
  type BreakdownSort,
  type BreakdownTab,
  type DashboardSearch,
  type FieldFilterKey,
  fieldFilterKeys,
  parseDashboardTimeCell,
  serializeDashboardTimeCell,
  toggleExactFieldFilter,
  withoutDashboardTimeCell,
} from '../../../../dashboard-search';
import type { TimelineDimension } from '../../../../overview-model';
import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';

export interface BreakdownNavigation {
  readonly clearAllFilters: () => void;
  readonly clearColumnDiffs: () => void;
  readonly clearDateRange: () => void;
  readonly clearFieldFilter: (key: FieldFilterKey) => void;
  readonly clearHarness: (value: string) => void;
  readonly clearMachine: (value: string) => void;
  readonly clearOrigin: () => void;
  readonly clearTimeCell: () => void;
  readonly setBreakdownSort: (sort: BreakdownSort) => void;
  readonly setBreakdownTab: (tab: BreakdownTab) => void;
  readonly setColumnBase: (value: DashboardSearch['colsBase']) => void;
  readonly setDateRange: (range: DashboardSearch['range']) => void;
  readonly setFieldFilter: (key: FieldFilterKey, value: string) => void;
  readonly setHarness: (value: string[]) => void;
  readonly setMachine: (value: string[]) => void;
  readonly setOrigin: (value: SessionOrigin[]) => void;
  readonly setPrimaryTab: (tab: 'breakdown' | 'overview' | 'sessions') => void;
  readonly setQuery: (value: string, replace?: boolean) => void;
  readonly setTimeCell: (cell: LocalTimeCell) => void;
  readonly setTimelineDimensionFilter: (dimension: TimelineDimension, value: string) => void;
}

const withoutFieldFilter = (search: DashboardSearch, key: FieldFilterKey): DashboardSearch => {
  const filters = { ...search.filters };
  delete filters[key];
  return { ...search, filters };
};

export const clearDashboardFilters = (search: DashboardSearch): DashboardSearch =>
  withoutDashboardTimeCell({
    ...search,
    filters: {},
    harness: [],
    machine: [],
    origin: [],
    q: '',
    range: { mode: '30d' },
  });

const primaryTabValue = (
  search: DashboardSearch,
  tab: 'breakdown' | 'overview' | 'sessions',
): DashboardSearch['tab'] => {
  if (tab !== 'breakdown') {
    return tab;
  }
  return search.tab === 'overview' || search.tab === 'sessions' ? 'models' : search.tab;
};

export const createBreakdownNavigation = (
  updateSearch: SearchNavigationIntent<DashboardSearch>,
): BreakdownNavigation => {
  const update = (transform: (search: DashboardSearch) => DashboardSearch, replace?: boolean): void => {
    updateSearch(transform, replace === undefined ? undefined : { replace });
  };
  return {
    clearAllFilters: () => update(clearDashboardFilters),
    clearColumnDiffs: () => update((search) => ({ ...search, cols: [] }), true),
    clearDateRange: () => update((search) => ({ ...search, range: { mode: '30d' } })),
    clearFieldFilter: (key) => update((search) => withoutFieldFilter(search, key)),
    clearHarness: (value) =>
      update((search) => ({ ...search, harness: search.harness.filter((candidate) => candidate !== value) })),
    clearMachine: (value) =>
      update((search) => ({ ...search, machine: search.machine.filter((candidate) => candidate !== value) })),
    clearOrigin: () => update((search) => ({ ...search, origin: [] })),
    clearTimeCell: () => update(withoutDashboardTimeCell),
    setBreakdownSort: (breakdownSort) => update((search) => ({ ...search, breakdownSort })),
    setBreakdownTab: (tab) => update((search) => ({ ...search, tab })),
    setColumnBase: (colsBase) => update((search) => ({ ...search, cols: [], colsBase }), true),
    setDateRange: (range) => update((search) => ({ ...search, range })),
    setFieldFilter: (key, value) =>
      update((search) => ({ ...search, filters: toggleExactFieldFilter(search.filters, key, value) })),
    setHarness: (harness) => update((search) => ({ ...search, harness })),
    setMachine: (machine) => update((search) => ({ ...search, machine })),
    setOrigin: (origin) => update((search) => ({ ...search, origin })),
    setPrimaryTab: (tab) =>
      update((search) => ({
        ...search,
        tab: primaryTabValue(search, tab),
      })),
    setQuery: (q, replace) => update((search) => ({ ...search, q }), replace),
    setTimeCell: (cell) => update((search) => ({ ...search, timeCell: serializeDashboardTimeCell(cell) })),
    setTimelineDimensionFilter: (dimension, value) =>
      update((search) => applyTimelineDimensionFilter(search, dimension, value)),
  };
};

export const activeFieldFilters = (
  search: DashboardSearch,
): readonly { readonly key: FieldFilterKey; readonly value: string }[] =>
  fieldFilterKeys.flatMap((key) => {
    const value = search.filters[key];
    return value === undefined ? [] : [{ key, value }];
  });

export const selectedTimeCell = (search: DashboardSearch): LocalTimeCell | undefined =>
  parseDashboardTimeCell(search.timeCell);
