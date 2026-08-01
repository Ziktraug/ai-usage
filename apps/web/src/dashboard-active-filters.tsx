import { activeFilters, filterSummary, ghostButton, summaryPill } from '@ai-usage/design-system/report';
import { For, Show } from 'solid-js';
import { FilterPill, fieldFilterLabels } from './dashboard-filters';
import {
  type DashboardSearch,
  dashboardTimeCellLabel,
  type FieldFilterKey,
  fieldFilterKeys,
  hasActiveDashboardFilters,
  parseDashboardTimeCell,
} from './dashboard-search';
import { fmtNum } from './shared';

interface DashboardFilterActions {
  clearAll: () => void;
  clearField: (key: FieldFilterKey) => void;
  clearHarness: (value: string) => void;
  clearMachine: (value: string) => void;
  clearTimeCell: () => void;
  setQuery: (value: string) => void;
}

interface DashboardFilterCounts {
  hidden: number;
  pending: boolean;
  total: number;
  visible: number;
}

export interface DashboardActiveFiltersProps {
  actions: DashboardFilterActions;
  counts: DashboardFilterCounts;
  presentMachineLabel: (value: string) => string;
  search: DashboardSearch;
}

export const DashboardActiveFilters = (props: DashboardActiveFiltersProps) => {
  const localTimeCell = () => parseDashboardTimeCell(props.search.timeCell);
  const activeFieldFilters = () =>
    fieldFilterKeys.flatMap((key) => {
      const value = props.search.filters[key];
      return value === undefined ? [] : [{ key, value }];
    });

  return (
    <div class={filterSummary}>
      <Show when={!props.counts.pending}>
        <span aria-live="polite" class={summaryPill}>
          {fmtNum(props.counts.visible)} / {fmtNum(props.counts.total)} sessions
        </span>
        <Show when={props.counts.hidden > 0}>
          <span>{fmtNum(props.counts.hidden)} hidden by filters</span>
        </Show>
      </Show>
      <div class={activeFilters}>
        <Show when={props.search.q}>
          <FilterPill label="Query" onClear={() => props.actions.setQuery('')} value={props.search.q} />
        </Show>
        <Show when={localTimeCell()}>
          {(cell) => (
            <FilterPill
              label="Time"
              onClear={props.actions.clearTimeCell}
              separator=" · "
              value={dashboardTimeCellLabel(cell())}
            />
          )}
        </Show>
        <For each={props.search.harness}>
          {(value) => <FilterPill label="Harness" onClear={() => props.actions.clearHarness(value)} value={value} />}
        </For>
        <For each={props.search.machine}>
          {(value) => (
            <FilterPill
              label="Machine"
              onClear={() => props.actions.clearMachine(value)}
              value={props.presentMachineLabel(value)}
            />
          )}
        </For>
        <For each={activeFieldFilters()}>
          {({ key, value }) => (
            <FilterPill label={fieldFilterLabels[key]} onClear={() => props.actions.clearField(key)} value={value} />
          )}
        </For>
      </div>
      <Show when={hasActiveDashboardFilters(props.search)}>
        <button class={ghostButton} onClick={props.actions.clearAll} type="button">
          Clear all
        </button>
      </Show>
    </div>
  );
};
