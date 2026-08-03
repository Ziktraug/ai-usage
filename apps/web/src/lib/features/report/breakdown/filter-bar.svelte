<script lang="ts">
  import { MultiSelect } from '@ai-usage/design-system/svelte';
  import type { SessionOrigin } from '@ai-usage/report-core/session-query';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import type { BreakdownNavigation } from './navigation';
  import OriginFilter from './origin-filter.svelte';
  import { button, field, muted, toolbar } from './styles';

  let {
    freshnessStatus = null,
    harnessOptions,
    machineAttention = false,
    machineOptions,
    navigation,
    presentMachineLabel,
    search,
  }: {
    freshnessStatus?: string | null;
    harnessOptions: string[];
    machineAttention?: boolean;
    machineOptions: string[];
    navigation: BreakdownNavigation;
    presentMachineLabel: (value: string) => string;
    search: DashboardSearch;
  } = $props();

  let editingQuery = false;
  const setQuery = (value: string): void => {
    navigation.setQuery(value, editingQuery);
    editingQuery = true;
  };
  const commitQuery = (): void => {
    editingQuery = false;
  };
  const setRangeMode = (mode: DashboardDateRangeSearch['mode']): void => {
    navigation.setDateRange(mode === 'custom' ? { ...search.range, mode } : { mode });
  };
  const setCustomBound = (key: 'from' | 'to', value: string): void => {
    const range: DashboardDateRangeSearch = { ...search.range, mode: 'custom' };
    if (value) {
      range[key] = value;
    } else {
      delete range[key];
    }
    navigation.setDateRange(range);
  };
</script>

<div class={toolbar} data-dashboard-filter-stack>
  <input
    aria-label="Filter sessions by title, project, model, provider, or harness"
    class={field}
    onblur={commitQuery}
    oninput={(event) => setQuery(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key === 'Enter') {
        commitQuery();
      }
    }}
    placeholder="Filter by title, project, model…  ( / )"
    value={search.q}
  >
  <MultiSelect
    label="Filter by harness"
    noun="harnesses"
    onValueChange={navigation.setHarness}
    options={harnessOptions}
    placeholder="All harnesses"
    value={search.harness}
  />
  <OriginFilter onValueChange={(value: SessionOrigin[]) => navigation.setOrigin(value)} value={search.origin} />
  {#if machineOptions.length > 1 || machineAttention}
    <MultiSelect
      label="Filter by machine"
      noun="machines"
      onValueChange={navigation.setMachine}
      optionLabel={presentMachineLabel}
      options={machineOptions}
      placeholder="All machines"
      value={search.machine}
    />
  {/if}
  <label>
    <span class={muted}>Date range</span>
    <select
      class={field}
      onchange={(event) => setRangeMode(event.currentTarget.value as DashboardDateRangeSearch['mode'])}
      value={search.range.mode}
    >
      <option value="today">Today</option>
      <option value="7d">7 days</option>
      <option value="30d">30 days</option>
      <option value="all">All time</option>
      <option value="custom">Custom</option>
    </select>
  </label>
  {#if search.range.mode === 'custom'}
    <label
      ><span class={muted}>From</span>
      <input
        class={field}
        onchange={(event) => setCustomBound('from', event.currentTarget.value)}
        type="date"
        value={search.range.from ?? ''}
      ></label
    >
    <label
      ><span class={muted}>To</span>
      <input
        class={field}
        onchange={(event) => setCustomBound('to', event.currentTarget.value)}
        type="date"
        value={search.range.to ?? ''}
      ></label
    >
  {/if}
  <label>
    <span class={muted}>Columns</span>
    <select
      class={field}
      onchange={(event) => navigation.setColumnBase(event.currentTarget.value as DashboardSearch['colsBase'])}
      value={search.colsBase}
    >
      <option value="auto">Automatic</option>
      <option value="work">Work</option>
      <option value="tokens">Tokens</option>
      <option value="reliability">Reliability</option>
    </select>
  </label>
  {#if freshnessStatus}
    <span aria-live="polite" class={button}>{freshnessStatus}</span>
  {/if}
</div>
