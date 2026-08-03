<script lang="ts">
  import {
    type DashboardSearch,
    dashboardTimeCellLabel,
    hasActiveDashboardFilters,
  } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import type { BreakdownNavigation } from './navigation';
  import { activeFieldFilters, selectedTimeCell } from './navigation';
  import { button, muted, pill, row, stack } from './styles';

  let {
    hidden,
    navigation,
    pending = false,
    presentMachineLabel,
    search,
    total,
    visible,
  }: {
    hidden: number;
    navigation: BreakdownNavigation;
    pending?: boolean;
    presentMachineLabel: (value: string) => string;
    search: DashboardSearch;
    total: number;
    visible: number;
  } = $props();
  const timeCell = $derived(selectedTimeCell(search));
  const fieldLabels = { campaign: 'Campaign', model: 'Model', project: 'Project', provider: 'Provider' } as const;
</script>

<div class={stack} data-active-filters>
  {#if !pending}
    <div class={row}>
      <span aria-live="polite">{fmtNum(visible)} / {fmtNum(total)} sessions</span>
      {#if hidden > 0}
        <span class={muted}>{fmtNum(hidden)} hidden by filters</span>
      {/if}
    </div>
  {/if}
  <div class={row}>
    {#if search.q}
      <button class={pill} onclick={() => navigation.setQuery('')} title="Clear Query filter" type="button">
        Query: {search.q} ×
      </button>
    {/if}
    {#if timeCell}
      <button class={pill} onclick={navigation.clearTimeCell} title="Clear Time filter" type="button">
        Time · {dashboardTimeCellLabel(timeCell)} ×
      </button>
    {/if}
    {#each search.harness as value (value)}
      <button class={pill} onclick={() => navigation.clearHarness(value)} title="Clear Harness filter" type="button">
        Harness: {value} ×
      </button>
    {/each}
    {#each search.machine as value (value)}
      <button
        class={pill}
        data-machine-id={value}
        onclick={() => navigation.clearMachine(value)}
        title="Clear Machine filter"
        type="button"
      >
        Machine: {presentMachineLabel(value)} ×
      </button>
    {/each}
    {#each activeFieldFilters(search) as filter (filter.key)}
      <button
        class={pill}
        onclick={() => navigation.clearFieldFilter(filter.key)}
        title={`Clear ${fieldLabels[filter.key]} filter`}
        type="button"
      >
        {fieldLabels[filter.key]}: {filter.value} ×
      </button>
    {/each}
  </div>
  {#if hasActiveDashboardFilters(search)}
    <button class={button} onclick={navigation.clearAllFilters} type="button">Clear all</button>
  {/if}
</div>
