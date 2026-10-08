<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { activeFilters, filterSummary, ghostButton, summaryPill } from '@ai-usage/design-system/svelte';
  import { sessionOriginLabel } from '@ai-usage/report-core/session-query';
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
  // A pending response keeps the previous counts on screen, dimmed and busy, like the report output
  // it sits above. Emptying them made the row blink on every keystroke of the query field. The delay
  // applies on the way in only, so requests shorter than it never flash.
  const settledCount = css({ transition: 'opacity 120ms ease' });
  const staleCount = css({ opacity: 0.5, transitionDelay: '180ms' });
  const busyAttributes = $derived(pending ? ({ 'aria-busy': 'true' } as const) : {});
</script>

<div class={filterSummary} data-active-filters data-pending={pending}>
  <span {...busyAttributes} aria-live="polite" class={cx(summaryPill, settledCount, pending && staleCount)}>
    {fmtNum(visible)}
    / {fmtNum(total)} sessions
  </span>
  {#if hidden > 0}
    <span {...busyAttributes} class={cx(settledCount, pending && staleCount)}>
      {fmtNum(hidden)}
      hidden by filters
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
    {#if search.origin.length > 0}
      <button class={pill} onclick={navigation.clearOrigin} title="Clear Origin filter" type="button">
        Origin: {search.origin.map(sessionOriginLabel).join(' + ')} ×
      </button>
    {/if}
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
