import type { LocalTimeCell, SessionOrigin } from '@ai-usage/report-core/session-query';
import { useNavigate, useSearch } from '@tanstack/solid-router';
import { type Accessor, createEffect, createMemo, createSignal } from 'solid-js';
import { applyTimelineDimensionFilter } from './dashboard-filter-navigation';
import {
  type BreakdownSort,
  type DashboardSearch,
  type FieldFilterKey,
  type FieldFilters,
  isDashboardTab,
  parseDashboardTimeCell,
  serializeDashboardTimeCell,
  sortingStateFromSearch,
  toggleExactFieldFilter,
  withoutDashboardTimeCell,
} from './dashboard-search';
import type { SearchNavigationIntent } from './lib/foundation/navigation/search-intent';
import {
  applyStateUpdate,
  type StateChangeHandler,
  type StateUpdater,
  type TableSortingState,
  type TableVisibilityState,
} from './lib/foundation/table/state';
import type { TimelineDimension } from './overview-model';
import {
  columnVisibilityFromDiff,
  columnVisibilitySearchForVisibility,
  sortFromSortingState,
} from './session-table-schema';

interface DashboardNavigationState {
  columnVisibility: Accessor<TableVisibilityState>;
  fieldFilters: Accessor<FieldFilters>;
  harness: Accessor<string[]>;
  localTimeCell: Accessor<LocalTimeCell | undefined>;
  machine: Accessor<string[]>;
  origin: Accessor<SessionOrigin[]>;
  query: Accessor<string>;
  search: Accessor<DashboardSearch>;
  sorting: Accessor<TableSortingState>;
}

export interface DashboardNavigationController extends DashboardNavigationState {
  clearFieldFilter: (key: FieldFilterKey) => void;
  clearLocalTimeCell: () => void;
  commitQueryEdit: () => void;
  handleColumnVisibilityChange: StateChangeHandler<TableVisibilityState>;
  handleSortingChange: StateChangeHandler<TableSortingState>;
  removeHarness: (value: string) => void;
  removeMachine: (value: string) => void;
  setBreakdownSort: (sort: BreakdownSort) => void;
  setFieldFilter: (key: FieldFilterKey, value: string) => void;
  setHarness: (value: string[]) => void;
  setLocalTimeCell: (cell: LocalTimeCell) => void;
  setMachine: (value: string[]) => void;
  setOrigin: (value: SessionOrigin[]) => void;
  setQuery: (value: string) => void;
  setTab: (tab: string) => void;
  setTimelineDimensionFilter: (dimension: TimelineDimension, value: string) => void;
  toggleHarness: (value: string) => void;
  updateSearch: SearchNavigationIntent<DashboardSearch>;
}

export const createDashboardNavigationController = (defaults: DashboardSearch): DashboardNavigationController => {
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const updateSearch: DashboardNavigationController['updateSearch'] = (updater, options) => {
    navigate({
      search: updater(search()),
      ...(options?.replace == null ? {} : { replace: options.replace }),
      resetScroll: options?.resetScroll ?? false,
    }).catch((error: unknown) => {
      console.error(error);
    });
  };
  const query = () => search().q;
  const harness = () => search().harness;
  const origin = () => search().origin;
  const machine = () => search().machine;
  const fieldFilters = () => search().filters;
  const localTimeCell = createMemo(() => parseDashboardTimeCell(search().timeCell));
  const sorting = createMemo(() => sortingStateFromSearch(search().sort));
  const [columnVisibility, setColumnVisibility] = createSignal(
    columnVisibilityFromDiff(search().cols, search().colsBase),
  );
  createEffect(() => {
    setColumnVisibility(columnVisibilityFromDiff(search().cols, search().colsBase));
  });

  let activeQueryEdit = false;
  const commitQueryEdit = (): void => {
    activeQueryEdit = false;
  };
  const setQuery = (value: string): void => {
    const replace = activeQueryEdit;
    activeQueryEdit = true;
    updateSearch((current) => ({ ...current, q: value }), { replace });
  };
  const setHarness = (value: string[]): void => updateSearch((current) => ({ ...current, harness: value }));
  const toggleHarness = (value: string): void =>
    updateSearch((current) => applyTimelineDimensionFilter(current, 'harness', value));
  const removeHarness = (value: string): void => setHarness(harness().filter((current) => current !== value));
  const setOrigin = (value: SessionOrigin[]): void => updateSearch((current) => ({ ...current, origin: value }));
  const setMachine = (value: string[]): void => updateSearch((current) => ({ ...current, machine: value }));
  const removeMachine = (value: string): void => setMachine(machine().filter((current) => current !== value));
  const setLocalTimeCell = (cell: LocalTimeCell): void =>
    updateSearch((current) => ({ ...current, timeCell: serializeDashboardTimeCell(cell) }));
  const clearLocalTimeCell = (): void => updateSearch((current) => withoutDashboardTimeCell(current));
  const setFieldFilters = (updater: StateUpdater<FieldFilters>): void =>
    updateSearch((current) => ({ ...current, filters: applyStateUpdate(updater, current.filters) }));
  const setFieldFilter = (key: FieldFilterKey, value: string): void =>
    setFieldFilters((current) => toggleExactFieldFilter(current, key, value));
  const setTimelineDimensionFilter = (dimension: TimelineDimension, value: string): void =>
    updateSearch((current) => applyTimelineDimensionFilter(current, dimension, value));
  const clearFieldFilter = (key: FieldFilterKey): void =>
    setFieldFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const handleSortingChange: StateChangeHandler<TableSortingState> = (updater) =>
    updateSearch((current) => ({
      ...current,
      sort: sortFromSortingState(applyStateUpdate(updater, sortingStateFromSearch(current.sort)), defaults.sort),
    }));
  const handleColumnVisibilityChange: StateChangeHandler<TableVisibilityState> = (updater) => {
    const nextVisibility = applyStateUpdate(updater, columnVisibility());
    setColumnVisibility(nextVisibility);
    updateSearch((current) => ({ ...current, ...columnVisibilitySearchForVisibility(nextVisibility) }), {
      replace: true,
    });
  };
  const setTab = (tab: string): void => {
    if (isDashboardTab(tab)) {
      updateSearch((current) => ({ ...current, tab }));
    }
  };
  const setBreakdownSort = (breakdownSort: BreakdownSort): void =>
    updateSearch((current) => ({ ...current, breakdownSort }));

  return {
    clearFieldFilter,
    clearLocalTimeCell,
    columnVisibility,
    commitQueryEdit,
    fieldFilters,
    handleColumnVisibilityChange,
    handleSortingChange,
    harness,
    localTimeCell,
    machine,
    origin,
    query,
    removeHarness,
    removeMachine,
    search,
    setBreakdownSort,
    setFieldFilter,
    setHarness,
    setLocalTimeCell,
    setMachine,
    setOrigin,
    setQuery,
    setTab,
    setTimelineDimensionFilter,
    sorting,
    toggleHarness,
    updateSearch,
  };
};
