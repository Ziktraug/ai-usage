<script lang="ts">
  import { activeFilters, filterSummary, ghostButton, summaryPill } from '@ai-usage/design-system/svelte/passive';
  import {
    type DashboardSearch,
    dashboardTimeCellLabel,
    hasActiveDashboardFilters,
  } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import type { BreakdownNavigation } from './navigation';
  import { activeFieldFilters, selectedTimeCell } from './navigation';
  import { pill } from './styles';

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
  // A pending response must not restate counts it can no longer vouch for, but dropping them
  // collapsed the row and threw "Clear all" ~300px sideways for the length of the request. Holding
  // each slot at the width it last measured empties the text without moving anything around it.
  //
  // `offsetWidth`, not `clientWidth`: these boxes are border-box, so reserving a border-excluding
  // measurement shrinks the slot by its border on every observation — a slow collapse, not a hold.
  // The reservation is also latched off the settled render, so nothing re-measures under itself.
  let visibleCountWidth = $state(0);
  let hiddenCountWidth = $state(0);
  let reservedWidths = $state({ hidden: 0, visible: 0 });
  $effect(() => {
    if (!pending) {
      reservedWidths = { hidden: hiddenCountWidth, visible: visibleCountWidth };
    }
  });
  const reserved = (width: number): string | undefined => (pending && width > 0 ? `${width}px` : undefined);
  const busyAttributes = $derived(pending ? ({ 'aria-busy': 'true' } as const) : {});
</script>

<div class={filterSummary} data-active-filters data-pending={pending}>
  <span
    {...busyAttributes}
    aria-live="polite"
    class={summaryPill}
    style:min-width={reserved(reservedWidths.visible)}
    bind:offsetWidth={visibleCountWidth}
  >
    {#if !pending}
      {fmtNum(visible)}
      / {fmtNum(total)} sessions
    {/if}
  </span>
  {#if hidden > 0}
    <span {...busyAttributes} style:min-width={reserved(reservedWidths.hidden)} bind:offsetWidth={hiddenCountWidth}>
      {#if !pending}
        {fmtNum(hidden)}
        hidden by filters
      {/if}
    </span>
  {/if}
  <div class={activeFilters}>
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
    <button class={ghostButton} onclick={navigation.clearAllFilters} type="button">Clear all</button>
  {/if}
</div>
