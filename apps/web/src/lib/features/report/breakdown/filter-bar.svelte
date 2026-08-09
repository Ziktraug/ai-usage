<script lang="ts">
  import { MultiSelect, Tooltip } from '@ai-usage/design-system/svelte';
  import type { SessionOrigin } from '@ai-usage/report-core/session-query';
  import type { Snippet } from 'svelte';
  import type { DashboardSearch } from '../../../../dashboard-search';
  import { useSourceControlSummary } from '../../shell/source-control-summary-context';
  import type { BreakdownNavigation } from './navigation';
  import OriginFilter from './origin-filter.svelte';
  import { button, controls, field, toolbar } from './styles';

  let {
    freshnessStatus = null,
    freshnessUnavailable = false,
    harnessOptions,
    inputRef,
    isDemo = false,
    machineAttention = false,
    machineOptions,
    navigation,
    presentMachineLabel,
    search,
    sourceControlSummary = useSourceControlSummary(),
  }: {
    freshnessStatus?: string | null;
    harnessOptions: string[];
    freshnessUnavailable?: boolean;
    machineAttention?: boolean;
    inputRef?: (element: HTMLInputElement) => void;
    isDemo?: boolean;
    machineOptions: string[];
    navigation: BreakdownNavigation;
    presentMachineLabel: (value: string) => string;
    search: DashboardSearch;
    sourceControlSummary?: Snippet;
  } = $props();
  let editingQuery = false;
  const setQuery = (value: string): void => {
    navigation.setQuery(value, editingQuery);
    editingQuery = true;
  };
  const commitQuery = (): void => {
    editingQuery = false;
  };
  const setInputElement = (element: HTMLInputElement): void => {
    inputRef?.(element);
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
    use:setInputElement
  >
  <div class={controls}>
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
    {#if freshnessStatus}
      {#if freshnessUnavailable}
        <Tooltip content="No source freshness observation is available for this report revision.">
          {#snippet trigger(_triggerProps)}
            <button
              {..._triggerProps}
              aria-label="Collection source status"
              aria-live="polite"
              class={button}
              type="button"
            >
              {freshnessStatus}
            </button>
          {/snippet}
        </Tooltip>
      {:else}
        <section aria-label="Collection source status" aria-live="polite" class={button}>
          {freshnessStatus}
        </section>
      {/if}
    {/if}
    {#if !isDemo && sourceControlSummary}
      {@render sourceControlSummary()}
    {/if}
  </div>
</div>
