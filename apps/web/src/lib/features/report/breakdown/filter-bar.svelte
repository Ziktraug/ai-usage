<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte serializes the controlled disclosure boolean; browser regressions assert its behavior. -->
<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { Tooltip } from '@ai-usage/design-system/svelte';
  import type { SessionOrigin } from '@ai-usage/report-core/session-query';
  import type { Snippet } from 'svelte';
  import type { DashboardSearch } from '../../../../dashboard-search';
  import { useSourceControlSummary } from '../../shell/source-control-summary-context';
  import CheckboxFilter from './checkbox-filter.svelte';
  import { shouldFocusReportFilter } from './filter-shortcut';
  import type { BreakdownNavigation } from './navigation';
  import OriginFilter from './origin-filter.svelte';
  import { actions, button, controls, field, toolbar } from './styles';

  let {
    freshnessStatus = null,
    freshnessUnavailable = false,
    harnessOptions,
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
    isDemo?: boolean;
    machineOptions: string[];
    navigation: BreakdownNavigation;
    presentMachineLabel: (value: string) => string;
    search: DashboardSearch;
    sourceControlSummary?: Snippet;
  } = $props();
  let editingQuery = false;
  let queryInput = $state<HTMLInputElement | undefined>();
  let filtersOpen = $state(false);
  const activeDimensions = $derived(
    [search.harness, search.origin, search.machine].filter((values) => values.length > 0).length,
  );
  const mobileFilterToggle = css({
    display: { base: 'inline-flex', sm: 'none' },
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    minH: '44px',
    px: '12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    fontSize: '12px',
    fontWeight: 600,
    '&[aria-expanded=true]': { bg: 'accentSoft', borderColor: 'accent' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const setQuery = (value: string): void => {
    navigation.setQuery(value, editingQuery);
    editingQuery = true;
  };
  const commitQuery = (): void => {
    editingQuery = false;
  };
  const focusSearch = (event: KeyboardEvent): void => {
    const target = event.target;
    const editableTarget =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.matches('input, textarea, select') ||
        target.closest('[contenteditable="true"]') !== null);
    if (
      !shouldFocusReportFilter({
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        defaultPrevented: event.defaultPrevented,
        editableTarget,
        isComposing: event.isComposing,
        key: event.key,
        metaKey: event.metaKey,
      })
    ) {
      return;
    }
    event.preventDefault();
    queryInput?.focus();
  };
</script>

<!-- biome-ignore lint/a11y/noStaticElementInteractions: This route-scoped listener implements the documented global slash shortcut. -->
<svelte:window onkeydown={focusSearch} />

<div class={toolbar} data-dashboard-filter-stack>
  <input
    aria-keyshortcuts="/"
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
    bind:this={queryInput}
  >
  <button
    aria-controls="report-dimension-filters"
    aria-expanded={filtersOpen}
    class={mobileFilterToggle}
    onclick={() => { filtersOpen = !filtersOpen; }}
    type="button"
  >
    Filters{activeDimensions > 0 ? ` · ${activeDimensions}` : ''}
    <span aria-hidden="true">{filtersOpen ? '−' : '+'}</span>
  </button>
  <div class={controls} data-expanded={filtersOpen} id="report-dimension-filters">
    <CheckboxFilter
      label="Filter by harness"
      noun="harnesses"
      onValueChange={navigation.setHarness}
      options={harnessOptions}
      placeholder="All harnesses"
      title="Harness"
      value={search.harness}
    />
    <OriginFilter onValueChange={(value: SessionOrigin[]) => navigation.setOrigin(value)} value={search.origin} />
    {#if machineOptions.length > 1 || machineAttention}
      <CheckboxFilter
        label="Filter by machine"
        noun="machines"
        onValueChange={navigation.setMachine}
        optionLabel={presentMachineLabel}
        options={machineOptions}
        placeholder="All machines"
        title="Machine"
        value={search.machine}
      />
    {/if}
    {#if freshnessStatus || (!isDemo && sourceControlSummary)}
      <div class={actions} data-filter-actions>
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
    {/if}
  </div>
</div>
